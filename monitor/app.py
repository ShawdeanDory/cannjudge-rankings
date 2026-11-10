#!/usr/bin/env python3
"""CANNJudge 实时排名监视器（本地只读看板）。

后台线程定时抓取 CANNJudge 公开接口，本地 HTTP 服务向前端提供快照：
  - /api/submissions/contest/<id>/stats        -> 队伍总排名
  - /api/problems/<id>/ranking?page&size=100   -> 单题排名（分页合并）

只在 127.0.0.1 监听，不需要登录凭据。
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import os
import re
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import requests

APP_ID = "cannjudge-rank-monitor"
APP_VERSION = "1.0.0"
BASE_URL = "https://cannjudge.cn"
CONTEST_ID = "6a9e2d04bf41025d60f21804"
CONTEST_URL = "https://cannjudge.cn/public/ictcompetition"
TICK_SECONDS = 8.0
PROBLEMS_PER_TICK = 2
PAGE_SIZE = 100
REQUEST_TIMEOUT = (8, 25)
USER_AGENT = "CANNJudgeRankMonitor/1.0 (local dashboard)"

if getattr(sys, "frozen", False):
    DOCS_ROOT = Path(sys._MEIPASS) / "docs"
else:
    DOCS_ROOT = Path(__file__).resolve().parent.parent / "docs"

log = logging.getLogger("cannjudge-monitor")


def now_ts() -> float:
    return time.time()


def setup_logging(verbose: bool) -> None:
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "CANNJudgeRankMonitor"
    try:
        base.mkdir(parents=True, exist_ok=True)
        handlers: list[logging.Handler] = [
            logging.FileHandler(base / "monitor.log", encoding="utf-8")
        ]
    except OSError:
        handlers = []
    if verbose or not handlers:
        handlers.append(logging.StreamHandler(sys.stderr))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
        force=True,
    )


def api_get(path: str, params: dict | None = None):
    """GET CANNJudge JSON，带三次重试。"""
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            resp = requests.get(
                BASE_URL + path,
                params=params,
                timeout=REQUEST_TIMEOUT,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"请求失败：{type(last_error).__name__}")


def jina_get(path: str, params: dict | None = None):
    """经 r.jina.ai 只读代理获取公开 JSON（仅当直连失败时使用）。

    GitHub Actions 的境外 runner 访问国内的 cannjudge.cn 偶尔会超时；
    该代理只读取公开榜单，不携带任何凭据。
    """
    url = BASE_URL + path
    if params:
        url += "?" + urlencode(params)
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            resp = requests.get(
                "https://r.jina.ai/" + url,
                timeout=(15, 90),
                headers={"User-Agent": USER_AGENT, "Accept": "text/plain"},
            )
            resp.raise_for_status()
            text = re.sub(r"```(?:json)?", "", resp.text)
            starts = [index for index in (text.find("["), text.find("{")) if index >= 0]
            if not starts:
                raise ValueError("代理响应中没有 JSON")
            return json.loads(text[min(starts):])
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"代理请求失败：{type(last_error).__name__}")


def to_float(value) -> float:
    try:
        number = float(value)
        return number if number == number else 0.0  # 排除 NaN
    except (TypeError, ValueError):
        return 0.0


def to_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return 0


class Monitor:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.force_all = False
        self.contest = {
            "title": "第十一届华为ICT大赛｜昇腾AI算子开发赛道（决赛）",
            "name": "ictcompetition",
            "url": CONTEST_URL,
        }
        self.problems: list[dict] = []
        self.total_rows: list[dict] = []
        self.total_at: float | None = None
        self.total_error: str | None = None
        self.problem_data: dict[str, dict] = {}
        self.version = 1
        self.generated_at = now_ts()
        self.ready = False
        self._hashes: dict[str, str] = {}
        self._problem_cursor = 0
        self.via_jina = False

    def _api(self, path: str, params: dict | None = None):
        """优先直连；直连失败后本轮统一改走只读代理。"""
        if self.via_jina:
            return jina_get(path, params)
        try:
            return api_get(path, params)
        except Exception as exc:
            self.via_jina = True
            log.warning("直连 CANNJudge 失败（%s），改用 r.jina.ai 只读代理", exc)
            return jina_get(path, params)

    # ---------- 抓取 ----------
    def load_contest(self) -> None:
        try:
            contest = self._api(f"/api/contests/{CONTEST_ID}")
            title = str(contest.get("title") or "").strip()
            if title:
                with self.lock:
                    self.contest["title"] = title
                    self.version += 1
        except Exception as exc:  # 保留兜底标题，不阻塞
            log.warning("读取赛事信息失败：%s", exc)

    def load_problems(self) -> bool:
        try:
            problems = self._api(f"/api/problems/contest/{CONTEST_ID}")
        except Exception as exc:
            log.warning("读取题目列表失败：%s", exc)
            return False
        if not isinstance(problems, list) or not problems:
            return False
        cleaned = []
        for problem in problems:
            pid = str(problem.get("_id") or "").strip()
            if not pid:
                continue
            cleaned.append(
                {
                    "id": pid,
                    "name": str(problem.get("name") or ""),
                    "title": str(problem.get("title") or problem.get("name") or pid),
                }
            )
        if not cleaned:
            return False
        with self.lock:
            if cleaned != self.problems:
                self.problems = cleaned
                self.version += 1
                self.generated_at = now_ts()
        log.info("题目列表：%s 道", len(cleaned))
        return True

    def _publish_total(self, rows: list[dict]) -> None:
        digest = hashlib.sha1(
            json.dumps(rows, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        with self.lock:
            self.total_error = None
            if digest == self._hashes.get("total"):
                return
            self._hashes["total"] = digest
            self.total_rows = rows
            self.total_at = now_ts()
            self.version += 1
            self.generated_at = self.total_at
        log.info("总榜更新：%s 支队伍", len(rows))

    def refresh_total(self) -> None:
        try:
            stats = self._api(f"/api/submissions/contest/{CONTEST_ID}/stats")
            rows = self._normalize_total(stats)
            if not rows:
                raise RuntimeError("总榜为空")
            self._publish_total(rows)
        except Exception as exc:
            with self.lock:
                self.total_error = str(exc)[:160]
            log.warning("刷新总榜失败：%s", exc)

    @staticmethod
    def _normalize_total(stats) -> list[dict]:
        if not isinstance(stats, list):
            return []
        rows: list[dict] = []
        for item in stats:
            if not isinstance(item, dict):
                continue
            team = item.get("team") or {}
            team_name = str(
                team.get("team_name") or team.get("name") or team.get("team_id") or ""
            ).strip()
            if not team_name:
                continue
            rows.append(
                {
                    "team": team_name,
                    "score": round(to_float(item.get("score")), 2),
                    "pass": to_int(item.get("passCount")),
                    "attempt": to_int(item.get("attemptCount")),
                    "subs": to_int(item.get("submissionCount")),
                }
            )
        rows.sort(key=lambda row: (-row["score"], -row["pass"], row["subs"], row["team"]))
        for index, row in enumerate(rows):
            row["rank"] = index + 1
        return rows

    def refresh_problem(self, problem: dict) -> None:
        pid = problem["id"]
        try:
            first = self._api(
                f"/api/problems/{pid}/ranking",
                {"contestId": CONTEST_ID, "page": 1, "size": PAGE_SIZE},
            )
            pages = max(1, min(to_int(first.get("pages")) or 1, 30))
            raw_rows = list(first.get("rows") or [])
            for page in range(2, pages + 1):
                chunk = self._api(
                    f"/api/problems/{pid}/ranking",
                    {"contestId": CONTEST_ID, "page": page, "size": PAGE_SIZE},
                )
                raw_rows.extend(chunk.get("rows") or [])
            rows = self._normalize_problem_rows(raw_rows)
            digest = hashlib.sha1(
                json.dumps(rows, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()
            expected = to_int(first.get("total"))
            with self.lock:
                current = self.problem_data.get(pid)
                if digest == self._hashes.get(pid):
                    if current:
                        current["error"] = None
                    return
                self._hashes[pid] = digest
                self.problem_data[pid] = {
                    "rows": rows,
                    "at": now_ts(),
                    "error": None,
                    "total": expected or len(rows),
                    "complete": expected <= len(rows) if expected else True,
                }
                self.version += 1
                self.generated_at = now_ts()
            log.info("题目 %s 更新：%s 行", problem.get("title") or pid, len(rows))
        except Exception as exc:
            with self.lock:
                entry = self.problem_data.setdefault(
                    pid, {"rows": [], "at": None, "total": 0, "complete": False}
                )
                entry["error"] = str(exc)[:160]
            log.warning("刷新题目 %s 失败：%s", problem.get("title") or pid, exc)

    @staticmethod
    def _normalize_problem_rows(raw_rows) -> list[dict]:
        rows: list[dict] = []
        for index, item in enumerate(raw_rows):
            if not isinstance(item, dict):
                continue
            team = item.get("team") or {}
            submitter = item.get("submitter") or item.get("user") or {}
            team_name = str(
                team.get("team_name") or team.get("name") or team.get("team_id") or ""
            ).strip()
            user_name = str(submitter.get("nickname") or submitter.get("name") or "").strip()
            if not team_name:
                team_name = user_name or "未知队伍"
            submission = item.get("submission") or {}
            rows.append(
                {
                    "rank": to_int(item.get("rank")) or index + 1,
                    "team": team_name,
                    "user": user_name,
                    "score": round(to_float(item.get("score")), 2),
                    "status": str(item.get("status") or submission.get("status") or ""),
                    "time": str(
                        item.get("create_time") or submission.get("create_time") or ""
                    ),
                    "sid": str(item.get("submission_id") or submission.get("_id") or ""),
                }
            )
        rows.sort(key=lambda row: (row["rank"], row["team"]))
        return rows

    # ---------- 后台循环 ----------
    def bootstrap(self, max_wait: float = 180.0) -> None:
        self.load_contest()
        deadline = time.monotonic() + max_wait
        while (
            not self.stop_event.is_set()
            and not self.load_problems()
            and time.monotonic() < deadline
        ):
            self.stop_event.wait(3)
        if not self.problems:
            log.warning("题目列表加载超时")
            return
        with ThreadPoolExecutor(max_workers=6) as pool:
            pool.submit(self.refresh_total)
            for problem in list(self.problems):
                pool.submit(self.refresh_problem, problem)
        with self.lock:
            self.ready = True
            self.version += 1
            self.generated_at = now_ts()
        log.info("首轮数据加载完成")

    def refresh_all_problems(self) -> None:
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(self.refresh_problem, list(self.problems)))

    def run(self) -> None:
        self.bootstrap()
        while not self.stop_event.is_set():
            try:
                if not self.problems:
                    self.load_problems()
                if self.force_all:
                    self.force_all = False
                    self.refresh_total()
                    self.refresh_all_problems()
                else:
                    self.refresh_total()
                    for _ in range(PROBLEMS_PER_TICK):
                        if not self.problems:
                            break
                        problem = self.problems[self._problem_cursor % len(self.problems)]
                        self._problem_cursor += 1
                        self.refresh_problem(problem)
            except Exception:
                log.exception("后台刷新异常")
            self.wake_event.wait(TICK_SECONDS)
            self.wake_event.clear()

    def request_refresh(self) -> None:
        self.force_all = True
        self.wake_event.set()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()

    # ---------- 快照 ----------
    def snapshot(self) -> dict:
        with self.lock:
            return {
                "app": APP_ID,
                "app_version": APP_VERSION,
                "version": self.version,
                "ready": self.ready,
                "server_time": now_ts(),
                "generated_at": self.generated_at,
                "contest": dict(self.contest),
                "problems": list(self.problems),
                "total": {
                    "rows": self.total_rows,
                    "at": self.total_at,
                    "error": self.total_error,
                },
                "by_problem": {
                    pid: {
                        "rows": entry.get("rows", []),
                        "at": entry.get("at"),
                        "error": entry.get("error"),
                        "total": entry.get("total", 0),
                        "complete": entry.get("complete", False),
                    }
                    for pid, entry in self.problem_data.items()
                },
            }


MONITOR = Monitor()


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"CANNJudgeMonitor/{APP_VERSION}"

    def log_message(self, fmt: str, *args) -> None:  # 静默常规访问日志
        return

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path in ("/", "/index.html"):
                self._send_file(DOCS_ROOT / "index.html", "text/html; charset=utf-8")
            elif path in ("/style.css", "/app.js", "/config.js", "/snapshot-client.js", "/favicon.svg", "/favicon.ico"):
                name = "favicon.svg" if path.startswith("/favicon") else path.lstrip("/")
                self._send_file(DOCS_ROOT / name, None)
            elif path == "/data/snapshot.json":
                self._send_file(DOCS_ROOT / "data" / "snapshot.json", "application/json; charset=utf-8")
            elif path.startswith("/static/"):
                # 兼容旧书签：static/xxx 一律映射到 docs/xxx
                name = path[len("/static/"):]
                if "/" in name or "\\" in name or name.startswith("."):
                    self._send_json({"error": "not found"}, status=404)
                    return
                self._send_file(DOCS_ROOT / name, None)
            elif path == "/api/ping":
                self._send_json(
                    {
                        "app": APP_ID,
                        "version": APP_VERSION,
                        "data_version": MONITOR.version,
                        "ready": MONITOR.ready,
                    }
                )
            elif path == "/api/snapshot":
                query = parse_qs(parsed.query)
                since = query.get("version", [None])[0]
                current = MONITOR.version
                if since is not None and since.isdigit() and int(since) == current:
                    self._send_json(
                        {
                            "unchanged": True,
                            "version": current,
                            "generated_at": MONITOR.generated_at,
                            "server_time": now_ts(),
                        }
                    )
                else:
                    self._send_json(MONITOR.snapshot())
            elif path == "/api/refresh":
                MONITOR.request_refresh()
                self._send_json({"ok": True})
            elif path == "/api/shutdown":
                if self.client_address[0] not in ("127.0.0.1", "::1"):
                    self._send_json({"error": "forbidden"}, status=403)
                    return
                self._send_json({"ok": True})
                threading.Timer(0.25, lambda: os._exit(0)).start()
            else:
                self._send_json({"error": "not found"}, status=404)
        except BrokenPipeError:
            pass
        except Exception:
            log.exception("处理请求失败：%s", path)
            self._send_json({"error": "internal error"}, status=500)

    def _send_file(self, path: Path, content_type: str | None) -> None:
        try:
            data = path.read_bytes()
        except OSError:
            self._send_json({"error": "not found"}, status=404)
            return
        if content_type is None:
            content_type = {
                ".css": "text/css; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".ico": "image/x-icon",
                ".json": "application/json; charset=utf-8",
            }.get(path.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        encoding = None
        if len(body) > 1200 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, compresslevel=5)
            encoding = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass


def existing_instance(port: int) -> bool:
    try:
        resp = requests.get(f"http://127.0.0.1:{port}/api/ping", timeout=0.8)
        return resp.ok and resp.json().get("app") == APP_ID
    except (requests.RequestException, ValueError):
        return False


def show_fatal(message: str) -> None:
    log.error(message)
    if sys.platform == "win32" and getattr(sys, "frozen", False):
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(
                0, message, "CANNJudge 实时排名监视器", 0x10
            )
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="CANNJudge 实时排名监视器")
    parser.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--verbose", action="store_true", help="日志同时输出到终端")
    args = parser.parse_args()

    setup_logging(args.verbose)
    log.info("启动 CANNJudge 排名监视器 v%s", APP_VERSION)

    if existing_instance(args.port):
        url = f"http://127.0.0.1:{args.port}/"
        log.info("检测到已运行的实例：%s", url)
        if not args.no_browser:
            webbrowser.open(url)
        return 0

    server = None
    port = args.port
    for candidate in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            server.daemon_threads = True
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        show_fatal("无法启动本地服务：端口被占用。请关闭占用端口的程序后重试。")
        return 1

    url = f"http://127.0.0.1:{port}/"
    log.info("本地服务已启动：%s", url)

    worker = threading.Thread(target=MONITOR.run, name="monitor", daemon=True)
    worker.start()

    if not args.no_browser:
        threading.Timer(0.9, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        MONITOR.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

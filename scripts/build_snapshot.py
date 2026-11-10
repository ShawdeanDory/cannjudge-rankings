#!/usr/bin/env python3
"""生成 GitHub Pages 用的静态榜单快照。

复用本地监视器的抓取逻辑，把总榜 + 每道题的完整排名写成
``data/snapshot.json``，供纯静态页面读取。GitHub Actions 定时运行。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from monitor.app import Monitor  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 CANNJudge 静态榜单快照")
    parser.add_argument("--out", default=str(ROOT / "docs" / "data" / "snapshot.json"))
    parser.add_argument("--min-teams", type=int, default=1)
    args = parser.parse_args()

    started = time.time()
    monitor = Monitor()
    monitor.bootstrap()

    snapshot = monitor.snapshot()
    snapshot["mode"] = "static"
    snapshot["version"] = int(time.time())
    snapshot["generated_at"] = time.time()
    snapshot["ready"] = True

    total_rows = snapshot.get("total", {}).get("rows", [])
    problems = snapshot.get("problems", [])
    by_problem = snapshot.get("by_problem", {})

    errors = []
    if len(total_rows) < args.min_teams:
        errors.append(f"总榜队伍数不足：{len(total_rows)} < {args.min_teams}")
    if len(problems) < 1:
        errors.append("没有取到题目列表")
    empty_problems = [p["title"] for p in problems if not by_problem.get(p["id"], {}).get("rows")]
    incomplete = [p["title"] for p in problems if not by_problem.get(p["id"], {}).get("complete") or by_problem.get(p["id"], {}).get("error")]
    if incomplete:
        errors.append("题榜抓取不完整：" + "、".join(incomplete))
    if empty_problems:
        errors.append("以下题目没有排名数据：" + "、".join(empty_problems))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    elapsed = time.time() - started
    print(
        f"snapshot written: {out} ({out.stat().st_size / 1024:.1f} KiB) "
        f"| teams={len(total_rows)} problems={len(problems)} elapsed={elapsed:.1f}s"
    )
    for pid, entry in by_problem.items():
        print(f"  - {pid}: {len(entry.get('rows', []))} rows")

    if errors:
        for error in errors:
            print("WARN " + error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

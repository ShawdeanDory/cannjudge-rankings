# CANNJudge 排名看板（GitHub Pages）

监视第十一届华为ICT大赛昇腾AI算子开发赛道决赛（`public/ictcompetition`）的公开排名：

- 顶部显示「我的队伍」总排名、总分、通过题数、提交次数；滚动时顶部保留一条速览；
- 总排行榜列出全部 593 支队伍，我的队伍整行高亮；
- 每道题一个独立区域（10 道题），显示完整排名、我的排名、得分、状态与提交时间；
- 右上角可切换队伍，默认 `d0uB4o`，选择记忆在浏览器里。

## 为什么需要 GitHub Actions

GitHub Pages 只能托管静态文件，而 `cannjudge.cn` 的公开接口没有返回 CORS 头，浏览器没法从 Pages 直接请求。因此采用：

```
GitHub Actions（每 5 分钟）
  └─ scripts/build_snapshot.py 抓取总榜 + 10 道题完整排名
       └─ 生成 _site/data/snapshot.json，随静态站点一起发布到 Pages
            └─ 页面每 60 秒带 If-None-Match 校验快照，变化才重新渲染
```

代价是数据不是秒级：Actions 计划任务最短 5 分钟，实际常有数分钟延迟。页面顶部会显示快照时间，超过 15 分钟会变黄提示。

如果 Actions 的境外 runner 直连 `cannjudge.cn` 超时，抓取脚本会自动改用 `r.jina.ai` 只读代理获取同样的公开 JSON，不需要额外配置。

## 部署步骤

1. 新建一个 **public** 仓库（私有仓库启用 Pages 需要 GitHub Pro 等付费方案）。
2. 把本目录整体推送到默认分支 `main`。至少需要：

   ```
   docs/
   monitor/app.py
   scripts/build_snapshot.py
   .github/workflows/rankings-pages.yml
   ```

3. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
4. 打开 **Actions → Rankings snapshot & Pages → Run workflow** 跑一次。
5. 完成后访问 `https://<用户名>.github.io/<仓库名>/`。

工作流每次运行会重新抓取数据并发布新版本；`docs/` 或脚本更新时也会自动触发。

## 页面行为

- 打开后先请求 `/api/ping`：本地运行时进入「本地实时」模式；Pages 上 404 则自动进入「GitHub Pages 快照」模式。
- 快照模式下每 60 秒校验一次 `data/snapshot.json`，未变化时只收到 304，不会反复下载 500 KiB。
- 搜索框按 `/` 聚焦；点击顶部题目卡片会跳到对应题目区域。
- 「即时刷新」会重新校验快照；「暂停刷新」停止轮询。

## 本地预览（不部署也能看）

```powershell
python -m pip install requests
python scripts/build_snapshot.py --out docs/data/snapshot.json
python -m http.server 8877 --directory docs
# 打开 http://127.0.0.1:8877/
```

页面会自动识别为快照模式。

## 数据口径

- 总榜：`/api/submissions/contest/6a9e2d04bf41025d60f21804/stats`，按总分降序、通过题数降序、提交次数升序，与站内一致。
- 单题榜：`/api/problems/<题目ID>/ranking?page=N&size=100`，分页合并后按接口返回的 `rank` 排序。
- 单题榜展示平台该题排行榜当前条目（最新提交状态 + 该题得分），可能出现「总榜 10 题通过，但某题最新提交超时、单题排名靠后」，这是平台口径。
- 只读取公开数据，不登录、不携带 Cookie。

## 真·实时（可选）

若必须秒级，需要给 Pages 配一个带 CORS 的反向代理（例如免费的 Cloudflare Worker）转发 `/api/*` 到 `https://cannjudge.cn`。项目里的 `monitor/app.py` 已实现同样的抓取逻辑，可直接本地运行：

```powershell
python monitor/app.py   # http://127.0.0.1:8765/
```

页面会自动进入「本地实时」模式，总榜约 8 秒刷新、每题约 40 秒刷新。

## 文件结构

```
docs/                          # Pages 静态站点
  index.html
  style.css
  app.js                       # 自动识别本地 API / Pages 快照
  favicon.svg
monitor/app.py                 # 抓取与本地 HTTP 服务（Actions 复用其抓取逻辑）
scripts/build_snapshot.py      # 生成 data/snapshot.json
.github/workflows/rankings-pages.yml
```

## 常见问题

- **页面一直显示「等待 GitHub Actions 生成首个快照」**：Actions 还没跑成功；去 Actions 页面看日志。
- **数据时间很旧**：Actions 计划任务延迟或被停用（仓库 60 天无提交会停用计划任务），手动 Run workflow。
- **Pages 404**：确认 Source 选的是 GitHub Actions，而不是从分支部署。
- **私有仓库**：Pages 不可用或需要付费方案，建议新建 public 仓库专放看板。

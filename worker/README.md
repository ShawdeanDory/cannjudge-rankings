# Cloudflare Worker

Worker 转发赛事公开榜单接口，按接口和分页分别缓存 60 秒。浏览器负责合并分页。定时采样由 GitHub Actions 抓取，经 `/record` 写入 SQLite Durable Object，保存最近 26 小时的得分快照和最后一份完整榜单。

## 部署

1. 使用 Node.js 24，在 `worker/` 运行 `npm ci` 和 `npm test`，然后使用 `npx wrangler login` 登录管理现有 Worker 的 Cloudflare 账户。
2. 在仓库目录以外准备临时环境变量文件，填入随机生成的 `COLLECTOR_SECRET`，值与 GitHub Actions 仓库的同名 secret 一致。用 `npx wrangler deploy --secrets-file <文件路径>` 部署，并删除临时文件。
3. 核对 `docs/config.js` 中的 Worker 地址和 `.github/workflows/rankings-pages.yml` 中的采样上传地址。如果 Pages 使用不同域名，在 `wrangler.jsonc` 的 `vars` 中设置 `DASHBOARD_ORIGIN`（仅协议和主机）。
4. 完成 [Pages 部署](../README-排名看板.md#在线部署)。

页面口令在前端验证。`COLLECTOR_SECRET` 只用于授权写入历史，榜单、历史和备用快照可公开读取。

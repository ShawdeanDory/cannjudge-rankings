# Cloudflare Worker

Worker 在验证会话后转发赛事公开榜单接口，仍按接口和分页分别缓存 60 秒。浏览器负责合并分页。定时采样由 GitHub Actions 抓取，经 `/record` 写入 SQLite Durable Object，保存最近 26 小时的得分快照和最后一份完整榜单。

## 部署

1. 使用 Node.js 24，在 `worker/` 运行 `npm ci` 和 `npm test`，然后使用 `npx wrangler login` 登录管理现有 Worker 的 Cloudflare 账户。
2. 在仓库目录以外准备一个临时的环境变量文件，填入以下三个值。用 `npx wrangler deploy --secrets-file <文件路径>` 部署，并删除临时文件。

   | Secret | 值 |
   | --- | --- |
   | `DASHBOARD_PASSWORD` | 队伍共享的访问密码 |
   | `SESSION_SECRET` | 独立随机值，至少 32 个字符 |
   | `COLLECTOR_SECRET` | 另一独立随机值，与 GitHub Actions 仓库同名 secret 一致 |

3. 核对 `docs/config.js` 中的 Worker 地址和 `.github/workflows/rankings-pages.yml` 中的采样上传地址。如果 Pages 使用不同域名，在 `wrangler.jsonc` 的 `vars` 中设置 `DASHBOARD_ORIGIN`（仅协议和主机）。
4. 完成 [Pages 部署](../README-排名看板.md#在线部署)。

登录会话有效期为 24 小时，修改密码或 `SESSION_SECRET` 会令已有会话失效。登录按 IP 和全站总次数限流。页面退出登录会清除该标签页的会话。

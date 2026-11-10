# Cloudflare自动更新

Worker在`/api/snapshot`读取CANNJudge公开总榜及全部题榜分页，返回页面已有的快照格式。完整结果在Cloudflare边缘缓存60秒，浏览器每60秒检查一次。页面关闭时无需持续抓取，下次打开会按缓存情况获取数据。上游抓取失败时页面显示Pages备用快照及其真实时间。

## 部署

在此目录运行`npm ci`，然后运行`npx wrangler login --device --scopes account:read user:read workers:write workers_scripts:write workers_routes:write`并在浏览器完成授权。凭据由Wrangler保存在项目之外。

运行`npm test`和`npx wrangler deploy --dry-run`。验证通过后运行`npm run deploy`。将部署返回的HTTPS地址写入`docs/config.js`的`window.CANNJUDGE_WORKER_URL`，例如`https://cannjudge-rankings-proxy.<账户子域>.workers.dev`。

提交并推送页面配置会触发Pages发布。发布后打开页面，模式应显示“Cloudflare自动更新”。保持页面打开，确认下一轮请求的`generated_at`发生变化。访问`/api/snapshot`应返回总榜和全部题榜，`Access-Control-Allow-Origin`应为`https://shawdeandory.github.io`。

Worker只接受固定快照路径的GET及OPTIONS请求，数据请求固定发往CANNJudge。返回字段仅包含公开榜单展示字段。GitHub登录凭据和CANNJudge会话均不需要上传到Worker。

## 验证记录

2026年11月10日本地通过3项自动检查，覆盖分页合并、不完整分页拒绝更新、请求路径与方法及来源限制。真实CANNJudge接口验证取得595支队伍及10道题的完整榜单。Wrangler打包验证通过。Worker已部署，版本ID为`9481dcda-ee87-46b0-8ce5-99c352660b55`。公开地址为`https://cannjudge-rankings-proxy.cannjudge-rankings-proxy.workers.dev`。

线上验证已完成。Pages提交`5584d25`发布成功，页面显示“Cloudflare自动更新”。保持页面打开且不进行手动刷新，更新时间从2026年11月10日11:51:08自动推进至11:52:24，595支队伍和10道题均完整。

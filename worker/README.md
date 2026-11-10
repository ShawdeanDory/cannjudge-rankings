# Cloudflare自动更新

Worker按公开接口和榜单分页转发响应，边缘缓存60秒。浏览器每60秒发起更新，合并与排序在浏览器完成。仅允许本赛事总榜、题目列表、赛事信息和10道题的排名接口。页面从后台恢复时立即检查更新，正在进行的请求自动避免重叠。

## 部署与验证

在此目录运行`npm ci`，再运行`npx wrangler login --device --scopes account:read user:read workers:write workers_scripts:write workers_routes:write`并完成设备授权。运行`npm test`通过后，使用`npm run deploy`部署。公开地址写入`docs/config.js`，随后提交并推送以触发Pages发布。

2026年11月10日修复记录。原聚合Worker在持续访问中返回Cloudflare1102资源超限错误，页面因此使用11:50的备用快照。修复版将完整榜单的JSON处理移到`docs/snapshot-client.js`，Worker每次仅流式转发一页数据。边缘缓存按接口及分页分别保存，浏览器每轮重新检查所有榜单。

本地自动验证覆盖分页合并、不完整分页拒绝更新、接口路径及方法和来源限制。

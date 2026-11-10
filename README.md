# CANNJudge排名看板

[打开在线排名看板](https://shawdeandory.github.io/cannjudge-rankings/)

GitHub Actions每5分钟计划抓取公开榜单，页面每60秒检查快照。实际更新时间受Actions调度影响。

[部署与使用说明](README-排名看板.md)

## Cloudflare自动更新

[Worker部署说明](worker/README.md)提供每分钟直接获取公开榜单的方案。配置`docs/config.js`中的Worker地址后启用，连接失败时回退到Pages快照。

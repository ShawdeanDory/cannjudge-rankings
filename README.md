# CANNJudge排名看板

[打开在线排名看板](https://shawdeandory.github.io/cannjudge-rankings/)

页面每60秒通过Cloudflare Worker读取公开榜单，Worker边缘缓存60秒。连接失败时显示GitHub Actions生成的Pages备用快照，并标明实际数据时间。

[部署与使用说明](README-排名看板.md)

## Cloudflare自动更新

[Worker部署说明](worker/README.md)提供每分钟直接获取公开榜单的方案。配置`docs/config.js`中的Worker地址后启用，连接失败时回退到Pages快照。

# 管理端单入口监控设计

用户已确认：Grafana 作为内部组件保留，管理端同源展示，无独立浏览器入口和发布端口。

## 访问与授权

- 固定入口 `/admin/`，固定 Grafana 子路径 `/api/admin/grafana/`；不接受前端选择上游或 PromQL。
- 删除 UI 独立打开按钮及 `https://localhost:9443` 回退；业务与预发均使用同源子路径。
- API 每次复核 Better Auth、active 状态和平台监控权限，维持只读 Viewer、固定查询、正文/并发/超时限制。
- 业务保留现有机器 Bearer 桥接。预发 API 使用内部 session 桥接：请求仅转发 Cookie 到未发布的网关内部监听，网关再次 forward_auth 后注入 Viewer，并剥离 Cookie/Authorization 后交给 Grafana。不新增或复用其他用途的 Secret。
- 内部 session 桥接只允许固定内部地址 `http://bairui-preprod-gateway:9494`，不能由浏览器配置。关闭匿名、独立登录与 Live。

## 部署

- 移除预发网关 9443 监听、宿主映射和应急登录路由。9494 为容器内部监听，不发布宿主端口。
- 保留现有数据卷、Secret、安装身份、精确代理信任及停止/恢复行为。
- 公网域名通过显式 HTTPS public origin 配置；保留本机默认 origin。云端只发布管理端所在的 HTTPS 端口，禁止客户端跟随 localhost 回退。
- 开发不启动业务/预发常驻环境、不操作云服务器、不迁移数据库、不开放 Agent 执行。

## 验收

测试先失败再实现；覆盖同源目标、普通账号/退出/暂停/撤权拒绝、固定查询和伪造头、内部桥接 Cookie 边界、域名配置拒绝非法输入、网关无 9443 发布、卷与 Secret 保留。运行配置回归、API/管理端测试和构建，并使用临时有归属的 Docker 环境验证实际 Caddy/Grafana 链路；结束后精确回收临时资源，常驻环境保持停止。

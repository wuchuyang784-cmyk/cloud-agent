# 管理端同源监控与云端域名配置

## 本次变更

管理端仍为 `/admin/`，五项导航不变。Grafana 面板由“运行监控”内嵌展示，浏览器只请求当前站点的 `/api/admin/grafana/`，不再跳转到 `localhost:9443`，没有“独立打开 Grafana”或独立 Grafana 登录入口。

Grafana、Prometheus 和告警组件仍是内部服务，不与 API 合并进程。业务/预发各自的卷、Secret、历史、安装身份及账号权限保留。本次没有数据库迁移，不开启 Agent 创建/执行。

本批修改的是代码和验收脚本，没有启动或更新已停止的本机常驻环境，也没有在云服务器执行部署。

## 两种内部连接

| 环境 | 浏览器入口 | API 到监控的连接 | 对宿主发布 |
| --- | --- | --- | --- |
| 开发业务 | `http://localhost:5173/admin/` | 原机器 Bearer 桥接 `127.0.0.1:9493` | 9493 仅回环机器入口，不接受业务 Cookie |
| 常驻预发/显式云域名 | 平台 HTTPS 地址的 `/admin/` | `http://bairui-preprod-gateway:9494` 内部 session 桥接 | 只发布平台 HTTPS；9494/Grafana/Prometheus 不发布 |

API 先校验真实会话、active 账号及平台监控权限，再应用固定路径和固定 PromQL 白名单。预发 session 模式只向固定内部地址发送业务 Cookie，不发送浏览器的身份头或 Authorization；内部网关再次向 `/api/admin/monitoring/access` 验证会话，注入 Viewer，并在转发 Grafana 前删除 Cookie 和 Authorization。浏览器没有凭据直达 Grafana 的旁路。

业务 Bearer 模式仍使用原独立机器 token，业务 Cookie 不发给该机器桥接。`BAIRUI_GRAFANA_AUTH_MODE=session` 必须同时配置 `BAIRUI_MONITORING_SCOPE=preprod`，不允许把 session 模式指向任意 URL。未配置 Grafana 时 overview 返回 `dashboardUrl: null`，前端明确展示未配置状态，不回退到其他站点。

## 云服务器统一 HTTPS 入口

前提：项目、数据库、认证和单节点 Docker Swarm 已依照现有预发文档准备好；域名 DNS 指向服务器，云安全组允许 TCP 443，443 未被其他程序占用。这里仍是现有单节点预发机制，不代表跨节点 HA 或生产容量验收。

在服务器的 Conda `cloud` 环境、项目根目录执行。把示例域名替换为你自己的域名：

```bash
conda activate cloud
export BAIRUI_CONSOLE_PUBLIC_ORIGIN=https://console.example.com
npm run preprod:up
# 仅在首次接入监控时执行；已接入的环境 preprod:up 会保留并恢复监控
npm run monitor:up
npm run preprod:status
npm run monitor:status
```

统一访问 `https://console.example.com/admin/`，使用已有平台管理账号。客户端同样使用这个站点的 `/`。不要再开放 9443、9494、3000、9090 或 API 8080 给浏览器。只设置域名不会自动授予平台管理员；真实账号的平台授权仍需按既有流程明确配置。

`BAIRUI_CONSOLE_PUBLIC_ORIGIN` 由部署命令显式读取，不从业务 `.env` 导入，校验后保存到现有预发状态；后续 stop/up 复用保存的值。已有环境更新前备份 `output/preprod/`、现有数据库和持久卷记录。网关更新会短暂中断；沿用原证书卷和 Secret，不重置数据。公网域名使用 Caddy 正常证书管理；本机默认仍是 `https://localhost:8443` 和原内部 CA，不自动写入系统信任。

仅接受规范的 HTTPS 公网 origin（默认 443），拒绝凭据、路径、query、fragment、控制字符及非 HTTPS 公网 URL。不能填 `https://domain/admin/`；应只填 `https://domain`。公网域名的真实 DNS、证书签发和云安全组仍需在目标服务器验收，本机配置测试不能替代它们。

## 独立业务 API 的云端 connector

如果部署的是独立业务 API 而非上面的预发 API，首次安装业务监控可显式设置：

```bash
export BAIRUI_BUSINESS_PUBLIC_ORIGIN=https://console.example.com
npm run monitor:business:up
```

该入口仍要求已准备其共享监控网络及两环境 Runtime 指标凭据，不是空服务器一键生产安装器。它生成忽略目录中的 v2 connector，Grafana 与 API 共用同一 public origin。运行业务 API 时显式设置 `BAIRUI_ADMIN_MONITORING_CONFIG_FILE` 为该 connector 的绝对路径，并将其中引用的机器 token 文件保留在受限位置；不把 token 写入 Git 或浏览器配置。API 与机器 bridge 必须在同一宿主网络命名空间；若 API 容器化，不能直接照搬回环 connector，应使用上面的内部 session 部署链路或另行设计容器内连接。

v1 connector 仅供原 `http://localhost:5173` 开发环境，production 拒绝加载。v2 必须是非回环 HTTPS origin；它不会自动修改业务 `BETTER_AUTH_URL`、反向代理或可信代理配置，三者必须与实际业务入口一致。已有业务安装改变 origin 会明确拒绝，须单独安排 connector、Grafana 与 API 的协调迁移，不静默覆盖本机配置。

## 验证与边界

```bash
npm run test:admin:web
npm run build:admin
npm test --prefix apps/platform-api
npm run test:preprod:config
npm run test:monitoring:config
npm run test:monitoring:business
npm run test:runtime-deployment
npm run test:monitoring:grafana-compat
```

最后一项使用临时、带随机归属标签的实际 Caddy/Grafana 环境，不启动常驻业务或预发，结束后只清理本次容器和网络。它验证代理与 Viewer 链路；其认证 fixture 不等于真实 Better Auth/业务库部署验收。

`test:preprod`、`test:monitoring` 仍是显式常驻预发故障验收，会重启相关服务；不要对正在使用的环境直接运行。它们现在使用真实平台测试会话访问同源面板，不再依赖 Grafana 应急密码登录。测试账号只在独立预发创建，监控专项退出测试会话并撤销临时平台角色，不修改业务账号。

历史已部署记录见 37/38/44/49；其中 9443 和独立登录是旧版行为，不是本批的新入口。

### 2026-10-15 本机验证记录

后端全量 338 通过 / 9 数据库专项跳过 / 0 失败；管理端与客户端各 19 通过；管理端构建通过。配置、CLI、监控、Runtime 与事务回归组合 167 项通过。

实际 Linux 容器配置计算、官方 Caddy 校验、当前 API → 内部鉴权桥接 → Grafana/Prometheus 共 7 组检查通过，报告为 `output/monitoring-single-origin/2026-10-15T14-10-58-034Z/report.json`。浏览器完成实际 12 面板查询、刷新、1440/390/320px、同源单页签与访问拒绝测试，无意外面板请求错误。测试认证为隔离 fixture，不能据此宣称真实 Better Auth/业务库已经在云端更新。

预发面板 provider 使用固定 folderUid 和新的文件夹标题，原随机 UID 文件夹保留，dashboard UID 不变；已有持久卷升级仍需目标环境验收。本机临时资源已回收，原常驻服务保持停止。

参考：[Caddy forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)、[Grafana 子路径配置](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/#serve_from_sub_path)。

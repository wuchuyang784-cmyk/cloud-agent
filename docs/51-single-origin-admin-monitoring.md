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

最后一项使用临时、带随机归属标签的实际 Caddy/Grafana 环境，不启动常驻业务或预发，结束后只清理本次容器、网络和专用卷。它验证代理与 Viewer 链路及下述既有卷升级；其认证 fixture 不等于真实 Better Auth/业务库部署验收。设置 `BAIRUI_PLAYWRIGHT_MODULE` 为已安装 Playwright 模块的绝对路径可执行浏览器部分；未设置时不代表浏览器验收通过。

`test:preprod`、`test:monitoring` 仍是显式常驻预发故障验收，会重启相关服务；不要对正在使用的环境直接运行。它们现在使用真实平台测试会话访问同源面板，不再依赖 Grafana 应急密码登录。测试账号只在独立预发创建，监控专项退出测试会话并撤销临时平台角色，不修改业务账号。

历史已部署记录见 37/38/44/49；其中 9443 和独立登录是旧版行为，不是本批的新入口。

### 2026-10-15 本机验证记录

后端全量 338 通过 / 9 数据库专项跳过 / 0 失败；管理端与客户端各 19 通过；管理端构建通过。配置、CLI、监控、Runtime 与事务回归组合 167 项通过。

实际 Linux 容器配置计算、官方 Caddy 校验、当前 API → 内部鉴权桥接 → Grafana/Prometheus 共 7 组检查通过，报告为 `output/monitoring-single-origin/2026-10-15T14-10-58-034Z/report.json`。浏览器完成实际 12 面板查询、刷新、1440/390/320px、同源单页签与访问拒绝测试，无意外面板请求错误。测试认证为隔离 fixture，不能据此宣称真实 Better Auth/业务库已经在云端更新。

预发面板 provider 使用固定 folderUid 和新的文件夹标题，原随机 UID 文件夹保留，dashboard UID 不变；已有持久卷升级仍需目标环境验收。本机临时资源已回收，原常驻服务保持停止。

参考：[Caddy forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)、[Grafana 子路径配置](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/#serve_from_sub_path)。

### 既有看板升级：version 2

Grafana 13.2.2 的文件 provisioning 会比较看板文件字节的校验和；内容未改变时跳过保存。因此，仅改 provider 的 `folderUid` 或重启服务，已存在的 `bairui-platform` 看板可能仍留在旧目录。此次将生成 JSON 的 `version` 从 1 提升为 2，使文件内容改变；保留 dashboard UID、固定目录 UID、持久卷与代理白名单，不删除旧文件夹。这里的 JSON 版本用于改变文件内容，不要求 Grafana API 返回的内部修订号恰好为 2。源码依据：[v13.2.2 file_reader.go](https://github.com/grafana/grafana/blob/v13.2.2/pkg/services/provisioning/dashboards/file_reader.go)。

已有环境更新前，核对当前安装身份、Grafana 服务和卷的归属，保存旧状态、监控 stack、生成配置及服务规格。仅停止本安装 Grafana 的单副本，等待容器完全退出后，冷备原 Grafana 数据卷（包含 `grafana.db`），检验归档可列出且计算 SHA-256。其他采集组件、API、数据库和网关不需停机。不得删除卷、重新生成 Secret 或重建数据库来完成迁移。

部署更新后的监控配置，继续挂载原卷。通过已登录的平台管理会话请求 `/api/admin/grafana/api/dashboards/uid/bairui-platform`，必须确认 `meta.folderUid === 'bairui-platform-folder'`、UID 不变且仍有 12 个面板；核对原卷、Secret ID 和无关服务的容器 ID 未改变。在管理端打开“运行监控”，滚动到所有面板，检查每个 `/api/ds/query` 响应中的对应结果状态成功，不能只看 HTTP 200。允许合法空数据；“当前触发告警”无数据可表示没有告警，不要求每张图都有数值。

隔离回归使用同一个真实 Grafana 持久卷分三步验证：旧 version1 配置创建看板并冷备；只升级 provider、重启并复现旧目录未迁移；再发布 version2 看板，确认相同数据库 ID/UID 迁移、旧目录保留。浏览器检查 12 个面板完成查询、无意外接口或查询错误，报告和备份写入忽略的 `output/monitoring-single-origin/<时间>/`。此用例不会启动已停止的本机常驻环境。

若升级失败，先恢复备份的旧源码和监控 stack，使用原卷与原 Secret 恢复原服务；不要覆盖仍在运行的 SQLite 数据库。需要恢复卷内容时，先停止并确认 Grafana 已退出，再依据已验证冷备单独安排恢复。保留失败现场及备份，不自动清空数据。

#### 2026-10-17 升级验证记录

配置/部署回归组合 80 项通过，官方 Prometheus/Alertmanager 配置与 7 条平台规则校验通过；真实旧配置同卷三阶段升级及浏览器 12 面板通过。最新隔离报告为 `output/monitoring-single-origin/2026-10-17T12-22-26-645Z/report.json`，临时资源已清理，本机常驻服务未启动。独立质量复核无阻塞项。

用户指定的 Linux 云端项目已完成冷备和监控栈更新，平台镜像未升级。备份在服务器 `/home/ubuntu/cloud-agent/output/grafana-folder-upgrade/backups/2026-10-17T12-21-52-676Z/`，包含旧源码、状态、stack、服务规格、配置和 Grafana 数据归档；归档已验证可读并记录 SHA-256。首次冷备因 root 生成的 0600 归档无法由部署账号读取而中止，原 Grafana 已恢复且当时未发布配置；随后只调整归档属主，不放宽权限，冷备和部署成功。

云端真实 Better Auth 临时 `platform_viewer` 经同源接口及浏览器检查，确认旧随机目录迁移到 `bairui-platform-folder`、看板数据库 ID/UID 保留、12 个面板全部完成查询，无接口、查询或页面错误，当前告警允许空数据。监控原卷创建时间、Secret ID、安装身份与平台 API/数据库/网关容器 ID 均保持不变。临时会话已退出、角色已撤销，私有 Cookie 文件和本次 SSH 隧道已清理，未修改已有账号或代理白名单。云端采集与四项监控服务健康；这不是生产容量或真实 Agent 执行验收。

脱敏云端报告位于服务器 `output/grafana-folder-upgrade/{api-acceptance,browser-acceptance,identity-cleanup}.json`，本机副本和截图位于相同相对目录。本次部署先单独发布版本行修复；后续 Git 提交同时包含同卷升级回归与本文档，不包含备份、Cookie 或本机私有输出。

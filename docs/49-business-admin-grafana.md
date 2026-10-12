# 本机业务管理端 Grafana 接入

本批沿用现有业务 Better Auth、PostgreSQL 和平台角色，管理入口为 `http://localhost:5173/admin/`。原预发 `8443/9443` 的监控、账号、数据卷和 Secret 独立保留。本批没有业务数据库迁移，没有开放真实 Agent、客户端部署、运维命令或审批入口。

## 接入结构

```
业务浏览器 /admin/
  → 同源 /api/admin/grafana/ → 业务 API 的逐次会话、账号状态和平台权限校验
  → 私有机器 Bearer → 127.0.0.1:9493 Caddy → Grafana Viewer
                                              → 业务 Prometheus
业务 Prometheus → 本机 API :9465（独立指标 token、Windows 实测 CPU/内存）
               → 业务与预发 Controller :9495（各自指标 token）
               → 既有 Alertmanager → 既有本地持久化告警接收器
```

浏览器不接触机器 token、数据库凭据或独立 Grafana 管理密码。Grafana/Prometheus 不发布宿主端口；桥接仅绑定回环，未持有机器 Bearer 时返回 401。API 不挂载 Docker socket。Grafana Auth Proxy 只信任专用 Caddy 的确切 bridge IP，平台管理员进入 Grafana 也只是 Viewer。

业务 Prometheus/Grafana 使用独立数据卷和固定镜像。专用 bridge 允许出站，以采集 Docker Desktop 的 `host.docker.internal:9465`；只有业务 Prometheus 加入既有内部监控 overlay。此配置是本机 Windows/Docker Desktop 接入，不是 Linux、公网或跨节点部署模板。

## 页面与数据

管理端保留五项导航：平台概览、用户账号、Agent 服务、运行监控、告警。运行监控提供真实嵌入看板、手动刷新和使用相同会话独立打开。后台 30 秒身份检查不反复卸载看板；退出、撤权或账号限制仍清除受保护页面，迟到请求不能恢复旧身份。

17 个固定面板展示当前业务 API、业务 PostgreSQL、请求/连接池/进程指标、Windows 主机 CPU/内存，以及业务与预发 Controller。业务 API 预期副本是 1；不把预发双 API 指标当作业务指标。主机用量是 Windows OS 实测值，不是容器限额。当前没有业务 Runtime run，不补造 Agent 用量。无告警时看板可正常为空。

代理只开放固定看板、固定数据源、必要只读元数据和固定 PromQL 集合。Grafana 13 的固定 dashboard DTO、文件夹、偏好及特性评估接口经过真实浏览器兼容性验证；不开放通用 Kubernetes API、任意数据源代理或配置写入。特性评估不透传客户端身份属性；前端遥测正文有界读取后本地丢弃，不保存、不发往 Grafana。

文件夹固定 UID 为 `bairui-platform-folder`。升级已有 provisioning 时，仅改变 provider 的文件夹参数不足以更新已入库看板：Grafana 对未改变校验和的 JSON 跳过更新，因此本批同时更新看板说明，保持原看板 UID 和数据卷。相关上游行为见 [Grafana provisioning 实现](https://github.com/grafana/grafana/blob/main/pkg/services/provisioning/dashboards/file_reader.go)。

## 启停与更新

在 Conda `cloud` 中运行：

```powershell
npm run monitor:business:up
npm run monitor:business:status
npm run monitor:business:stop
npm run dev
```

`output/business-monitoring/` 是已忽略的受限私有目录，包含安装记录、三个独立凭据、connector 和生成配置。`dev.ps1` 在文件存在时显式加载 connector，不把凭据写入业务 `.env`；生产环境拒绝该本机 connector。已完成安装缺失数据卷、网络、凭据或配置时拒绝生成替代历史。

更新先在私有临时目录生成并通过官方 promtool 配置/九个规则场景、Caddy 校验，再核对全部容器归属。Windows 更新挂载文件时，需要短暂停止本安装三个监控容器，原子发布变更文件并重建挂载；token、数据卷及原预发服务不变。持久化待重建标记覆盖发布中断，同内容文件保留 inode，校验失败不修改运行配置。

官方 Caddy 镜像二进制带 `NET_BIND_SERVICE` 文件能力。容器保持非 root、只读根、drop ALL、no-new-privileges，并仅把该能力加入 bounding set，以避免镜像二进制无法执行；不授 Docker 或业务数据库权限。

Controller 的 Docker 启动网络失败恢复入口仍为：

```powershell
npm run runtime:deploy -- up business
```

先验证安装、完整容器 ID、持久网络、Secret 和私有配置。只有本次 `docker start` 的明确缺失网络分类才允许有限重试/重建；历史 `State.Error` 不授权删除容器。当前业务 Controller 已恢复正常启动，原 ledger 和 Runtime 配置保留。这不是整机启动顺序、HA 或编排器崩溃恢复验收。

## 告警来源与保留

十二条业务监控规则添加固定 `environment=business`，与同名预发告警的 Alertmanager fingerprint 不同。平台告警先聚合标签，再使用固定采集来源 `instance=127.0.0.1:9465`，兼容已部署接收器的受限 IP:port 白名单。该 instance 表示业务监控采集来源，**不是故障 Controller 的地址**。旧接收器会省略 environment，但持久记录的固定 instance 仍区分业务来源；不升级或重建原接收器来接入本批。

业务“告警”页读取业务 Prometheus 当前告警，历史通知仍存于既有接收器。本机组件停机/恢复可以验证 firing/resolved，不代表整机断电仍能通知或已经接入外部短信/邮件。

## 验证入口

```powershell
npm run test:monitoring:business
npm run test:runtime-deployment
npm run test:admin:web
npm run build:admin
npm test --prefix apps/platform-api
npm run test:preprod:config
npm run test:monitoring:config
npm run test:monitoring:business:live

# 停止本批业务 Grafana，验证真实告警/恢复，再对本批三个容器做 stop/up 保留验证。
# 不停止、缩容或重建原预发服务。
npm run test:monitoring:business:live -- --faults

$env:BAIRUI_PLAYWRIGHT_MODULE='D:/conda/Lib/site-packages/playwright/driver/package/index.mjs'
npm run test:grafana:business:web
```

浏览器验收使用一次性 PostgreSQL、真实 Better Auth、受限应用角色和临时测试身份，但访问本批真实 Grafana/Prometheus。不会读取业务 `.env`、修改真实账号密码/平台角色或伪造业务会话。报告保存于 `output/playwright/business-grafana/`；实链路/保留验证位于私有 `output/business-monitoring/acceptance/`。真实用户可在原浏览器刷新管理端，继续使用原账号。

配置参考：[Grafana Auth Proxy](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/auth-proxy/)、[反向代理子路径](https://grafana.com/tutorials/run-grafana-behind-a-proxy/)、[Prometheus 配置](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)。

## 2026-10-11 验收记录

- 实际部署官方 promtool 配置及九个规则场景、Caddy 验证通过，三个业务监控容器健康；业务 Controller 从原网络启动失败状态恢复健康，原不变容器/配置保留。
- 后端全量 293 项：284 通过、9 个需要单独数据库容器入口的专项跳过、0 失败。管理端 18 项通过；业务监控 35、原监控 25、Runtime 部署 37 项合计 97 项通过；预发配置 63 项通过；管理端 TypeScript/Vite 构建通过。
- `output/playwright/business-grafana/2026-10-11T12-53-35-548Z/report.json` 为最终浏览器报告，17 项检查通过，全部 17 面板原生查询成功，主机/业务核心/双 Controller 有实测值；单序列数字卡片只有即时帧，不再重复历史值。包含 1440px、390px、320px 截图，以及 Viewer、刷新、独立打开、暂停/恢复、退出及普通账号拒绝。未发生 JS 运行错误或意外原生请求失败。
- `output/business-monitoring/acceptance/live-2026-10-10T16-28-38-284Z.json`（北京时间 10 月 11 日）为真实故障/保留报告，17 项检查通过：业务 Grafana 停止触发 firing，恢复产生 resolved，两者由既有接收器持久记录；完整业务监控 stop/up 保留 Prometheus 历史、Viewer、卷、私有身份与凭据，原预发与双 Runtime 未重启。
- `output/business-monitoring/acceptance/live-2026-10-11T13-00-25-253Z.json` 最终只读健康复核 13 项通过，验证最终启动后的实测目标、业务记录及隔离。历史恢复按实际 Controller 启动时间及最新持久状态验收，不因复核跨日期而误报；另确认没有当前 firing 的 Controller 不可用告警，新增 4 项回归测试通过。原业务库仍是 6 用户、6 Agent、4 资源、0 Runtime run，不新建业务演示账号或更改真实账号密码/角色。
- 最终开发进程已在 Conda `cloud` 中重新启动，监听 5173/5174/8080，指标单独在 9465 鉴权。私有监控三个容器采用 `unless-stopped`，开发 Node 进程没有安装 Windows 开机服务。

图表的速率/延迟需要真实请求及至少两次采样；进程新启动、无人使用或没有 5xx 事件时对应序列可为空，不回填模拟请求或零。浏览器验证使用一次性真实认证库，不宣称已代替用户本人原账号的浏览器验收；用户在原浏览器刷新管理端即可使用原会话。

# 第三阶段 3.2：独立预发监控与本地告警

## 当前状态

本批面向平台运维，使用开源 Prometheus、Grafana、Alertmanager，不往客户端控制台加入管理页面。只接入独立 `bairui_preprod`，不读取业务 `.env`，不访问或迁移 `bairui`，不开放 Agent 创建、执行或模拟充值。

**截至 2026-10-08，固定镜像已部署到独立常驻预发并完成真实故障与浏览器验收。** 当前安装身份为 `d30efbca7e8effb303785af8`，镜像版本为 `0af022020540c78c`。最新完整监控报告是 `output/preprod/monitoring-acceptance-2026-10-08T11-04-11-960Z-86a257.json`，`success: true`；对应平台恢复报告是 `output/preprod/acceptance-2026-10-08T04-53-01-494Z-c65638.json`。完整部署记录与边界见 [44-unified-admin-monitoring-rollout.md](44-unified-admin-monitoring-rollout.md)。

本轮关键验证均使用 Conda `cloud`：

| 检查 | 结果 |
| --- | --- |
| `npm run test:preprod` | 完整通过；双 API、数据库断连恢复、完整 stop/up、统一 Viewer 与应急登录 |
| `npm run test:monitoring` | 完整通过；官方配置检查、真实告警/恢复、四组件重建与持久化 |
| 管理端前端 | 15/15 通过，TypeScript 与 Vite 构建通过 |
| 浏览器 | 管理员/观察员、五项导航、治理撤权、Grafana Viewer、1440/390/320px 通过 |
| 最终服务 | API 2/2、数据库 1/1、四个监控服务各 1/1 健康 |

套件覆盖有重叠，以上数字不相加。验收仅操作独立 `bairui_preprod`；业务库 `bairui` 与容器 `bairui-postgres` 未操作。

## 环境与入口

开发终端统一使用 `cloud`：

```powershell
conda activate cloud
Set-Location E:\cloud-agent
npm run preprod:status
```

需要已完成 3.1 的本机单节点 Swarm 预发，以及能拉取以下固定镜像的 Docker 网络：

| 组件 | 固定镜像 | 上限 |
| --- | --- | --- |
| Prometheus | `prom/prometheus:v3.14.0` | 0.50 CPU / 512 MiB |
| Grafana | `grafana/grafana:13.2.2` | 0.50 CPU / 384 MiB |
| Alertmanager | `prom/alertmanager:v0.34.1` | 0.20 CPU / 128 MiB |
| 本地接收器 | 本安装 API 镜像的独立入口 | 0.20 CPU / 128 MiB |

新增内存上限合计 1152 MiB，不等于实际常驻占用，也不代表能承载的用户数。未挂载 `docker.sock`，无主机特权采集器，无自动下载 Grafana 插件。首次初始化使用无网络、仅 `CHOWN` 权限的一次性容器设置已确认归属的卷根目录所有者；初始化中断后会重试这一步，不递归修改卷内容。资源标记初始化完成后不再执行该操作；常驻服务均非 root。

首次启动前先确认没有用户正在预发操作。接入会重建预发 Caddy 和 API，短暂影响预发入口，不重置数据库和既有密钥：

```powershell
npm run test:monitoring:config
npm run test:monitoring:rules
npm run monitor:up
npm run monitor:status
```

`monitor:up` 会先拉取固定镜像、运行官方配置与告警规则校验，之后才创建监控资源和更新预发。拉取失败时先修复 Docker Desktop 的网络；不要删除原预发数据卷，不要未经核实换成不明镜像。

固定镜像已存在并完成本机部署。其他机器若拉取失败，先修复 Docker 引擎网络；不要发送代理密码、数据库密码或 Secret，也不要用不明镜像替换固定来源。

- 平台仍为 `https://localhost:8443`。
- Grafana 为 `https://localhost:9443`，仅绑定本机回环地址，账号 `admin`，密码与平台注册账号完全独立。
- 两个入口复用 3.1 的本地 CA，证书文件仍为 `output/preprod/root.crt`。脚本不自动修改 Windows 信任。
- Prometheus、Alertmanager、接收器和 API 指标均不映射宿主机端口，不通过平台路由对外开放。

## 统一管理端接入（2026-10-08，常驻预发已更新）

管理端 `/admin/` 现采用五项结构：平台概览、用户账号、Agent 服务、运行监控、告警。概览与告警由平台 API 使用固定 PromQL 只读查询 Prometheus；浏览器不能提交查询表达式或上游地址。上游未配置、超时、响应过大或异常统一返回 `monitoring_unavailable`，且不会清空管理身份或阻断用户/Agent 页面。

日常 Grafana 仍只通过回环 `https://localhost:9443` 暴露。Caddy 对每个非应急请求调用 `GET /api/admin/monitoring/access` 复核 Better Auth 会话、active 账号状态和显式平台角色，删除客户端身份头后才注入 `X-Bairui-Monitor-User` 与固定 `Viewer` 角色头。Grafana Auth Proxy 只信任网关在监控私网的精确 IP，并在每次请求同步角色；即使技术用户曾被改为 Editor，下一次平台请求也会恢复为 Viewer。日常链路不向 Grafana传递 Cookie/Authorization，也不把 Grafana 会话 Cookie 返回给平台用户。

`/login`、登录页所需的 `/public/*` 白名单静态资源与已有 `grafana_session` 继续走 Grafana 独立应急会话，平台 API 或数据库不可用时仍可登录；伪造会话由 Grafana 自身拒绝。固定 Grafana/Caddy 镜像的隔离兼容性入口为：

```powershell
npm run test:monitoring:grafana-compat
```

该命令只创建随机命名的临时容器和网络，验证 Viewer 映射和逐请求角色回收、伪造头拒绝、伪造会话拒绝、平台鉴权停机后登录静态资源与真实管理员登录，以及生产 Caddyfile 解析，最后清理资源。常驻预发还通过了真实平台会话、退出失效、暂停/封禁撤权和应急管理员入口验证。

概览的新鲜度来自固定 `timestamp(...)` 查询取得的底层样本时间，不使用 Prometheus instant query 的评估时间。所有 Prometheus 请求的排队与执行共用 3 秒绝对截止时间，队列和并发数均有上限；饱和时快速返回统一 503，断开的页面不会留下长期无界查询。

## Grafana 密码

首次由加密随机数生成并写入独立 Docker Secret，配置文件和终端不显示密码。只有显式执行以下命令，才复制到 Windows 剪贴板：

```powershell
npm run monitor:password
```

在 Grafana 登录页粘贴，使用后清空剪贴板。不要把密码或截图发到聊天中。该命令读取安装时的密码；若在 Grafana 内主动改密，Secret 不会自动跟随变化，原密码也不会覆盖已存在的 Grafana 用户。验收使用初始管理员凭据，改密后的验收需先确认凭据方案，不得通过删卷重置。

## 采集与告警

Prometheus 每 15 秒通过 `tasks.bairui-preprod_api` 查找两份 API，逐实例抓取专用 `9464` 端口。该端口使用独立 Bearer Secret，不依赖用户会话。默认开发环境不启用采集端口；启用时缺少或无效 Secret 拒绝启动。

看板提供请求速率、5xx 比率、P95、处理中请求、数据库就绪、连接池总数/空闲/等待/上限，以及 API 内存、CPU、事件循环延迟。只使用有限的方法、路由模板、状态标签，不记录用户 ID、邮箱、资源 ID、Cookie、请求正文或查询参数。就绪指标表示应用账号探测结果，不等同于全库性能、复制、磁盘或备份检查。

| 告警 | 初始条件 |
| --- | --- |
| `ApiReplicaMissing` | 可抓取 API 少于 2 份持续 45 秒；零目标也告警 |
| `DatabaseUnavailable` | 数据库探测失败或就绪指标缺失持续 45 秒 |
| `ApiErrorRateHigh` | 5 分钟内至少 20 个业务请求且 5xx 比率超过 5%，持续 2 分钟 |
| `ApiLatencyHigh` | 同样最低请求量，业务 P95 超过 1 秒，持续 2 分钟 |
| `DatabasePoolWaiting` | 连接池等待持续 1 分钟 |
| `MonitoringTargetDown` | 监控组件采集失败或配置目标缺失持续 45 秒 |
| `AlertDeliveryFailed` | Prometheus 到 Alertmanager 或 Alertmanager 到接收器的投递失败 |

这些是起始阈值，需要下一阶段容量测试校准。探针请求不计入业务错误率和 P95；无业务流量时部分图表会无数据，不伪装成已测得零延迟。

Alertmanager 的触发和恢复通知只发往监控私网的本地接收器。接收器只保存白名单字段，丢弃任意注释、URL 和额外标签；记录持久化后才确认接收。请求大小、告警数量、待写入队列和日志轮转均有上限。

```powershell
npm run monitor:alerts
```

最近的脱敏记录存放在专用卷，最多 3 个文件，每个默认 1 MiB。无网络记录查询接口。Prometheus 按 7 天和 1 GiB 的较早条件保留历史；1 GiB 是 TSDB 保留策略，不是包括 WAL、压缩临时文件和其他卷的宿主机硬磁盘配额。

## 启停与持久化

```powershell
npm run monitor:stop      # 只停监控，平台继续运行，监控入口暂不可用
npm run monitor:up        # 恢复监控并校验预发配置
npm run preprod:stop      # 停止整套独立预发及已接入的监控
npm run preprod:up        # 按状态文件恢复平台及已接入的监控
```

停止不删除卷、账号、Secret 或证书。已安装监控缺失任何持久卷、Secret 或私网时，脚本拒绝自动替代。保留 `output/preprod/state.json`；不要手工删掉状态文件来绕过校验。资源归属不匹配或 Docker 节点变化时同样停止。

## 验收

在没有用户操作的时间执行。该命令只对独立预发做演练，不操作业务数据库：

```powershell
npm run test:monitoring
```

验收覆盖：官方配置和规则测试、受 CA 校验的 HTTPS、Grafana 认证与数据源、两份 API 独立采集、指标认证与隐私标记、平台路由隔离，以及真实 `2 -> 1 -> 2` API 副本故障和告警触发/恢复。随后重建监控容器检查记录、指标历史和 Secret 保留。故障步骤使用 `finally` 恢复双 API 并等待健康。

报告写入 `output/preprod/monitoring-acceptance-*.json`，只保存脱敏检查结果。另需浏览器检查 Grafana 登录和中文看板，不能只用配置测试代替部署与页面验收。

2026-10-08 浏览器验收已完成。Grafana 看板能通过平台 Viewer iframe 加载；Prometheus 插件请求缺失的 `zh-Hans` 翻译资源时会回退并留下 404/warning，不影响数据源、面板或鉴权结果。320px 概览曾因原始浮点数撑宽页面，现已改为带单位的短格式并增加溢出回归测试。

## 明确限制

- 通知只在本机持久化，没有邮件、企业微信或离线推送。
- 本机、Docker 或整套监控停机时无法自行通知；接收器停机时也无法把投递失败通知写入自身，需要独立外部监控才能覆盖。
- 单机 Swarm、单数据库、单网关仍然不是高可用系统。
- 不包含主机磁盘告警、数据库深度诊断、备份恢复、Loki/Tempo 或真实 Agent 运行时监控。
- 本批不构成公网生产上线、持续高并发或租户容量验收。

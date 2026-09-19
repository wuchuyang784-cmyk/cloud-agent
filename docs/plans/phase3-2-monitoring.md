# 第三阶段 3.2：监控与本地告警实施计划

> 用户已确认 Prometheus + Grafana + Alertmanager，自托管、本地告警，不接外部通知。使用 Superpowers 测试驱动、分任务实现与复核；保留现有未提交工作，不创建提交或切换工作区。

## 目标与约束

- 在独立 `bairui_preprod` 预发上监测两份 API、数据库就绪、连接池和进程状态，完成故障、通知、恢复闭环。
- 不读取业务 `.env`，不操作 `bairui-postgres` 或 `bairui`，不改变数据库模型、认证身份、既有密钥与 Agent 能力。
- 监控私网独立；API 指标端口 9464 使用独立 Bearer Secret，无宿主机映射。Prometheus 通过 Swarm tasks DNS 分别抓取两份 API，不使用服务 VIP 轮询抓取。
- Caddy 保留平台 8443 入口；额外仅回环 9443 入口供 Grafana，使用同一预发 CA。Grafana 使用独立管理员账号，禁止匿名与自助注册。不代理 Prometheus、Alertmanager 或接收器到用户入口。
- Prometheus、Grafana、Alertmanager、本地接收器均为节点固定的 Swarm 服务，限额并持久化，不挂载 docker.sock，不引入主机特权采集器。
- 新 Secret 首次随机创建，已有安装缺卷或缺 Secret 时拒绝自动替换。配置、状态、报告不得包含密码或凭据。
- 指标标签只允许有限方法、路由模板和状态码；日志只重建白名单字段，不保留用户、Cookie、邮箱、正文、原始 SQL、URL 查询或异常消息。
- 外部邮件、企业微信、Loki/Tempo/OTel Collector、主机监控、真实 Agent、容量结论及备份恢复不在本批交付范围。

## 分工与接口

### 任务 1：API 指标与安全日志

文件：`apps/platform-api/src/observability/`、`src/app.mjs`、`src/index.mjs`、`src/auth/` 的日志配置、对应测试及 API 依赖文件。

- [x] 先写失败测试：指标默认关闭、专用端口认证、请求成功/失败/中断计数、路由标签有界、敏感日志脱敏、数据库故障仍可采集、关闭端口。
- [x] 使用锁定版本 `prom-client` 15.1.3，每实例独立 Registry；接口集成不改变业务授权。
- [x] 指标契约：`bairui_http_requests_total{method,route,status}`、`bairui_http_request_duration_seconds`、`bairui_http_requests_in_flight`、`bairui_database_ready`、`bairui_db_pool_connections{state="total|idle|waiting"}`、`bairui_db_pool_max`，Node 默认指标。
- [x] 配置契约：`BAIRUI_METRICS_ENABLED=1`、`BAIRUI_METRICS_PORT=9464`、`BAIRUI_METRICS_TOKEN_FILE=/run/secrets/metrics-token`；缺失或弱凭据拒绝启动。
- [x] 运行专项及 API 回归，审查日志边界。

### 任务 2：本地告警接收器

文件：`apps/platform-api/src/monitoring/alert-receiver.mjs`、`alert-receiver-index.mjs`、`apps/platform-api/test/alert-receiver.test.mjs`。

- [x] 先写失败测试：Bearer 认证、大小/并发上限、非法结构、敏感字段丢弃、触发/恢复记录、写入失败重试、文件轮转、重启读取。
- [x] HTTP `POST /alerts`，认证后只重建时间、告警名、严重性、状态、合法实例地址；正文最大 64 KiB，最多 64 条告警，持久化成功才返回 200。
- [x] 使用 `/data/alerts.jsonl` 与有限轮转文件，单文件 1 MiB，最多 3 个文件；串行写入、队列上限 32，失败返回 503。
- [x] 入口配置：`BAIRUI_ALERT_TOKEN_FILE=/run/secrets/alert-token`、`BAIRUI_ALERT_DATA_DIR=/data`、`PORT=9095`；`GET /livez` 只返回存活，不提供公网记录查询。
- [x] 提供导出函数 `createAlertReceiver({ token, directory, maxFileBytes, maxFiles, maxPending })` 返回 Node HTTP server，`readAlertRecords(directory, limit=100)` 供本机命令读取已脱敏记录。

### 任务 3：监控配置与安全部署

文件：`scripts/monitoring-config.mjs`、`scripts/monitoring.mjs`、`scripts/monitoring-config.test.mjs`、`scripts/preprod*.mjs`、根 `package.json`。

- [x] 先写失败测试：私网/端口、权限、Secret 挂载、持久卷缺失、归属、无业务配置读取、资源预算、平台路由不暴露监控。
- [x] 生成 Prometheus/规则、Alertmanager、Grafana 数据源/12 面板中文看板；固定镜像版本，不使用 latest。
- [x] 编写七项告警：两份 API 抓取不足、数据库不就绪、错误率、P95、连接池等待、监控组件采集失败与通知失败；包含采集缺失规则。官方工具执行及真实告警效果仍待任务 4 验证。
- [x] 新命令 `monitor:up/status/stop/alerts/password`。与预发复用操作锁；stop 保留监控数据与 Secret；password 仅显式调用时复制到本机剪贴板，不输出密码。
- [x] 预发状态增加显式监控开关；普通 `preprod:up` 保留已接入监控网络与 Secret，缺失时 fail closed。
- [x] Prometheus 保留 7 天、大小 1 GiB；设置容器资源上限和日志轮转。Grafana 禁止对外遥测、自动插件下载和默认弱密码。

### 任务 4：真实部署与验收

文件：`scripts/test-monitoring.mjs`、`scripts/monitoring-rules.test.mjs`、`output/preprod/monitoring-acceptance-*.json`。

- [x] 单元及平台回归通过；验收脚本语法检查通过，官方工具入口和七组规则测试场景已编写。
- [x] 使用缓存 Caddy 镜像在无网络临时容器内完成实际配置解析，确认监控开/关时私有 404 处理优先于页面和代理回退；未替代真实 HTTPS 验收。
- [ ] 官方 promtool/amtool 配置与规则测试通过，再部署独立监控。当前受官方镜像拉取网络阻塞。
- [ ] HTTPS 严格验证 CA；Grafana 未登录不可查监控数据，正确登录可读取配置看板和两份 API 指标，平台入口无法获得指标。
- [ ] 告警链路测试先降低仅预发 API 副本数到 1，观测 Prometheus firing、接收器触发记录；finally 恢复到 2，验证 resolved。数据库断开用受限探针指标及专项验证，不操作业务库。
- [ ] 重启监控服务验证历史和 Secret 保留；验证指标/日志/报告无测试敏感标记。
- [ ] 浏览器检查独立 Grafana 登录与中文看板，原客户端入口健康。完成所有执行会话后报告真实结果。

### 任务 5：中文交付

- [x] 新增 `docs/38-phase3-monitoring.md` 操作说明，更新文档索引和 AGENTS 当前阶段边界。
- [x] 记录固定版本、配置资源上限、验收路径及明确限制：本机停机无法自告警、无外部通知、无主机磁盘/全库诊断、不代表高可用或生产容量。
- [ ] 完成真实部署后，记录监控资源占用实测值；不能用容器上限代替实测。

## 进度

2026-09-19：代码及本机测试已验证，第三阶段 3.2 的真实部署验收仍未完成。开发与测试统一通过 Conda `cloud` 执行。

- 监控配置、资源保护、预发配置及接收器组合测试：79/79 通过。
- 后端全量：160 项，158 通过、2 个独立 PostgreSQL 专项跳过；随后 `test:platform` 22/22、`test:scheduler` 10/10 均通过，无跳过，临时库已清理。
- 前端：13/13 通过，构建通过；`test:preprod:config` 54/54 通过。套件之间有重复覆盖，不累加作为独立测试总数。
- 补充复核：初始化中断后重试卷根目录权限、Docker 错误输出纳入隐私检查、固定监控目标可接收、Windows 指标端口冲突测试、验收报告失败时不能保留成功标志。
- 最后只读检查：原预发 API 2/2 健康、数据库 1/1 健康、Caddy 运行、就绪 HTTP 200；本轮没有部署或重启预发，也没有读取业务 `.env` 或访问 `bairui`。
- 当前阻塞：Docker Hub 先前返回 `EOF`，最近重试为 `registry-1.docker.io:443` 连接超时。需要用户确认可用的 Docker Desktop 代理或明确批准的镜像来源，不自行替换为非官方镜像。
- 尚未验证：官方 promtool/amtool、监控实际启动、故障触发/恢复、容器重建后持久化、Grafana 浏览器页面、真实资源占用。无成功的监控部署验收报告。

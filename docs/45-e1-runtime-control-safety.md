# E1：真实 Runtime 控制安全底座

日期：2026-10-09。范围：控制代码与本机隔离验收；未部署真实编排器，未更新常驻预发，未迁移业务库。

## 1. 已交付的控制路径

E1 提供独立 `MemoryRuntimeControlStore`、`PostgresRuntimeControlStore`、`RuntimeController.tick()` 与无状态 `RemoteRuntimeDriver`。没有接入公开启停 API，没有启动常驻 Controller，没有增加客户端按钮。

`BAIRUI_PLATFORM_MODE=platform` 的 Agent 创建、生命周期写入、对话执行及模拟充值仍关闭。旧 Worker、Runtime、Boundary 仍拒绝在平台模式启动。现有客户端资源库、个人历史与管理控制台不变。

核心实现位于 `apps/platform-api/src/runtime/`，协议 fake 位于 `apps/platform-api/test/helpers/fake-runtime-orchestrator.mjs`。fake 只维护测试记录，不创建容器或调用真实模型。

## 2. 状态、代次与恢复

| 事件 | 控制状态与运行记录 | 路由与后续动作 |
| --- | --- | --- |
| 首次 start | generation=1，desired=running，run=initializing | 入队固定启动命令；暂不发布路由 |
| 匹配的 running 回执 | 账号 active、治理版本相同、run 与 generation 相同 | 原子发布 route_version=run_generation |
| stop / 治理协调 | generation+1，desired=stopped，run=stopping | 事务内先撤路由，再通过 outbox 请求外部停止 |
| 匹配的 stopped / absent | run=stopped，记录确认时间 | 仅清空匹配的 active_run；不影响新代次 |
| stop 失败或未知 | 保持 stopping 和 active_run | 有界退避；耗尽进入 dead，不宣称释放 |
| start 结果未知且耗尽 | 原子置 desired=stopped、generation+1、run=stopping | dead 启动命令与补偿 stop、审计同事务落库 |
| 恢复账号 active | 不修改原控制意图 | 不启动、不恢复旧路由；须等旧 run 停止确认后才能新建 run |

资源规格仅四个整数：CPU 100–8000 millicores、内存 128 MiB–16 GiB、PID 16–1024、空闲 TTL 60–86400 秒。越界拒绝，不静默钳制。E1 校验和传递规格，实际资源限制和 TTL 回收由后续真实编排器实现。

请求 UUID 幂等；相同 UUID 不同参数拒绝。已 desired running 的新 start 是同代次 no-op，未确认旧 stop 时新 start 返回 `runtime_stop_pending`。历史 `run_generation=0` 不进入 E1 控制链。

每次 tick 先协调治理，再逐条领取并执行命令。租约 60 秒，回执与完成操作必须匹配 worker ID、命令 request ID、attempt、未到期租约和完整 run 身份。复用同一 worker ID 也不能提交旧 attempt。网络调用前另做 `prepareCommand` 校验；网络调用期间仍可能发生治理，故提交时必须再次校验。

启动时保存 `governance_version`，即使暂停后立即解除且两次变化均发生在 tick 之间，旧 run 也会被围栏阻断。D1 状态提交与 E1 协调不是同一事务，不承诺管理操作同步释放资源。数据库触发器发出仅含内部 user ID 的 `bairui_runtime_governance` 通知；E1 尚未交付常驻 LISTEN/定时进程。后续进程须周期调用 tick，通知仅用来加速，不能作为唯一正确性来源。

默认每 tick 上限 10 条命令、最多 8 次尝试；失败退避从 500 ms 起，最高 30 秒。每次准备执行时才领取一条，避免批量预租导致后面的命令先过期。单次远端请求（含正文）默认 10 秒、最大 25 秒，未知结果可再 inspect 一次。数据库操作显式 READ COMMITTED，语句超时 3 秒、锁等待 2 秒；回滚不确定时丢弃连接。

治理相关操作使用与 036/037 相同的 `<schema>:governance:changes` 共享事务锁；D1 使用独占锁。修改锁顺序统一为 Agent → control → run → outbox；协调批次先跳过已锁 Agent，再重新筛选并锁定 control，避免审计外键隐式锁 Agent 导致逆序死锁。系统治理命令使用独立随机 UUID，以行锁和状态转换保证幂等，不允许调用者预占可预测 ID 来吞掉 stop 命令。所有副本必须同版升级。旧 Worker 的领取语句只选 `agent.provision`，但这不代表可以混跑忽略代次的旧版本 Worker。

## 3. 远端协议和不可省略的停止约定

固定接口：

- `PUT /v1/runs/{runId}`：启动，固定 agentId/runId/runGeneration/engine/resourceSpec。
- `POST /v1/runs/{runId}/stop`：停止，附更大的 fenceGeneration 和清洗后的原因。
- `GET /v1/runs/{runId}`：未知结果查询；回显身份，不凭普通 404 推断停止。

编排器必须持久化 runId 幂等状态和终止标记：stop 确认 `absent` 也必须建立停止记录。确认后，已经在途但迟到的 PUT、重试 PUT 都不得重新创建该 run。仅“查询时恰好不存在”不满足 absent 契约。新启动使用新的 runId；旧 runId 不复用。测试 fake 已覆盖停止先确认、迟到 PUT 后到达的竞态，但这不是实际编排器的持久化验收。

请求 HMAC-SHA256 规范串：

```text
v1\nMETHOD\npath-and-query\ntimestamp-ms\nnonce\nrequest-id\nsha256(raw-body)
```

响应规范串：

```text
v1\nHTTP-status\nrequest-id\nrequest-nonce\nsha256(raw-body)
```

请求头为 `x-bairui-control-{version,key-id,timestamp,nonce,request-id,signature}`。响应为 `x-bairui-control-{version,key-id,request-id,request-nonce,response-signature}`；`request-nonce` 必须匹配本次调用，不能用同一 request ID 的历史响应替代本次结果。时间窗口 ±60 秒；去重记录保留到签名时间+120 秒。

E1 的 `MemoryNonceStore` 仅用于隔离测试。当前验签接口要求 nonceStore.consume 同步返回明确的 true，Promise 不会当作校验成功。真实多副本编排器须在产生任何副作用前完成共享、原子的防重放检查，并处理重启和存储故障；不能直接把测试内存去重器用于部署。

运行时 URL 只允许 http/https，禁 userinfo、query、fragment，并匹配显式 host 或 CIDR allowlist。控制 origin 只允许 HTTPS；只有测试环境通过构造参数显式开启 HTTP。禁止跳转；响应默认上限 64 KiB，最大可配置 1 MiB；总截止时间覆盖响应头和正文。

远端响应只投影固定 DTO，不能覆盖 workerId、requestId、leaseAttempt 或 fenceGeneration。错误持久化仅包含已知枚举，不含任意错误正文、上游响应、凭据或 URL。RemoteRuntimeDriver 不再继承本地实例 Map；E1 只通过 Controller 使用它，不走旧 PiEngineAdapter 的无代次生命周期调用。

## 4. 迁移 039 与最小授权

`packages/db/migrations/039_runtime_control_fencing.sql` 依赖基础表、022/029 和 D1 的 036/037 及其前置迁移，不依赖模拟调度 033/038。它新增两个 FORCE RLS 控制表，扩充 engine runs 的 generation/stop 字段，复用 control_outbox，不迁移真实账号、不生成运行意图。

部署时先备份目标库并核对迁移顺序；当前没有执行部署操作。示意授权如下（角色须由目标环境显式建立，非超级用户、无 BYPASSRLS；不要直接复制测试账号）：

```sql
-- 指定业务 schema 的 USAGE、连接权限另行按环境授予。
GRANT EXECUTE ON FUNCTION
  runtime_control_request_start(text,text,uuid,bigint,integer,bigint,integer,integer),
  runtime_control_request_stop(text,text,uuid,bigint,text)
TO bairui_app;

GRANT EXECUTE ON FUNCTION
  runtime_control_claim(text,integer),
  runtime_control_prepare(text,uuid,integer),
  runtime_control_complete(text,uuid,text,text,integer),
  runtime_control_commit_started(text,uuid,text,text,bigint,text,text,integer),
  runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz,integer),
  runtime_control_reconcile_governance(text,integer)
TO bairui_runtime_controller;
```

Controller 不需业务表直接 SELECT/INSERT/UPDATE/DELETE，也不需读取 Better Auth、资源正文或治理审计表。私有 `runtime_control_receipt` 与触发器函数不授 PUBLIC 或 Controller。控制函数是受信后端边界：actor 来自 Principal，Controller 负责验证远端签名和 URL；函数不会独立验证 Better Auth 会话或 HMAC。数据库凭据被盗不在这层函数的独立防护范围内。不得给新增表追加通用写权限。

配置仅在后续独立 Controller 内使用：`BAIRUI_RUNTIME_ORCHESTRATOR_URL`、`BAIRUI_RUNTIME_CONTROL_KEY_ID`、`BAIRUI_RUNTIME_CONTROL_SECRET`（32 字符以上随机密钥）、`BAIRUI_RUNTIME_ALLOWED_HOSTS` / `BAIRUI_RUNTIME_ALLOWED_CIDRS`、可选 `BAIRUI_RUNTIME_CONTROL_TIMEOUT_MS` / `BAIRUI_RUNTIME_CONTROL_MAX_RESPONSE_BYTES`。数据库使用独立受限连接池；不复用应用角色，不写 Secret 到仓库，不向浏览器返回内部配置。

暂停/回滚部署时先停控制副本并保持用户执行关闭，保留 control/run/outbox/审计与终止记录，不删除迁移来“恢复”已停止实例。禁止旧无代次代码继续消费 E1 队列；未确认停止和 dead 命令应由后续受控运维恢复流程处理，不能手工把 run 改成 stopped 冒充资源已释放。

## 5. 验证记录

在 Conda `cloud` 下执行；专项脚本清除继承的业务配置，只创建随机命名的一次性 PostgreSQL 容器，完成后删除本次测试容器。

```powershell
conda run -n cloud --no-capture-output npm run test:runtime-control
conda run -n cloud --no-capture-output npm test --prefix apps/platform-api
conda run -n cloud --no-capture-output npm run test:platform
conda run -n cloud --no-capture-output npm run test:governance
conda run -n cloud --no-capture-output npm run test:scheduler
```

- E1 专项：62 项通过、0 失败、0 跳过；含真实 HTTP fake + 受限 PostgreSQL、双向真实治理锁等待、审计外键锁序、系统 UUID 占位冲突、旧 attempt 拒绝、暂停后立即恢复、新旧 route 围栏、回滚、迁移重跑和最小权限。
- 后端全量：235 项，228 通过、0 失败、7 项按专项数据库入口跳过；E1 PostgreSQL 已由上述专项实际执行。
- 平台专项 25 项、账号治理专项 15 项、模拟调度专项 26 项全部通过，0 失败、0 跳过；一次性数据库均已清理。

## 6. 后续交付边界

E1 尚不包含实际 Remote Orchestrator 服务、容器创建/终止、强制资源配额、TTL 回收、常驻 tick/LISTEN 进程、真实 Provider、Runtime Boundary 票据、用户执行入口或部署。状态和 dead 原因已持久化，但未接入生产指标/告警出口；tick 的汇总仅用于调用方和测试。真实进程上线前还须接入 stopping 年龄、dead 数量和外部故障告警。

下一阶段先实现并隔离验收真实编排器的持久幂等、停止终止标记、资源限制与重启恢复，然后接入受限 Controller 的周期协调/告警，最后分阶段开放受控真实 Agent。不能将本轮 fake 协议验收写成真实资源回收或平台已上线。

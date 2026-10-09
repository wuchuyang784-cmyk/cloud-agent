# E1 真实 Runtime 控制安全设计

日期：2026-10-08；2026-10-09 更新。状态：设计获用户确认，已按单 tick 控制底座实施并完成本机隔离验收，未部署。本文保留设计动机；实现补充和准确交付边界见第 13 节与 `docs/45-e1-runtime-control-safety.md`。

## 1. 目标与交付边界

E1 先交付真实 Runtime 的“可控生命周期底座”，让平台能够持久化表达启动、停止和账号治理后的强停意图，并在进程重启、请求重试、并发操作和迟到回执下保持一致。E1 的完成标准不是用户已经可以运行真实 Agent，而是控制面具备以下不可绕过的安全性质：

- 每个 Agent 只有一个持久化的当前控制代次；旧代次的启动成功、心跳或回执不能恢复路由。
- 启动和停止请求幂等；相同请求重放返回原结果，不产生第二个实例。
- 停止意图提交时立即撤下数据面路由；只有远端编排器明确确认实例已停止或不存在，运行记录才能进入 `stopped`。
- 远端编排调用具有请求身份、时效和防重放校验，不传任意环境变量或明文 Provider Key。
- suspended/banned 账号的现存运行实例进入同一强停流程；账号恢复 active 不自动重启旧实例。
- PostgreSQL 与 MemoryStore 具有同样的状态机语义和专项测试。

E1 不开放用户侧创建、启停、对话执行或公网 Runtime 域名；`BAIRUI_PLATFORM_MODE=platform` 下现有 `agentLifecycle=false`、`agentExecution=false` 和旧 Worker/Runtime/Boundary 拒绝启动规则保持不变。E1 不接入真实 Provider Key，不部署编排服务，不迁移业务库或常驻预发。

## 2. 已核对的现状与问题

- `agent_engine_runs` 已能保存引擎运行记录，但没有控制代次，状态也缺少 `stopping`；当前 Store 和 Worker 没有使用它作为生命周期权威数据。
- `runtime_routes.route_version` 已存在，但当前只表示路由版本，未与运行代次建立强制关系。
- `control_outbox` 已提供持久化队列、租约和重试，可继续承载 Runtime 命令，避免再建第二套队列。
- `RemoteRuntimeDriver` 目前发送未经认证的 `/instances` 请求；停止时忽略非 2xx 和网络失败，随后删除内存状态并报告已停止，这不满足强停。
- RuntimeDriver 的实例状态只在进程内存中；控制进程重启后无法可靠判断现有实例、在途启动或停止结果。
- Runtime Boundary 的既有签名只覆盖时间、nonce 和正文，并存在本地默认密钥；它用于数据面信封，不能直接当作控制面编排协议。
- D1 已有 active/suspended/banned 账号治理，D2 已定义治理版本和一致的治理锁顺序；E1 必须复用这些治理事实，不能另建账号状态。
- 较旧文档中 Worker 直接操作 Docker 的描述已被 `docs/32` 的隔离决策覆盖：平台 API 与控制 Worker 不接触 `docker.sock`，实例生命周期由独立远端编排器负责。

## 3. 核心不变量

1. PostgreSQL 是平台模式下控制状态的唯一权威；JS Map、HTTP 响应和编排器自身状态都不是平台路由的单独依据。
2. `agent_runtime_controls.generation` 在每次有效的 desired state 变化时严格递增。运行记录保存创建它的 `run_generation`，不得被改写。
3. 只有同时满足“账号 active、desired state 为 running、当前 active run 匹配、run 状态为 running、run generation 等于 control generation”的实例才可写入 `runtime_routes`。
4. `runtime_routes.route_version` 等于 `run_generation`。停止、治理强停或新启动意图先按 Agent 锁删除旧路由，再提交外部调用。
5. 外部停止超时、5xx、格式错误或身份不匹配均为“停止未确认”；运行状态保持 `stopping`，继续有界重试并进入告警观测，不能写成 `stopped`。
6. 编排器返回 `absent` 只有在响应同时匹配 `agentId`、`runId` 和 `runGeneration` 时才等价于停止确认；普通 404 或空响应不算确认。
7. 启动响应即使成功，只要代次已过期，也不能发布路由；控制器必须为这个已创建实例补发停止命令。
8. 同一 `requestId` 只能表示同一 Agent、动作、期望代次和参数。相同内容重放返回原结果；内容不同返回 `idempotency_conflict`。
9. suspended/banned 阻止新启动。账号恢复 active 只解除准入限制，不修改 desired state，不恢复路由，不重试旧启动。
10. 日志、错误详情、审计和数据库事件不包含 Cookie、Provider Key、控制密钥、任意环境变量或完整上游响应。

## 4. 持久化模型与迁移 039

新增 `packages/db/migrations/039_runtime_control_fencing.sql`，依赖基础迁移、022、029、036、037 和 038。迁移只定义结构、函数与最小授权，不自动创建真实实例，也不改已有 Agent 的可执行能力。

### 4.1 `agent_runtime_controls`

每个 Agent 至多一行当前控制状态：

| 字段 | 约束与含义 |
| --- | --- |
| `agent_id text` | 主键，外键到 `agents(id)` |
| `organization_id text` | 必须与 Agent 所属组织一致 |
| `owner_user_id text` | 固化所有者范围，必须与 Agent 当前所有者一致 |
| `desired_state text` | 仅 `running` / `stopped` |
| `generation bigint` | 非负、单调递增；0 表示尚未产生真实运行意图 |
| `active_run_id text` | 可空，指向当前初始化、运行或停止中的 `agent_engine_runs` |
| `cpu_millis integer` | 100–8000 |
| `memory_bytes bigint` | 134217728–17179869184 |
| `pids_limit integer` | 16–1024 |
| `idle_ttl_seconds integer` | 60–86400 |
| `last_request_id uuid` | 最近一次已接受或 no-op 请求的关联标识 |
| `changed_by text` | 可空；用户/管理员发起时保存平台用户 ID，系统治理时为空 |
| `change_reason text` | 1–500 字，拒绝控制字符 |
| `created_at` / `updated_at` | 数据库时间 |

资源参数采用固定整数列而不是任意 JSON；E1 不允许浏览器或调用方提交镜像名、命令、挂载、网络、主机端口、环境变量或 Runtime URL。默认规格由服务端配置决定，并在写入时钳制到上述边界。

### 4.2 `agent_runtime_control_requests`

该表提供持久幂等与控制审计：

- `request_id uuid` 主键。
- 保存 organization、agent、action（`start`、`stop`、`governance_stop`）、规范化请求摘要、expected generation、result generation、result code、run ID、actor、reason 和发生时间。
- `(agent_id, result_generation, action)` 建索引用于排障，但不同 request ID 对同一 desired state 的重复请求可以落为同代次 `noop`，不能额外创建实例。
- 表不保存 Secret、明文凭据、Runtime URL 或编排器原始错误。

### 4.3 扩展 `agent_engine_runs`

- 增加 `run_generation bigint NOT NULL`，新数据必须大于 0；历史行迁移为 0，仅供历史查询，不允许成为活动路由。
- 增加 `stopping` 状态，并保留 `initializing/running/degraded/stopped/failed/deleting`；E1 不使用 `deleting` 表达强停。
- 增加 `stop_reason`、`stop_requested_at`、`stop_confirmed_at`、`last_command_request_id`。
- `container_ref` 解释为不透明 `orchestrator_ref`；字段暂不重命名以避免无收益的数据迁移。
- 对 `run_generation > 0` 的 `(agent_id, run_generation)` 建部分唯一索引。一个新控制代次只能创建一个 run，同时允许同一 Agent 存在多条迁移为 generation=0 的历史记录。
- `runtime_url` 只保存编排器返回且通过内部 URL 校验的地址；不返回浏览器。

### 4.4 扩展 `control_outbox`

- 增加可空 `request_id uuid`，并对非空值建立唯一索引；Runtime 事件必须填写，旧事件保持兼容。
- E1 事件只使用 `runtime.start.requested` 和 `runtime.stop.requested`。
- start payload 固定为 `agentId/runId/runGeneration/engine/resourceSpec`；stop payload 固定为 `agentId/runId/runGeneration/fenceGeneration/reason`。事件不包含密钥、任意 env、镜像、命令或外部 URL。
- 沿用 queued/leased/succeeded/failed/dead 与租约恢复。代次已过期的未执行命令视为“已安全消费”，写入脱敏审计结果后完成，不增加通用 outbox 状态。

### 4.5 RLS 与最小授权

新表启用并强制 RLS。用户会话只能读本人 Agent 的投影，不能直接写控制表、运行记录或 outbox；控制写入仅通过带固定 `search_path`、`row_security=off` 的 SECURITY DEFINER 函数完成。函数撤销 PUBLIC EXECUTE，只授予应用账号和独立 Runtime Controller 数据库账号所需的具体函数。

SECURITY DEFINER 函数仍信任后端传入的 actor，不构成数据库凭据泄露后的独立认证边界。Controller 账号不获得 Better Auth 表、业务正文、Provider Key 表或通用表写权限。

## 5. 原子状态转换接口

PostgreSQL 以数据库函数实现原子转换；MemoryStore 提供同名语义的方法。JS 层只解析固定 DTO，不自行拼接跨表状态。

### 5.1 `runtime_control_request_start`

输入 actor、agent ID、request ID、expected generation 和服务端规范化资源规格。函数执行：

1. 校验请求和幂等记录；锁顺序固定为治理身份 advisory lock，再锁 Agent 对应控制行。
2. 复核 Agent 所有权、engine 为允许的真实引擎、账号为 active、expected generation 与当前代次一致。
3. 若已 desired running 且 active run 为 initializing/running，则记录同代次 `noop` 并返回当前 run。
4. 否则 generation 加 1，创建唯一 run，状态 `initializing`、desired running；更新 control.active_run_id。
5. 插入 `runtime.start.requested` outbox 与控制请求审计，在同一事务返回 `accepted`。

E1 没有公开路由调用该函数；专项测试和后续 E2 的受控入口复用它。

### 5.2 `runtime_control_request_stop`

输入 actor 或系统来源、agent ID、request ID、expected generation 和原因。函数执行：

1. 按相同锁顺序校验幂等和 expected generation。
2. 若已 desired stopped 且无 active run，记录当前代次 `noop`。
3. 否则 generation 加 1，desired state 设为 stopped，现有 active run 设为 `stopping` 并记录原因。
4. 在同一事务删除该 Agent 的 `runtime_routes`，并为 active run 插入唯一 `runtime.stop.requested`。
5. active_run_id 保留到编排器确认，避免把未确认实例伪装成已释放。

停止可以针对仍在 `initializing` 的 run。编排器以确定性的 run ID 处理 stop，因此无需等待 opaque ref 才能确认 absent/stopped。

### 5.3 `runtime_control_commit_started`

Controller 提交匹配的编排器结果。函数重新锁定控制行并复核账号治理：

- 若 desired running、control generation、active run 和 run generation 全部匹配，则把 run 设为 running，保存受校验的内部引用和 URL，并原子 upsert route_version=run_generation。
- 若任一条件不匹配，则保存足以清理实例的不透明引用，将 run 保持/改为 stopping，不发布路由，并确保存在 stop 事件。
- 重复相同成功结果是幂等；相同 run 返回冲突身份、URL 或 ref 时拒绝并记安全错误。

### 5.4 `runtime_control_commit_stopped`

只有结构化的 `stopped` 或匹配身份的 `absent` 响应可调用。函数按 run ID 和 run generation 更新为 stopped，写 `stop_confirmed_at`，按相同 run generation 再次删除路由；仅当 control.active_run_id 仍指向该 run 时清空它。旧 run 的迟到停止确认不能清除新 run。

### 5.5 失败与重试

- 确定性的 start 拒绝可将 run 标为 failed，但仍须确认编排器没有创建实例；网络超时属于结果未知，先进入 reconciliation/stop，不直接 failed+释放。
- stop 的网络、5xx、超时、无效 JSON、身份不匹配全部保留 `stopping` 并按现有 outbox 退避重试；达到上限进入 dead 并产生可监控状态，不能进入 stopped。
- `last_error_code/detail` 只保存枚举码和长度受限的清洗摘要，不保存响应正文。
- Controller 崩溃后由租约到期恢复；所有外部副作用使用相同 request ID 和 run ID 重试。

## 6. 治理强停

E1 增加 Controller 周期性治理协调函数，批量扫描 active run 的所有者状态。它对每个目标先取得与 D1/D2 相同的用户治理 advisory lock，再按 Agent ID 稳定排序锁控制行，然后执行与 `runtime_control_request_stop` 相同的代次提升、路由删除和 stop 入队。单批有硬上限，使用 `FOR UPDATE SKIP LOCKED` 避免不同 Controller 重复阻塞。

为缩短治理到强停的窗口，管理治理成功后由平台 API 触发一次即时 reconcile 提示；正确性不依赖该提示，Controller 周期扫描仍会收敛。E1 隔离验收将默认扫描间隔设为 1 秒并验证最终收敛；生产间隔后续随编排部署配置，但任何间隔都不改变“路由一旦协调即先撤下、外部确认后才 stopped”的语义。

治理动作与强停不是一个数据库事务：D1 状态变更先提交，E1 Controller 随后协调真实实例。管理接口不得在编排器尚未确认时宣称资源已经释放。active 恢复不会生成 start 事件，也不会复活旧 route。

## 7. Remote Orchestrator 控制协议

E1 将 RemoteRuntimeDriver 改成无内存权威的协议客户端。每次调用由持久 run/control 数据构造，不再依赖 `instances` Map。

### 7.1 传输与签名

- 仅允许配置的 HTTPS 内网 origin；生产/平台远端模式缺少控制密钥时拒绝启动，不提供默认密钥。
- 请求头包含协议版本、key ID、timestamp、nonce、request ID 和 HMAC-SHA256 signature。
- 规范串固定为 `version\nmethod\npath-and-query\ntimestamp\nnonce\nrequest-id\nsha256(raw-body)`；method 与 path 纳入签名，防止跨端点重放。
- 时间窗口默认 60 秒；编排器按 key ID + nonce 持久或共享去重至少 120 秒。协议支持双 key ID 轮换，不把 key 写入日志。
- 响应也签名并绑定 request ID、HTTP status 和 body hash；平台不接受只对请求认证而无法验证来源的状态变更。

E1 实现签名/验签库与合约测试；真实编排服务、证书发放和 Secret 部署属于后续独立交付。

### 7.2 固定接口

`PUT /v1/runs/{runId}` 为幂等启动：请求包含 agentId、runId、runGeneration、engine 和固定 resourceSpec。编排器用 runId 作为实例幂等键；相同键不同参数返回 409。成功响应只允许 `running`，并回显身份、generation、orchestratorRef、内部 runtimeUrl 和 observedAt。

`POST /v1/runs/{runId}/stop` 为幂等停止：请求包含 agentId、runId、runGeneration、fenceGeneration 和原因码。成功响应只允许 `stopped` 或 `absent`，并回显身份、generation 和 confirmedAt。普通 404 不代替结构化 absent。

`GET /v1/runs/{runId}` 用于结果未知后的 reconciliation，返回匹配身份的 `starting/running/stopping/stopped/absent`。它不能直接发布路由，仍须经过数据库 CAS 提交函数。

所有响应有固定字节上限、总截止时间和字段长度。runtimeUrl 仅允许 `http`/`https`、禁止 userinfo/fragment、必须命中配置的内部主机或 CIDR allowlist；Controller 不跟随重定向，不接受编排器返回任意公网目标。

## 8. 组件与数据流

### 8.1 组件职责

- Runtime control store：封装 PostgreSQL 函数与等价 MemoryStore 状态机。
- Runtime Controller core：领取 Runtime 类型 outbox、调用 driver、提交 CAS 结果、恢复租约和执行治理 reconcile。
- RemoteRuntimeDriver：只负责签名 HTTP 协议、超时、固定 DTO 校验和错误分类；不决定业务状态。
- Orchestrator contract fake：测试内实现幂等 run、强停确认、签名、防重放和故障注入，不接触本机 Docker。
- 现有旧 Worker/LocalDriver：保留 legacy 回归，但平台模式仍拒绝启动；不得成为 E1 平台控制路径。

### 8.2 启动序列

1. 内部调用提交 start，数据库生成 generation G、run R 和 outbox。
2. Controller 领取事件，调用 `PUT /v1/runs/R`。
3. 编排器返回匹配结果，Controller 调用 commit_started。
4. 数据库再次校验治理和 G；匹配才发布 route G，不匹配则入队 stop R。

### 8.3 停止序列

1. stop/治理请求把 control 提升到 G+1，在同一事务撤下 route G，并把 run R 标为 stopping。
2. Controller 调用 `/stop`；超时或失败时 route 仍不可用、run 仍为 stopping。
3. 只有匹配的 stopped/absent 回执才能 commit_stopped；随后清空仍匹配的 active run。
4. 后续新 start 产生 G+2 和新 run；R 的任何迟到回执都不能影响它。

## 9. 安全与故障边界

- API/Controller 不挂载 `docker.sock`，不接收或转发任意容器参数；编排器自行维护 engine 到固定镜像/命令的 allowlist。
- E1 数据面 Boundary 不对公网开放；现有默认 boundary secret 不能用于平台远端控制。后续票据/独立域名接入将另行设计。
- Provider Key 只允许后续以 Secret 引用交给编排器；E1 协议和表中没有 `env` 或明文 key 字段。
- 两个 Controller 可并行，但数据库行锁、唯一代次和 outbox lease 共同保证单一有效结果；外部调用仍按幂等键容忍重复。
- 数据库不可用时不调用编排器，也不基于内存继续执行；编排器不可用时保持持久 desired state 和不发布/已撤下的路由。
- 指标仅暴露事件数量、耗时、状态码枚举、stopping 年龄和 dead 事件数，不包含 Agent 名称、用户身份、URL 或错误正文。

## 10. 测试与验收

### 10.1 单元与合约测试

1. 签名覆盖 method/path/request ID/body，过期、nonce 重放、错误 key、篡改响应全部拒绝。
2. Driver 拒绝重定向、超限响应、非法 URL、普通 404、身份/generation 不匹配和无签名响应。
3. 相同 request ID 相同内容重放，相同 ID 不同内容冲突；重复 start/stop 不创建额外 run 或外部实例。
4. MemoryStore 覆盖全部状态转换、代次围栏、stale callback、stop confirmation 和治理恢复不自动启动。

### 10.2 PostgreSQL 专项

使用一次性测试库，按迁移顺序导入，不读取业务 `.env`：

1. start 原子创建 control/run/outbox；只有匹配 commit 才生成 route。
2. stop 提交即删除 route；超时、500、无效响应、dead 事件均不能把 run 标为 stopped。
3. start 在途时 stop，随后迟到 start success：无 route，并产生/保留补偿 stop。
4. 旧 stop 回执不能清除新 generation 的 active run；旧 start/health 回执不能覆盖新 route。
5. 两个受限连接池并发 start/stop、租约过期和 Controller 重启，最终只有一个有效 run/route。
6. suspended 与 banned 都触发强停；状态读取失败整笔协调回滚；active 恢复不生成 start。
7. 普通应用会话不能直写控制表/outbox，Controller 账号不能读 Better Auth、业务正文或跨职责表。
8. 迁移增量执行和全新库执行都通过，历史 generation=0 运行记录永不成为活动 route。

新增根命令 `npm run test:runtime-control` 运行上述单元、MemoryStore、PostgreSQL 与 fake orchestrator 合约测试；文件级并发受控，测试库和测试 Secret 完成后清理。

### 10.3 回归门槛

- `npm run test:platform`
- `npm run test:governance`
- `npm run test:scheduler`
- `npm test --prefix apps/platform-api`
- 现有平台模式测试继续证明旧 Worker、mock Runtime、Boundary 和用户执行入口被拒绝。

E1 只有在新专项和相关回归全部通过、失败日志脱敏且没有修改业务库/预发后，才能标记“代码完成”。这不等于真实编排器、真实 Provider、资源回收或生产运行已经验收。

## 11. 实施顺序

1. 先以失败测试固定状态机、幂等、代次和 stop confirmation 语义。
2. 实现 MemoryStore 状态机和纯函数 DTO 校验，形成快速反馈。
3. 编写 039 迁移、最小函数授权与 PostgreSQL 双连接并发测试。
4. 实现控制协议签名库、fake orchestrator 和无状态 RemoteRuntimeDriver。
5. 实现 Runtime Controller core、outbox 过滤领取、CAS 提交及治理 reconcile。
6. 运行专项与平台/治理/调度/后端回归，输出脱敏验收记录。
7. 更新 E1 文档与 AGENTS 当前状态；代码提交和推送单独报告。

后续阶段才接入实际 Remote Orchestrator 进程、Secret/证书、真实资源回收、Provider Key、Runtime Boundary 票据和用户侧执行。部署前必须备份目标库、执行 039、创建受限 Controller 账号并让所有控制副本同版升级；不得让忽略 generation 的旧 Worker 与 E1 Controller 混跑。

## 12. 完成口径

E1 完成时可以准确表述为：“真实 Runtime 控制状态机、持久代次围栏、强停确认协议和隔离测试已实现，平台能力仍关闭。”不能表述为“真实 Agent 已上线”“暂停账号已同步释放生产容器”“公网 Runtime 已安全开放”或“常驻预发已部署”。

## 13. 实现补充（2026-10-09）

- 039 实际不依赖 033/038；保留 D1 036/037 及其基础迁移依赖。运行文档编号使用 45，避免与已存在的 44 统一控制台部署记录冲突。
- control 增加 governance_version；回执增加 leaseAttempt、有效租约和固定命令身份验证；start 结果未知且耗尽时持久化 recovery_stop 审计与补偿命令。旧停止未确认前拒绝新启动。
- 使用 D1/D2 的全局治理 changes advisory 共享事务锁，不使用 session 身份锁替代它；锁序与 READ COMMITTED 经真实治理函数双向等待验证。治理协调也先锁 Agent，避免审计外键隐式锁引起反向等待；系统 request UUID 随机生成，防止调用者提前占位导致 stop 丢失。
- 响应 HMAC 额外绑定本次请求 nonce，固定 DTO 不接受覆盖控制器元数据的额外字段；完整请求截止时间涵盖正文，单次最多 25 秒。
- Orchestrator 必须持久化不可复活的 run 终止标记，absent 也不能仅是瞬时查询结果；真实在途 PUT 晚于 stop 确认的场景已在 HTTP fake 验收。
- 资源越界拒绝而非钳制。E1 只传递规格，不实现实际 CPU/内存/PID 限制或 TTL 回收。
- 按实施计划交付单 tick core 与事务内 NOTIFY 提示；没有启动或交付常驻周期/LISTEN 服务、指标 exporter 和生产告警。后续服务须定期调用 tick 并接入 stopping/dead 指标，不能依赖通知确保正确性。
- 本轮 E1 62 项、平台 25 项、治理 15 项、调度 26 项全部通过；后端 235 项中 228 通过、7 个数据库专项跳过、0 失败。E1 数据库测试由独立专项实际执行。业务库和常驻预发未修改。

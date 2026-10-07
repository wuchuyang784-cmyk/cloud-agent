# 第三阶段 D2：账号治理与模拟调度执行闭环

初版：2026-09-29；并发与租约补强：2026-10-06；常驻预发部署验收：2026-10-07。

本批把 D1 的账号治理状态接入第二阶段的模拟调度内核，形成“账号状态变更 -> 调度任务取消 -> 旧 Worker 回执失效”的平台侧闭环。当前仍不接入真实 Agent、模型 API、Provider Key 或真实 Runtime；本批只验证平台控制面和模拟任务生命周期。

## 1. 本批目标与边界

| 范围 | 本批行为 |
| --- | --- |
| `active` 账号 | 可以在模拟调度白名单和平台能力开关允许时提交、领取和完成模拟任务 |
| `suspended` 账号 | 保留登录和本人查询；禁止新的业务写入；已有排队/运行模拟任务取消 |
| `banned` 账号 | 禁止登录并撤销 Better Auth 会话；已有排队/运行模拟任务取消 |
| 解除治理 | 只恢复后续准入，不恢复旧会话、不重试旧任务、不自动启动 Agent |
| 真实 Agent | 未接入 |
| 模型与 Provider Key | 未接入 |
| 生产高并发 | 未验收 |

D2 的“停止运行中任务”是模拟调度层面的状态围栏：任务会进入 `cancelled`，租约和 Worker 归属被清空，旧 Worker 的心跳/完成回执会被拒绝。它不等价于杀死真实容器进程，也不代表已经完成真实 Runtime 的强制停止、资源回收或副作用补偿。

## 2. 实现路径

```text
管理端治理操作
  -> Better Auth 会话 + platform_admin 权限
  -> platform_governance_change 原子更新账号状态/版本/审计
  -> 平台 API 每次请求检查账号准入

模拟调度提交/领取/心跳/完成
  -> TaskStore 在事务内读取账号治理状态
  -> active 且版本一致：允许状态转换
  -> suspended/banned/版本变化：取消任务并拒绝当前操作
  -> 旧 Worker 回执：因治理版本或任务状态不匹配而失效
```

### 2.1 TaskStore 统一状态转换

`MemoryTaskStore` 和 `PostgresTaskStore` 共用同一套领域状态规则：

- 提交任务时读取当前账号状态，并把 `governanceVersion` 写入任务。
- 领取、心跳、完成以及新提交前，先扫描当前活跃任务并协调治理状态。
- 账号不是 `active`，或账号版本与任务创建时不一致时，任务转为 `cancelled`。
- `suspended` 和 `banned` 分别记录 `account_suspended`、`account_banned`；其他版本变化记录 `governance_changed`。
- 取消后的任务不会重新入队，不会因为解除治理而自动执行。
- 用户主动取消继续记录 `user_requested`，与账号治理取消区分。

治理协调统一放在两种 Store 的变更事务入口，并且先于过期租约恢复。即使任务的第三次租约已经到期，也先判断是否需要治理取消；不能先改成 `failed` 后跳过治理检查。治理状态读取失败时整笔变更回滚，不提交部分取消或租约恢复。

PostgreSQL 调度变更使用同一连接和短事务，锁顺序固定为：

1. 取得既有调度决策锁 `734033`。
2. 取得治理共享事务锁，键为 `hashtextextended(format('%I:governance:changes', current_schema()), 0)`，与 036/037 中治理变更函数使用的独占锁一致。
3. 调度变更事务显式使用 `BEGIN ISOLATION LEVEL READ COMMITTED`，在后续语句读取治理状态和任务，持有两把锁直至提交或回滚。不依赖连接的默认隔离级别，避免 `REPEATABLE READ` 固定住锁等待前的旧快照。

治理先持锁时，调度等待治理提交后读取新状态并取消旧任务；调度先持锁时，治理等待该调度事务完成。这样不会出现治理已经提交、随后旧 Worker 却凭此前读到的状态提交成功的竞态。已在治理之前提交完成的任务保留历史终态，不追溯取消。锁仍按现有 5 秒等待上限失败退出，不宣称生产吞吐或高并发容量已验证。

### 2.2 PostgreSQL 受限函数与 RLS

迁移 `packages/db/migrations/038_governance_scheduler.sql`：

- 为 `simulation_tasks` 增加 `governance_version`、`cancel_reason`、`cancelled_at`。
- 为历史 `cancelled` 记录补齐默认取消原因和时间。
- 增加治理版本、取消原因和取消字段一致性约束。
- 增加 `platform_scheduler_account_access(text)`，内部复用 D1 的 `platform_account_access`。
- 撤销该函数对 `PUBLIC` 的执行权限，应用角色只由 DBA 显式授予 `EXECUTE`。

应用数据库账号不应获得超级用户、`BYPASSRLS` 或治理表直读权限。函数授权只解决调度状态读取，不把数据库函数当成应用账号泄漏后的独立认证层。

## 3. API 行为

模拟接口仍受显式开关、测试账号白名单、登录身份、Origin 和个人所有权约束：

- `POST /api/simulation/tasks`：暂停或封禁账号返回 `403`；治理状态不可用返回 `503`。
- `GET /api/simulation/tasks` 和任务明细：继续只返回当前用户自己的任务。
- `POST /api/simulation/tasks/{id}/cancel`：只允许当前用户取消自己的任务。
- 队列达到上限返回 `429`，幂等键内容冲突返回 `409`。
- 跨用户任务和不存在任务统一按不存在处理，不泄露任务是否存在。

平台模式默认关闭模拟调度入口。即使打开模拟入口，也只允许显式白名单账号使用，不能把该接口当成真实 Agent 创建或执行 API。

## 4. Worker 与任务一致性

Worker 不能绕过 Store 直接修改任务。领取、心跳和完成都经过同一套治理围栏：

1. Worker 领取任务时记录当前 Worker、租约和治理版本。
2. 账号被暂停/封禁后，下一次成功提交的调度变更事务会取消该任务并清理租约。只读列表/明细不触发写入；被账号准入拒绝并回滚的提交请求也不持久化取消。没有 Worker 或其他调度变更时，历史查询暂时仍可能看到旧状态。
3. 旧 Worker 再发送心跳或完成回执时，任务状态、租约或治理版本不匹配，回执失败。
4. 任务解除治理后不会自动恢复；如业务未来允许重试，必须由新的、经过准入检查的任务请求显式创建。

该设计避免“界面显示已封禁，但旧 Worker 仍能把任务写成成功”的状态回流问题。

## 5. 验收范围

2026-10-06 本机新增 PostgreSQL D2 专项使用真实数据库、两个受限连接池和真实 `platform_governance_change` 函数，不以内存替身代替数据库状态：

- 无超级用户/`BYPASSRLS`，无治理表直读权限，跨用户任务读取和取消拒绝。
- 暂停和封禁分别取消排队/运行任务，持久化原因、时间并清空租约；拒绝旧 Worker 的心跳、成功及失败回执。
- 解除后不恢复旧任务；旧幂等键仍返回已取消记录，新键创建新版本任务。
- 暂停后立即解除、期间没有调度事务，仍通过版本变化取消旧任务。
- 最后一次租约到期时治理取消优先于重试耗尽。
- 撤销读取函数授权后提交、领取、心跳、完成、取消均拒绝，任务不变；恢复权限后可安全继续。
- 治理先持锁、Worker 先持锁两个并发方向，均以 `pg_blocking_pids` 验证真实阻塞关系，而非固定睡眠推测事务次序；治理先持锁场景还将 Worker 连接默认值设为 `REPEATABLE READ`，确认调度事务仍能读到治理提交后的新状态。

补强前已用红测复现租约次序和两个并发方向的缺陷。补强后 `npm run test:scheduler` 的 26 项检查通过，0 跳过；其中新 PostgreSQL D2 子场景 8 项，MemoryTaskStore 新增 4 项租约/失败回滚回归。原有 PostgreSQL 10 用户/50 任务、双 Store 副本、租约和配额回归继续运行。

测试入口先在一次性数据库的 `public` 初始化 `pgcrypto`，避免并行 schema 迁移争抢数据库级扩展。调度测试文件顺序执行，避免彼此争抢数据库级决策锁；套件内部的双连接池并发与双副本测试保留。

本次数据库专项不等同于双 HTTP API 或 Swarm 多进程治理验收。既有 Swarm 的双 API/双 Worker、隔离和租约恢复报告属于第二阶段模拟调度回归，不能当成这次 D2 并发治理场景的部署证明。10 月 6 日开发轮没有运行 Swarm 或治理浏览器验收，也没有迁移业务库或预发；10 月 7 日常驻预发更新另见第 8 节。

同日回归结果：`test:governance` 15/15、`test:platform` 25/25、`test:preprod:config` 54/54；后端全量 180 通过、0 失败、6 个需要独立数据库环境的入口跳过。其中调度、治理和认证数据库验收已通过上述专项实际执行；管理端及客户端监控数据库专项不属于本次执行范围。独立代码审查无阻塞项。

推荐验证命令：

```powershell
conda run -n cloud --no-capture-output npm run test:scheduler
conda run -n cloud --no-capture-output npm run test:platform
conda run -n cloud --no-capture-output npm run test:governance
conda run -n cloud --no-capture-output npm run test:preprod:config
conda run -n cloud --no-capture-output git diff --check
```

治理浏览器专项仍使用一次性数据库和测试身份；它不读取业务 `.env`，也不修改正式 `bairui`。

## 6. 预发更新步骤

只更新独立预发数据库 `bairui_preprod`，不要修改正式业务库 `bairui`：

1. 停止或置于维护窗口，确认 `preprod:status` 中 API 副本和数据库归属正确。
2. 备份 `bairui_preprod`，保存备份路径和 SHA256。
3. 确认基础迁移、033、034、036、037 已按序执行，再由数据库管理员执行 `038_governance_scheduler.sql`；如果 038 已成功执行，不要重复手工改表。本次并发补强不新增迁移。
4. 用受限应用账号验证新增列、约束、函数和 `EXECUTE` 授权；不授予治理表直读权限。
5. 更新全部 API 和所有可能独立运行的模拟 Worker，使所有调度副本使用同一版本代码；不要混跑未取得治理共享锁的旧 Worker。本平台预发默认不运行模拟 Worker，不为本次升级开启它。
6. 检查 `npm run preprod:status` 和 `npm run monitor:status`，再做一次非生产验收。

本批不更新正式 `bairui`，不启动真实 Agent，不写入模型密钥，也不把本机单节点 Swarm 验收写成生产高可用结论。

## 7. 后续工作

D2 完成后，仍需单独设计和评审：真实 Agent 强停协议、Runtime Boundary 票据校验、容器资源回收、Agent 级配额、运行事件审计、外部告警以及多节点生产部署。这些能力接入前，平台继续保持“真实 Agent 执行关闭”的安全边界。

## 8. 常驻预发部署记录（2026-10-07）

用户授权更新已有常驻预发后，完成备份、部署、故障恢复验收和最终核对；未创建替代安装，也未连接业务 `.env` 或修改 `bairui`。

- 更新前核实 `bairui_preprod` 已具有 038 的三个治理字段、调度和治理函数的最小执行授权、治理表 FORCE RLS；应用角色无超级用户、BYPASSRLS 或治理表直接读取权限。迁移文件指纹与已有安装记录一致，本轮未重跑迁移。
- 更新前备份：`output/preprod/backups/d2-2026-10-06T15-27-15-756Z/bairui_preprod.dump`，173156 字节，SHA256 为 `0e17d927b1e8dcde75dba9ea1617f333e1d0086863527bd691a8b23549fc1954`。已用 `pg_restore --list` 检查归档可读；这是备份校验，不是完整恢复演练。
- 新 API 与网关镜像版本为 `13b3fb4e7579ed38`。双 API 均健康，实际容器内 `src/scheduler/task-store.mjs` 的 SHA256 均为 `5e1120497340e9b6f9b959c5aa44e0d54cb991da11c0df9b17597c25e4858147`，与已通过 D2 专项的本机源码一致。
- 安装身份、迁移指纹、Secret 身份、数据库卷和证书卷创建时间、CA 指纹均与更新前一致。业务容器 `bairui-postgres` 的 ID、启动时间和重启次数未变化。两轮预发验收共保留四名测试用户和两条测试资源，仅位于独立预发库。

部署时实际发现并修复两项运维缺陷：预发与监控入口的顶层等待形成循环导入死锁；完整停止后，旧网关无法重新接入仍存在的 overlay 网络。前者由非阻塞模块求值、保留 CLI keep-alive 和锁清理解决；后者通过先暂停 API、重建无状态网关容器并复用证书卷、读取新 IP 后重新部署 API 解决。均先用失败回归复现，修复后配置回归 59/59、监控配置回归 22/22，独立代码审查无阻塞项。

最终证据：

| 检查 | 结果与记录 |
| --- | --- |
| `npm run test:preprod` | 完整通过；`output/preprod/acceptance-2026-10-07T04-24-24-853Z-7b5d6d.json`，`success: true` |
| HTTPS、账号、隔离 | CA 严格校验、注册/退出/登录、同一会话双 API 可用、RLS、跨用户读写删除 404、伪造代理头拒绝通过 |
| 实际故障恢复 | API 滚动重建、数据库停止时 livez 200 / readyz 503、数据库重建不导致 API 崩溃、完整 stop/up 后原会话与资源仍有效 |
| 部署后核对 | `output/preprod/d2-rollout-20261006.json`，`success: true`；双 API 源码、客户端与管理端 HTML/JS、readyz、权限及原资源保留检查通过 |
| 监控 | 四个服务健康；Grafana 数据库健康；Prometheus 分别发现并成功采集两份 API |

此前失败的 `acceptance-2026-10-07T04-14-56-028Z-648a3c.json` 保留，明确记录网关恢复失败，不能作为通过证明。以上最终成功报告才对应修复后结果。

当前入口为 `https://localhost:8443`，管理端为 `/admin/`，Grafana 为 `https://localhost:9443`；仅本机回环访问，未修改系统 CA 信任。常驻预发继续关闭 Agent 写入/执行及模拟 HTTP 入口，不运行模拟 Worker。本轮验证的是部署、平台隔离和恢复，不是实际 Swarm 多进程 D2 治理或真实 Runtime 执行验收；未重复治理浏览器验收或监控故障告警专项。

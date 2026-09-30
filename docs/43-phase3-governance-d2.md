# 第三阶段 D2：账号治理与模拟调度执行闭环

日期：2026-09-29。

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

PostgreSQL 调度变更使用同一连接和短事务，先取得调度决策锁，再通过受限函数读取账号状态，最后持久化任务变化。这样 API、Worker 和多个副本不会使用各自的内存状态放行过期回执。

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
2. 账号被暂停/封禁后，下一次调度事务会取消该任务并清理租约。
3. 旧 Worker 再发送心跳或完成回执时，任务状态、租约或治理版本不匹配，回执失败。
4. 任务解除治理后不会自动恢复；如业务未来允许重试，必须由新的、经过准入检查的任务请求显式创建。

该设计避免“界面显示已封禁，但旧 Worker 仍能把任务写成成功”的状态回流问题。

## 5. 验收范围

已覆盖以下专项：

- MemoryStore：暂停/封禁阻止提交，取消排队和运行任务，旧 Worker 回执失效，解除后旧任务不重试。
- PostgreSQL：治理状态在调度事务内读取，任务治理版本和取消信息持久化，受限函数授权与双 API 访问通过。
- API：错误状态映射、幂等、队列上限、个人所有权和治理准入通过。
- Swarm：双 API、双 Worker、账号隔离、租约恢复和既有调度回归通过。

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
3. 以数据库管理员按顺序执行 `038_governance_scheduler.sql`；如果 038 已成功执行，不要重复手工改表。
4. 用受限应用账号验证新增列、约束、函数和 `EXECUTE` 授权；不授予治理表直读权限。
5. 重启全部预发 API，使所有副本使用同一版本代码。
6. 检查 `npm run preprod:status` 和 `npm run monitor:status`，再做一次非生产验收。

本批不更新正式 `bairui`，不启动真实 Agent，不写入模型密钥，也不把本机单节点 Swarm 验收写成生产高可用结论。

## 7. 后续工作

D2 完成后，仍需单独设计和评审：真实 Agent 强停协议、Runtime Boundary 票据校验、容器资源回收、Agent 级配额、运行事件审计、外部告警以及多节点生产部署。这些能力接入前，平台继续保持“真实 Agent 执行关闭”的安全边界。

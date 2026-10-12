# D2 账号治理执行闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 D1 的账号状态治理接入模拟调度任务生命周期，使暂停/封禁账号无法新建任务、排队任务被取消、运行中任务停止并阻断重试与旧回执。

**Architecture:** 在现有 `TaskStore` 的状态转换边界统一调用可注入的账号状态读取器。MemoryStore 用治理 Map，PostgreSQL 使用受限 `platform_account_access` 函数并在同一调度事务内复核；治理状态变化本身不删除任务，只通过取消状态和治理版本形成可审计的围栏。Worker 在领取、心跳和完成回执前后都依赖 Store 的 fenced transition，不接入真实 Agent 或模型。

**Tech Stack:** Node.js ESM、PostgreSQL、RLS、现有 Better Auth 治理函数、Node test、Docker Swarm 预发。

**Spec:** D2 用户已确认的聊天设计；`docs/42-dual-console-phase-d1.md` 第 5 节及 `docs/34-phase2-scheduler.md`。

## Global Constraints

- 只使用 Conda `cloud`；测试和脚本通过 `conda run -n cloud --no-capture-output` 执行。
- 不接入真实 Agent、模型 API、Provider Key 或 Runtime。
- 只备份并更新 `bairui_preprod`；正式业务库 `bairui` 不修改。
- 所有任务始终按组织、用户所有权隔离；跨用户访问统一表现为不存在。
- PostgreSQL 应用账号不得获得超级用户、BYPASSRLS 或治理表直读权限；治理状态通过既有受限函数读取。
- 暂停账号可以保留认证和本人查询，但不能提交调度写操作；封禁账号不能继续使用平台。
- 任务取消保留历史记录；旧 Worker 回执必须被拒绝；取消不伪造成功。

---

### Task 1: 领域状态机与 MemoryStore 回归

**Files:**
- Modify: `apps/platform-api/src/scheduler/task-store.mjs`
- Modify: `apps/platform-api/src/scheduler/simulation-worker.mjs`
- Test: `apps/platform-api/test/scheduler.test.mjs`

**Interfaces:**
- `TaskStore` 接收可选 `governance` 适配器，提供 `get(userId) -> {status, version}`。
- `MemoryTaskStore({ clock, governance })` 支持治理状态变更时 `reconcileGovernance(scope)`，将该账号 queued/running 任务标记 `cancelled`。
- `submit`, `claim`, `heartbeat`, `finish` 在任务状态转换点复核 active；失败返回 `account_suspended` 或 `account_banned` 对应的 `TaskError`。

- [ ] 写失败测试：暂停/封禁阻止提交；治理后取消排队和运行任务；旧 Worker 完成回执返回 false；取消任务不再重试。
- [ ] 运行 `node --test apps/platform-api/test/scheduler.test.mjs`，确认新增用例先失败。
- [ ] 实现最小状态转换和 Worker 复核。
- [ ] 重跑该测试并确认通过。

### Task 2: PostgreSQL D2 迁移与 Store

**Files:**
- Create: `packages/db/migrations/038_governance_scheduler.sql`
- Modify: `apps/platform-api/src/scheduler/task-store.mjs`
- Test: `apps/platform-api/test/scheduler-postgres.test.mjs`

**Interfaces:**
- 迁移新增 `simulation_tasks.governance_version`、`cancel_reason`、`cancelled_at`，并保留既有数据兼容。
- 迁移新增受限函数 `platform_scheduler_account_access(text)`，内部调用 `platform_account_access`，应用账号仅获 EXECUTE。
- `PostgresTaskStore` 的 mutation 在调度事务内读取任务所有者治理状态；治理非 active 时取消任务并拒绝提交/领取/心跳/完成。

- [ ] 写 PostgreSQL 迁移静态检查和专项行为测试。
- [ ] 运行专项，确认新行为先失败或迁移列不存在。
- [ ] 编写 038 幂等迁移和函数授权。
- [ ] 接入 PostgresTaskStore 事务逻辑。
- [ ] 重跑 PostgreSQL 专项。

### Task 3: API、Worker 和预发验收

**Files:**
- Modify: `apps/platform-api/src/app.mjs`
- Modify: `apps/platform-api/src/scheduler/worker-index.mjs`
- Modify: `infra/swarm/scheduler-check-entrypoint.mjs`
- Modify: `apps/platform-api/test/scheduler-api.test.mjs`
- Create: `docs/43-phase3-governance-d2.md`

**Interfaces:**
- 模拟任务 API 将调度治理错误映射为 403；账号被暂停后 POST 返回 `account_suspended`，封禁后不暴露资源。
- Worker 不绕过 Store 直接执行；所有领取、心跳、完成均经过治理围栏。
- 文档明确本阶段仍是模拟调度，不是真实 Agent 强停，不更新正式库。

- [ ] 写 API 测试并确认失败。
- [ ] 接入错误映射和治理适配器。
- [ ] 运行 scheduler、governance、platform、preprod 配置测试。
- [ ] 备份 `bairui_preprod`。
- [ ] 执行 038 迁移并验证列、函数、授权。
- [ ] 重启预发 API/Worker（平台模式仍默认关闭模拟入口）。
- [ ] 运行监控与预发状态核验，记录 D2 验收报告。

### Task 4: 完整验证与交付

- [ ] `npm run test:scheduler`
- [ ] `npm run test:platform`
- [ ] `npm run test:governance`
- [ ] `npm run test:preprod:config`
- [ ] `npm run monitor:status`
- [ ] `npm run preprod:status`
- [ ] `git diff --check` 和工作区改动审阅
- [ ] 中文说明实现路径、预发更新结果和边界

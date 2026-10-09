# E1 Runtime Control Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现不开放用户执行入口的真实 Runtime 控制安全底座，包括持久代次围栏、幂等启停、强停确认、签名编排协议和账号治理强停。

**Architecture:** 复用 `control_outbox` 作为命令队列，以新增的 Runtime control/run 数据作为权威状态；Memory 与 PostgreSQL 适配器实现同一接口。无状态 RemoteRuntimeDriver 只处理签名 HTTP 合约，Runtime Controller 负责领取命令并通过数据库 CAS 提交结果。

**Tech Stack:** Node.js ESM、`node:test`、PostgreSQL 17、`pg`、HMAC-SHA256、现有 MemoryStore/Postgres 测试基础设施。

---

## 执行状态（2026-10-09）

按批准的单 tick 实施范围完成代码、本机验收、复核修复与本地提交：E1 62 项、平台 25 项、治理 15 项、调度 26 项通过；后端 228 通过、7 项数据库专项跳过、0 失败。收尾代码提交 `320574e`；保留当前开发分支，不部署、不推送。

实施补强包括治理版本、attempt 租约围栏、响应 nonce 绑定、全正文超时、不可复活的 stop 终止标记、启动耗尽补偿停止、READ COMMITTED 和旧 Worker 命令过滤。复核另修复审计外键隐式锁导致的死锁与可预测系统 request UUID 被调用者预占导致的 stop 丢失，并新增三项回归。下方代码块保留原计划草案，最终接口/函数签名、授权与边界以 `docs/45-e1-runtime-control-safety.md` 和源码为准；039 不依赖 033/038。

## 文件结构

- Create `apps/platform-api/src/runtime/control-contract.mjs`：固定资源规格、命令和编排器响应 DTO 校验。
- Create `apps/platform-api/src/runtime/control-envelope.mjs`：控制面请求/响应签名、时效和 nonce 防重放。
- Create `apps/platform-api/src/runtime/control-store.mjs`：MemoryRuntimeControlStore 及统一结果结构。
- Create `apps/platform-api/src/runtime/postgres-control-store.mjs`：只调用 039 受限函数的 PostgreSQL 适配器。
- Create `apps/platform-api/src/runtime/controller.mjs`：单 tick 命令消费、CAS 提交和治理协调。
- Modify `apps/platform-api/src/runtime/orchestration/remote-driver.mjs`：改为无内存权威的 v1 编排器客户端。
- Modify `apps/platform-api/src/runtime/orchestration/index.mjs`：导出控制协议所需类型。
- Create `packages/db/migrations/039_runtime_control_fencing.sql`：控制状态、幂等审计、代次、受限函数与授权边界。
- Create `apps/platform-api/test/helpers/fake-runtime-orchestrator.mjs`：签名、幂等和故障注入的测试编排器。
- Create `apps/platform-api/test/runtime-control-contract.test.mjs`：固定 DTO 和资源边界。
- Create `apps/platform-api/test/runtime-control-envelope.test.mjs`：签名、时效、防重放和篡改。
- Create `apps/platform-api/test/runtime-control-memory.test.mjs`：Memory 状态机与 stale callback。
- Modify `apps/platform-api/test/runtime-driver.test.mjs`：新 RemoteRuntimeDriver 合约和旧 local 回归。
- Create `apps/platform-api/test/runtime-controller.test.mjs`：Controller 与 fake orchestrator 集成。
- Create `apps/platform-api/test/runtime-control-postgres.test.mjs`：一次性 PostgreSQL、双连接并发、RLS 和治理强停。
- Create `scripts/test-runtime-control.mjs`：独立测试库入口，不读取业务 `.env`。
- Modify `package.json`：增加 `test:runtime-control`。
- Create `docs/45-e1-runtime-control-safety.md`：中文边界、运行方式、迁移和验收记录模板。
- Modify `AGENTS.md`：验收完成后更新当前 E1 状态，明确未部署边界。

### Task 1: 固定控制 DTO 与资源边界

**Files:**
- Create: `apps/platform-api/test/runtime-control-contract.test.mjs`
- Create: `apps/platform-api/src/runtime/control-contract.mjs`

- [x] **Step 1: 写资源规格和响应校验的失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeResourceSpec,
  parseStartConfirmation,
  parseInspection,
  parseStopConfirmation,
} from '../src/runtime/control-contract.mjs';

test('resource spec 只保留四个有界整数', () => {
  assert.deepEqual(normalizeResourceSpec({
    cpuMillis: 500,
    memoryBytes: 536870912,
    pidsLimit: 64,
    idleTtlSeconds: 900,
  }), { cpuMillis: 500, memoryBytes: 536870912, pidsLimit: 64, idleTtlSeconds: 900 });
  assert.throws(() => normalizeResourceSpec({ cpuMillis: 99, memoryBytes: 536870912, pidsLimit: 64, idleTtlSeconds: 900 }), /resource_spec_invalid/);
  assert.throws(() => normalizeResourceSpec({ cpuMillis: 500, memoryBytes: 536870912, pidsLimit: 64, idleTtlSeconds: 900, env: {} }), /resource_spec_invalid/);
});

test('stop 只接受身份完全匹配的 stopped 或 absent', () => {
  const expected = { agentId: 'a1', runId: 'r1', runGeneration: 3 };
  assert.equal(parseStopConfirmation({ ...expected, status: 'absent', confirmedAt: '2026-10-08T00:00:00.000Z' }, expected).status, 'absent');
  assert.throws(() => parseStopConfirmation({ ...expected, runGeneration: 2, status: 'stopped' }, expected), /orchestrator_identity_mismatch/);
  assert.throws(() => parseStopConfirmation({ ...expected, status: 'running' }, expected), /orchestrator_bad_response/);
});

test('inspect 只接受固定状态和匹配身份', () => {
  const expected = { agentId: 'a1', runId: 'r1', runGeneration: 3 };
  assert.equal(parseInspection({ ...expected, status: 'stopping', observedAt: '2026-10-08T00:00:00.000Z' }, expected).status, 'stopping');
  assert.throws(() => parseInspection({ ...expected, status: 'unknown' }, expected), /orchestrator_bad_response/);
});
```

- [x] **Step 2: 运行测试并确认因模块缺失失败**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-contract.test.mjs`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [x] **Step 3: 实现固定 DTO 校验**

```js
const RESOURCE_KEYS = ['cpuMillis', 'memoryBytes', 'pidsLimit', 'idleTtlSeconds'];
const LIMITS = {
  cpuMillis: [100, 8000], memoryBytes: [134217728, 17179869184],
  pidsLimit: [16, 1024], idleTtlSeconds: [60, 86400],
};

export function normalizeResourceSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !RESOURCE_KEYS.includes(key))) throw new Error('resource_spec_invalid');
  const result = {};
  for (const key of RESOURCE_KEYS) {
    const number = value[key], [min, max] = LIMITS[key];
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('resource_spec_invalid');
    result[key] = number;
  }
  return result;
}

export function parseStartConfirmation(value, expected) {
  assertIdentity(value, expected);
  if (value.status !== 'running' || typeof value.orchestratorRef !== 'string'
    || typeof value.runtimeUrl !== 'string' || !validIso(value.observedAt)) throw new Error('orchestrator_bad_response');
  return { ...value };
}

export function parseStopConfirmation(value, expected) {
  assertIdentity(value, expected);
  if (!['stopped', 'absent'].includes(value.status) || !validIso(value.confirmedAt)) throw new Error('orchestrator_bad_response');
  return { ...value };
}
export function parseInspection(value, expected) {
  assertIdentity(value, expected);
  if (!['starting', 'running', 'stopping', 'stopped', 'absent'].includes(value.status)
    || !validIso(value.observedAt)) throw new Error('orchestrator_bad_response');
  return { ...value };
}
```

实现同文件私有 `assertIdentity` 与 `validIso`，并增加测试覆盖 engine 只允许 `pi/dsh`、ID/原因长度、非法 URL 字段不被静默接受。

- [x] **Step 4: 运行测试确认通过**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-contract.test.mjs`

Expected: PASS，0 failed。

- [x] **Step 5: 提交**

```powershell
git add apps/platform-api/src/runtime/control-contract.mjs apps/platform-api/test/runtime-control-contract.test.mjs
git commit -m "feat: define runtime control contracts"
```

### Task 2: 实现 Memory Runtime 控制状态机

**Files:**
- Create: `apps/platform-api/test/runtime-control-memory.test.mjs`
- Create: `apps/platform-api/src/runtime/control-store.mjs`

- [x] **Step 1: 写 start/stop/迟到回执的失败测试**

```js
const store = new MemoryRuntimeControlStore({ agents: [{
  id: 'a1', organizationId: 'o1', ownerUserId: 'u1', engine: 'pi', templateVersion: 1,
}], governance: [{ userId: 'u1', status: 'active', version: 0 }] });
const started = await store.requestStart({ actorUserId: 'u1', agentId: 'a1', requestId: '00000000-0000-4000-8000-000000000001', expectedGeneration: 0, resourceSpec });
assert.equal(started.generation, 1);
assert.equal((await store.claimCommands('w1', 10))[0].eventType, 'runtime.start.requested');
const stopped = await store.requestStop({ actorUserId: 'u1', agentId: 'a1', requestId: '00000000-0000-4000-8000-000000000002', expectedGeneration: 1, reason: 'manual stop' });
assert.equal(stopped.generation, 2);
assert.equal(store.route('a1'), null);
const stale = await store.commitStarted({ workerId: 'w1', requestId: started.commandRequestId, agentId: 'a1', runId: started.runId, runGeneration: 1, orchestratorRef: 'ref-1', runtimeUrl: 'http://runtime.internal:8092' });
assert.equal(stale.result, 'stale_stop_enqueued');
assert.equal(store.route('a1'), null);
```

增加独立测试覆盖：相同 request 重放、request 内容冲突、expected generation 冲突、同态 start no-op、stop 未确认保持 stopping、旧 stop 不能清除新 run、inactive 账号拒绝 start、active 恢复不自动 start。

- [x] **Step 2: 运行并确认因导出缺失失败**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-memory.test.mjs`

Expected: FAIL，错误指向 `MemoryRuntimeControlStore` 缺失。

- [x] **Step 3: 实现统一 Memory 接口**

```js
export class MemoryRuntimeControlStore {
  constructor(seed = {}) {
    this.agents = new Map((seed.agents ?? []).map(row => [row.id, structuredClone(row)]));
    this.governance = new Map((seed.governance ?? []).map(row => [row.userId, structuredClone(row)]));
    this.controls = new Map(); this.runs = new Map(); this.requests = new Map();
    this.routes = new Map(); this.commands = []; this.locks = new Map();
  }
  requestStart(input) { return this.#withAgentLock(input.agentId, () => this.#requestStart(input)); }
  requestStop(input) { return this.#withAgentLock(input.agentId, () => this.#requestStop(input)); }
  commitStarted(input) { return this.#withAgentLock(input.agentId, () => this.#commitStarted(input)); }
  commitStopped(input) { return this.#withAgentLock(input.agentId, () => this.#commitStopped(input)); }
  claimCommands(workerId, limit = 10) {
    const now = Date.now();
    const rows = this.commands.filter(row => row.eventType.startsWith('runtime.')
      && (row.status === 'queued' || (row.status === 'leased' && row.leaseUntil < now)))
      .sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
    for (const row of rows) { row.status = 'leased'; row.leasedBy = workerId; row.leaseUntil = now + 60_000; row.attempts += 1; }
    return structuredClone(rows);
  }
  completeCommand({ workerId, commandId, status, errorCode = null }) {
    const row = this.commands.find(item => item.id === commandId && item.leasedBy === workerId);
    if (!row) return false;
    row.status = status === 'failed' ? 'queued' : status;
    row.availableAt = status === 'failed' ? Date.now() + Math.min(30_000, 250 * (2 ** row.attempts)) : row.availableAt;
    row.leasedBy = null; row.leaseUntil = null; row.lastError = errorCode;
    return true;
  }
  async reconcileGovernance({ limit = 10 }) {
    const targets = [...this.controls.values()].filter(control => control.desiredState === 'running'
      && ['suspended', 'banned'].includes(this.governance.get(control.ownerUserId)?.status))
      .sort((a, b) => a.ownerUserId.localeCompare(b.ownerUserId) || a.agentId.localeCompare(b.agentId)).slice(0, limit);
    for (const control of targets) await this.#requestGovernanceStop(control);
    return { stopped: targets.length, started: 0 };
  }
}
```

实现私有 `#requestStart/#requestStop/#requestGovernanceStop/#commitStarted/#commitStopped/#withAgentLock`：使用 `crypto.randomUUID()` 生成 run/command ID，请求摘要由键排序后的规范化 JSON 生成。所有状态转换返回固定 `{ result, generation, runId, replayed, commandRequestId }`，错误使用稳定 code；每个私有转换分别由本任务列出的测试先覆盖再写代码。

- [x] **Step 4: 运行 Memory 测试确认通过**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-contract.test.mjs apps/platform-api/test/runtime-control-memory.test.mjs`

Expected: PASS，0 failed。

- [x] **Step 5: 提交**

```powershell
git add apps/platform-api/src/runtime/control-store.mjs apps/platform-api/test/runtime-control-memory.test.mjs
git commit -m "feat: add fenced memory runtime control"
```

### Task 3: 新增 039 数据结构、RLS 与 PostgreSQL 状态机

**Files:**
- Create: `apps/platform-api/test/runtime-control-postgres.test.mjs`
- Create: `packages/db/migrations/039_runtime_control_fencing.sql`
- Create: `apps/platform-api/src/runtime/postgres-control-store.mjs`

- [x] **Step 1: 写 PostgreSQL 失败测试 fixture**

测试创建独立 schema 和 `runtime_app_*`、`runtime_controller_*` 两个 `NOLOGIN NOSUPERUSER NOBYPASSRLS` 角色，按文件名顺序导入 001–039，分别只授 request/read 函数和 claim/commit/reconcile 函数。写入用户、组织、pi Agent 后断言：

```js
const appStore = new PostgresRuntimeControlStore({ pool: appPool, role: 'app' });
const controllerStore = new PostgresRuntimeControlStore({ pool: controllerPool, role: 'controller' });
const start = await appStore.requestStart({ actorUserId, agentId, requestId: randomUUID(), expectedGeneration: 0, resourceSpec });
assert.equal(start.generation, 1);
const [command] = await controllerStore.claimCommands('controller-a', 10);
assert.equal(command.eventType, 'runtime.start.requested');
await controllerStore.commitStarted({ workerId: 'controller-a', requestId: command.requestId, agentId, runId: start.runId, runGeneration: 1, orchestratorRef: 'ref-1', runtimeUrl: 'http://runtime.internal:8092' });
assert.equal((await elevated.query('SELECT route_version FROM runtime_routes WHERE agent_id=$1', [agentId])).rows[0].route_version, '1');
```

同文件先加入迁移增量/重复执行、generation=0 历史多行、直接表写拒绝、request replay/conflict、stop 先删 route、stale start 补偿 stop、旧 stop 不清新 run、两个连接并发、租约恢复的测试。

- [x] **Step 2: 运行测试确认 039 缺失导致失败**

Run: `conda run -n cloud --no-capture-output node --test --test-concurrency=1 apps/platform-api/test/runtime-control-postgres.test.mjs`

Expected: FAIL，错误显示 `039_runtime_control_fencing.sql` 或目标函数不存在。

- [x] **Step 3: 编写 039 表结构和约束**

迁移使用单事务，核心结构固定为：

```sql
CREATE TABLE agent_runtime_controls (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  desired_state text NOT NULL CHECK (desired_state IN ('running','stopped')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  active_run_id text,
  cpu_millis integer NOT NULL CHECK (cpu_millis BETWEEN 100 AND 8000),
  memory_bytes bigint NOT NULL CHECK (memory_bytes BETWEEN 134217728 AND 17179869184),
  pids_limit integer NOT NULL CHECK (pids_limit BETWEEN 16 AND 1024),
  idle_ttl_seconds integer NOT NULL CHECK (idle_ttl_seconds BETWEEN 60 AND 86400),
  last_request_id uuid, changed_by text REFERENCES users(id) ON DELETE SET NULL,
  change_reason text NOT NULL CHECK (length(change_reason) BETWEEN 1 AND 500 AND change_reason !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_runtime_control_requests (
  request_id uuid PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('start','stop','governance_stop')),
  request_hash text NOT NULL, expected_generation bigint NOT NULL,
  result_generation bigint NOT NULL, result_code text NOT NULL, run_id text,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agent_engine_runs ADD COLUMN IF NOT EXISTS run_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_engine_runs ADD COLUMN IF NOT EXISTS stop_reason text;
ALTER TABLE agent_engine_runs ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz;
ALTER TABLE agent_engine_runs ADD COLUMN IF NOT EXISTS stop_confirmed_at timestamptz;
ALTER TABLE agent_engine_runs ADD COLUMN IF NOT EXISTS last_command_request_id uuid;
CREATE UNIQUE INDEX agent_engine_runs_generation_uidx ON agent_engine_runs(agent_id,run_generation) WHERE run_generation > 0;
ALTER TABLE control_outbox ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX control_outbox_request_uidx ON control_outbox(request_id) WHERE request_id IS NOT NULL;
```

用 catalog 查找并替换 `agent_engine_runs.status` CHECK，使其精确允许 `stopping`；迁移第二次运行不得改变函数 owner/ACL 或历史数据。新增 active_run 外键时使用 `DEFERRABLE INITIALLY DEFERRED`，并验证 run 属于同一 Agent。

- [x] **Step 4: 实现七个受限数据库函数**

函数签名固定为：

```sql
runtime_control_request_start(text,text,uuid,bigint,integer,bigint,integer,integer) RETURNS jsonb
runtime_control_request_stop(text,text,uuid,bigint,text) RETURNS jsonb
runtime_control_claim(text,integer) RETURNS SETOF control_outbox
runtime_control_complete(text,uuid,text,text) RETURNS boolean
runtime_control_commit_started(text,uuid,text,text,bigint,text,text) RETURNS jsonb
runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz) RETURNS jsonb
runtime_control_reconcile_governance(text,integer) RETURNS jsonb
```

全部使用 `SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off`，通过 `%I` 固定迁移 schema；撤销 PUBLIC EXECUTE。request 函数先取用户治理 advisory lock，再锁 Agent/control；commit 使用 Agent control 行锁与 generation CAS；claim 只选 `event_type LIKE 'runtime.%'`；complete 只更新同 worker 持有的租约。reconcile 按 owner/agent 稳定顺序，对 suspended/banned 运行项执行一次 generation 提升、route 删除和 stop 入队。

- [x] **Step 5: 实现 PostgreSQL 薄适配器**

```js
export class PostgresRuntimeControlStore {
  constructor({ pool }) { this.pool = pool; }
  requestStart(input) { return this.#json('runtime_control_request_start', [input.actorUserId, input.agentId, input.requestId, input.expectedGeneration, input.resourceSpec.cpuMillis, input.resourceSpec.memoryBytes, input.resourceSpec.pidsLimit, input.resourceSpec.idleTtlSeconds]); }
  requestStop(input) { return this.#json('runtime_control_request_stop', [input.actorUserId, input.agentId, input.requestId, input.expectedGeneration, input.reason]); }
  async claimCommands(workerId, limit) { return (await this.pool.query('SELECT * FROM runtime_control_claim($1,$2)', [workerId, limit])).rows; }
  async completeCommand({ workerId, commandId, status, errorCode = null }) { return (await this.pool.query('SELECT runtime_control_complete($1,$2,$3,$4) ok', [workerId, commandId, status, errorCode])).rows[0].ok; }
  commitStarted(input) { return this.#json('runtime_control_commit_started', [input.workerId, input.requestId, input.agentId, input.runId, input.runGeneration, input.orchestratorRef, input.runtimeUrl]); }
  commitStopped(input) { return this.#json('runtime_control_commit_stopped', [input.workerId, input.requestId, input.agentId, input.runId, input.runGeneration, input.fenceGeneration, input.status, input.confirmedAt]); }
  reconcileGovernance({ workerId, limit }) { return this.#json('runtime_control_reconcile_governance', [workerId, limit]); }
  async #json(functionName, values) {
    const parameters = values.map((_, index) => `$${index + 1}`).join(',');
    try { return (await this.pool.query(`SELECT ${functionName}(${parameters}) result`, values)).rows[0].result; }
    catch (error) { throw new RuntimeControlError(safeDatabaseCode(error)); }
  }
}
```

`functionName` 只来自类内固定字符串，不接收调用方输入。`safeDatabaseCode` 将已知 SQLSTATE/函数错误映射为稳定 code，其他错误统一为 `runtime_control_unavailable`；`RuntimeControlError` 不附带 SQL、原始 detail 或连接信息。

- [x] **Step 6: 运行 PostgreSQL 专项确认通过**

Run: `conda run -n cloud --no-capture-output node --test --test-concurrency=1 apps/platform-api/test/runtime-control-postgres.test.mjs`

Expected: PASS，0 failed；测试结束删除 schema 和临时角色。

- [x] **Step 7: 提交**

```powershell
git add packages/db/migrations/039_runtime_control_fencing.sql apps/platform-api/src/runtime/postgres-control-store.mjs apps/platform-api/test/runtime-control-postgres.test.mjs
git commit -m "feat: persist fenced runtime control"
```

### Task 4: 实现控制面双向签名

**Files:**
- Create: `apps/platform-api/test/runtime-control-envelope.test.mjs`
- Create: `apps/platform-api/src/runtime/control-envelope.mjs`

- [x] **Step 1: 写请求/响应签名失败测试**

```js
const signed = signControlRequest({ method: 'PUT', path: '/v1/runs/r1', body, requestId, keyId: 'k1', secret, now: 1_800_000_000_000, nonce: 'nonce-1' });
assert.equal(verifyControlRequest({ method: 'PUT', path: '/v1/runs/r1', body, headers: signed, keys: { k1: secret }, now: 1_800_000_000_100, nonceStore }).requestId, requestId);
assert.throws(() => verifyControlRequest({ method: 'POST', path: '/v1/runs/r1', body, headers: signed, keys: { k1: secret }, now: 1_800_000_000_100, nonceStore }), /control_signature_invalid/);
assert.throws(() => verifyControlRequest({ method: 'PUT', path: '/v1/runs/r1', body, headers: signed, keys: { k1: secret }, now: 1_800_000_000_100, nonceStore }), /control_nonce_replayed/);
```

增加 response status/body/request ID 绑定、61 秒过期、未知 key ID、body 篡改、双 key 轮换测试。

- [x] **Step 2: 运行并确认模块缺失失败**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-envelope.test.mjs`

Expected: FAIL，`ERR_MODULE_NOT_FOUND`。

- [x] **Step 3: 实现 canonical HMAC 与 nonce store 接口**

```js
export function canonicalRequest({ version = 'v1', method, path, timestamp, nonce, requestId, body }) {
  return [version, method.toUpperCase(), path, timestamp, nonce, requestId, sha256(body)].join('\n');
}
export function canonicalResponse({ version = 'v1', status, requestId, body }) {
  return [version, String(status), requestId, sha256(body)].join('\n');
}
export function signControlRequest(input) {
  const timestamp = String(input.now), canonical = canonicalRequest({ ...input, timestamp });
  return { 'x-bairui-control-version': 'v1', 'x-bairui-control-key-id': input.keyId,
    'x-bairui-control-timestamp': timestamp, 'x-bairui-control-nonce': input.nonce,
    'x-bairui-control-request-id': input.requestId,
    'x-bairui-control-signature': hmac(input.secret, canonical) };
}
export function verifyControlRequest(input) {
  const metadata = requestMetadata(input.headers);
  if (Math.abs(input.now - Number(metadata.timestamp)) > 60_000) throw new Error('control_signature_expired');
  verifyMac(input.keys[metadata.keyId], canonicalRequest({ ...input, ...metadata }), metadata.signature);
  if (!input.nonceStore.consume(metadata.keyId, metadata.nonce, Number(metadata.timestamp) + 120_000)) throw new Error('control_nonce_replayed');
  return metadata;
}
export function signControlResponse(input) {
  return { 'x-bairui-control-key-id': input.keyId, 'x-bairui-control-request-id': input.requestId,
    'x-bairui-control-response-signature': hmac(input.secret, canonicalResponse(input)) };
}
export function verifyControlResponse(input) {
  const metadata = responseMetadata(input.headers);
  if (metadata.requestId !== input.requestId) throw new Error('control_response_mismatch');
  verifyMac(input.keys[metadata.keyId], canonicalResponse({ ...input, requestId: metadata.requestId }), metadata.signature);
  return metadata;
}
```

同文件实现 `sha256/hmac/verifyMac/requestMetadata/responseMetadata`，其中 `verifyMac` 先检查十六进制长度再调用 `timingSafeEqual`。nonce store 只依赖 `consume(keyId, nonce, expiresAt)`，测试使用 Map；不在此模块加入网络或业务状态。

- [x] **Step 4: 运行测试确认通过**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-envelope.test.mjs`

Expected: PASS，0 failed。

- [x] **Step 5: 提交**

```powershell
git add apps/platform-api/src/runtime/control-envelope.mjs apps/platform-api/test/runtime-control-envelope.test.mjs
git commit -m "feat: sign runtime control protocol"
```

### Task 5: 将 RemoteRuntimeDriver 改为无状态强确认客户端

**Files:**
- Modify: `apps/platform-api/test/runtime-driver.test.mjs`
- Modify: `apps/platform-api/src/runtime/orchestration/remote-driver.mjs`
- Modify: `apps/platform-api/src/runtime/orchestration/index.mjs`

- [x] **Step 1: 替换旧远端驱动测试并确认失败**

测试构造已签名 fake response，断言请求为 `PUT /v1/runs/{runId}`、body 无 `env`，并覆盖：缺 HTTPS（测试显式允许的 `.test` origin 除外）、缺 key、重定向、超时、超限、未签名、身份错配、普通 404 stop 均失败；结构化 signed absent 才成功。另断言 `inspect` 使用 `GET /v1/runs/{runId}`，只返回身份匹配的 `starting/running/stopping/stopped/absent`。

```js
const result = await driver.provision({
  agentId: 'a1', runId: 'r1', runGeneration: 1, engine: 'pi', requestId, resourceSpec,
});
assert.equal(result.status, 'running');
assert.equal(requests[0].method, 'PUT');
assert.equal(JSON.parse(requests[0].body).env, undefined);
await assert.rejects(() => driver.stop({ agentId: 'a1', runId: 'r1', runGeneration: 1, fenceGeneration: 2, requestId: stopId, reason: 'manual' }), /stop_not_confirmed/);
```

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-driver.test.mjs`

Expected: FAIL，旧 driver 仍调用 `/instances` 或接受不安全 stop。

- [x] **Step 2: 实现无状态 v1 客户端**

```js
async provision(spec) {
  const body = JSON.stringify(buildStartRequest(spec));
  const response = await this.#request({ method: 'PUT', path: `/v1/runs/${encodeURIComponent(spec.runId)}`, requestId: spec.requestId, body });
  return parseStartConfirmation(response.body, spec);
}
async stop(spec) {
  const body = JSON.stringify(buildStopRequest(spec));
  const response = await this.#request({ method: 'POST', path: `/v1/runs/${encodeURIComponent(spec.runId)}/stop`, requestId: spec.requestId, body });
  if (!response.ok) throw new RuntimeDriverError('stop_not_confirmed', `HTTP ${response.status}`);
  return parseStopConfirmation(response.body, spec);
}
async inspect(spec) {
  const response = await this.#request({ method: 'GET', path: `/v1/runs/${encodeURIComponent(spec.runId)}`, requestId: spec.requestId, body: '' });
  return parseInspection(response.body, spec);
}
```

删除 remote 路径对 `this.instances`、`waitHealthy`、`route` 的依赖；构造器要求 URL、key ID、secret，配置绝对截止时间、最大响应字节、`redirect:'error'`，并验证响应签名和内部 URL allowlist。`canRun()` 对缺任一强制项返回 fail-closed 原因。

- [x] **Step 3: 运行 driver 与协议测试确认通过**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-contract.test.mjs apps/platform-api/test/runtime-control-envelope.test.mjs apps/platform-api/test/runtime-driver.test.mjs`

Expected: PASS；旧 LocalProcessDriver 回归继续通过。

- [x] **Step 4: 提交**

```powershell
git add apps/platform-api/src/runtime/orchestration/remote-driver.mjs apps/platform-api/src/runtime/orchestration/index.mjs apps/platform-api/test/runtime-driver.test.mjs
git commit -m "feat: harden remote runtime driver"
```

### Task 6: 实现 Runtime Controller 与补偿停止

**Files:**
- Create: `apps/platform-api/test/helpers/fake-runtime-orchestrator.mjs`
- Create: `apps/platform-api/test/runtime-controller.test.mjs`
- Create: `apps/platform-api/src/runtime/controller.mjs`

- [x] **Step 1: 写 Controller 失败测试**

使用 Memory store + fake orchestrator，覆盖 happy path、start 在途被 stop、start/stop 结果未知时调用 inspect 收敛、stop 500/timeout、租约重放、dead 保持 stopping 和未知事件不被领取。

```js
const controller = new RuntimeController({ store, driver, workerId: 'controller-a', maxAttempts: 3 });
await controller.tick();
assert.equal(store.route('a1').routeVersion, 1);
orchestrator.failStopWith(503);
await store.requestStop(stopInput);
await controller.tick();
assert.equal(store.run(start.runId).status, 'stopping');
assert.equal(store.route('a1'), null);
```

- [x] **Step 2: 运行并确认 Controller 缺失失败**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-controller.test.mjs`

Expected: FAIL，`RuntimeController` 模块不存在。

- [x] **Step 3: 实现单 tick 控制器**

```js
export class RuntimeController {
  constructor({ store, driver, workerId, batchSize = 10, maxAttempts = 8 }) { Object.assign(this, { store, driver, workerId, batchSize, maxAttempts }); }
  async tick() {
    await this.store.reconcileGovernance({ workerId: this.workerId, limit: this.batchSize });
    const commands = await this.store.claimCommands(this.workerId, this.batchSize);
    for (const command of commands) await this.#handle(command);
  }
  async #handle(command) {
    try {
      const result = command.eventType === 'runtime.start.requested'
        ? await this.driver.provision(command.payload)
        : await this.driver.stop(command.payload);
      if (command.eventType === 'runtime.start.requested') await this.store.commitStarted({ workerId: this.workerId, requestId: command.requestId, ...command.payload, ...result });
      else await this.store.commitStopped({ workerId: this.workerId, requestId: command.requestId, ...command.payload, ...result });
      await this.store.completeCommand({ workerId: this.workerId, commandId: command.id, status: 'succeeded' });
    } catch (error) {
      if (error.code === 'orchestrator_result_unknown') {
        const observed = await this.driver.inspect(command.payload);
        const settled = await this.#commitObserved(command, observed);
        if (settled) return;
      }
      const status = command.attempts >= this.maxAttempts ? 'dead' : 'failed';
      await this.store.completeCommand({ workerId: this.workerId, commandId: command.id, status, errorCode: safeRuntimeErrorCode(error) });
    }
  }
}
```

`#commitObserved` 对 start+running 走 commitStarted，对 stop+stopped/absent 走 commitStopped；其他观察状态返回 false 并进入重试。`failed` 命令按 store 固定退避重新入队；dead 保持状态并计数。处理 start 成功但 CAS stale 时，store 原子确保补偿 stop 已存在。控制器只记录稳定 error code。

- [x] **Step 4: 运行 Controller/Memory 测试确认通过**

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-memory.test.mjs apps/platform-api/test/runtime-controller.test.mjs`

Expected: PASS，0 failed。

- [x] **Step 5: 提交**

```powershell
git add apps/platform-api/src/runtime/controller.mjs apps/platform-api/test/helpers/fake-runtime-orchestrator.mjs apps/platform-api/test/runtime-controller.test.mjs apps/platform-api/src/runtime/control-store.mjs
git commit -m "feat: process runtime control commands"
```

### Task 7: 验证治理强停、双连接并发与最小权限

**Files:**
- Modify: `apps/platform-api/test/runtime-control-postgres.test.mjs`
- Modify: `packages/db/migrations/039_runtime_control_fencing.sql`
- Modify: `apps/platform-api/src/runtime/postgres-control-store.mjs`

- [x] **Step 1: 增加治理与竞态失败测试**

```js
await elevated.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES($1,'suspended',1)", [ownerUserId]);
const reconciled = await controllerStore.reconcileGovernance({ workerId: 'controller-b', limit: 20 });
assert.equal(reconciled.stopped, 1);
assert.equal((await elevated.query('SELECT count(*)::int n FROM runtime_routes WHERE agent_id=$1', [agentId])).rows[0].n, 0);
assert.equal((await elevated.query('SELECT status FROM agent_engine_runs WHERE id=$1', [runId])).rows[0].status, 'stopping');
await elevated.query("UPDATE platform_account_governance SET status='active',version=2 WHERE user_id=$1", [ownerUserId]);
assert.equal((await controllerStore.reconcileGovernance({ workerId: 'controller-b', limit: 20 })).started, 0);
```

两个连接池并发执行 start/stop，断言 generation 单调、唯一 run、旧回执无路由；撤销治理读取函数时 reconcile 整笔失败且 control/route/outbox 无部分更新。普通 app role 对新表 SELECT/INSERT/UPDATE/DELETE 均为 42501，controller role 不能读取 `ba_session` 和资源正文。

再用专用连接 `LISTEN bairui_runtime_governance`，提交 suspended/banned 变更后断言只收到目标内部 user ID；事务回滚不得发出通知。该通知只是即时 tick 提示，周期 reconcile 仍是正确性来源。

- [x] **Step 2: 运行并观察至少一个预期失败**

Run: `conda run -n cloud --no-capture-output node --test --test-concurrency=1 apps/platform-api/test/runtime-control-postgres.test.mjs`

Expected: FAIL 于缺少治理协调、锁顺序或授权断言之一。

- [x] **Step 3: 完成数据库锁顺序、回滚和授权实现**

在 039 中让 request/reconcile 都先取得 `hashtextextended('<schema>:governance:session:' || auth_id,0)` 对应身份锁，再锁 Agent control；reconcile 的候选按 `owner_user_id,agent_id` 排序并有 limit。所有状态、route 和 outbox 变更处于同一事务，治理状态不可读时抛错而非按 active 放行。新增 `AFTER INSERT OR UPDATE OF status` trigger，在状态变为 suspended/banned 时执行 `pg_notify('bairui_runtime_governance', NEW.user_id)`；PostgreSQL 只在事务提交后投递通知。

- [x] **Step 4: 运行 PostgreSQL 专项确认通过**

Run: `conda run -n cloud --no-capture-output node --test --test-concurrency=1 apps/platform-api/test/runtime-control-postgres.test.mjs`

Expected: PASS，0 failed，临时角色/schema 均清理。

- [x] **Step 5: 提交**

```powershell
git add packages/db/migrations/039_runtime_control_fencing.sql apps/platform-api/src/runtime/postgres-control-store.mjs apps/platform-api/test/runtime-control-postgres.test.mjs
git commit -m "test: verify runtime governance fencing"
```

### Task 8: 增加隔离验收入口与文档

**Files:**
- Create: `scripts/test-runtime-control.mjs`
- Modify: `package.json`
- Create: `docs/45-e1-runtime-control-safety.md`
- Modify: `AGENTS.md`

- [x] **Step 1: 写 runner 静态失败测试**

在 `apps/platform-api/test/runtime-control-contract.test.mjs` 增加读取根 `package.json` 和 runner 的测试，断言 script 不加载 `.env`、清除 `BAIRUI_*`/`BETTER_AUTH_*`/`DATABASE_URL`、只创建一次性随机容器并运行 E1 专项文件。

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/runtime-control-contract.test.mjs`

Expected: FAIL，`test:runtime-control` 不存在。

- [x] **Step 2: 实现独立测试 runner 和 npm script**

```json
"test:runtime-control": "node scripts/test-runtime-control.mjs"
```

runner 复用 `scripts/test-scheduler.mjs` 的随机容器、`waitForPostgres`、环境清洗和 finally 删除模式，设置 `BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL`，串行运行：contract、envelope、memory、driver、controller、postgres 六个文件。不得读取项目 `.env`，不得连接 `bairui` 或 `bairui_preprod`。

- [x] **Step 3: 编写中文接入文档并更新项目状态**

`docs/45-e1-runtime-control-safety.md` 写明：状态机与 generation、039 前置/备份/最小授权、Controller/Orchestrator 配置字段、测试命令、故障语义、回滚原则、未开放用户执行和未部署边界。`AGENTS.md` 只在专项与回归实际通过后记录准确测试结果；不写真实 Runtime 已上线。

- [x] **Step 4: 运行 E1 专项**

Run: `conda run -n cloud --no-capture-output npm run test:runtime-control`

Expected: 所有 E1 测试 PASS；输出确认一次性数据库创建和清理。

- [x] **Step 5: 提交**

```powershell
git add scripts/test-runtime-control.mjs package.json docs/45-e1-runtime-control-safety.md AGENTS.md apps/platform-api/test/runtime-control-contract.test.mjs
git commit -m "docs: add E1 runtime control acceptance"
```

### Task 9: 全量相关回归与最终审计

**Files:**
- Modify only when a failing regression has a demonstrated E1 cause.

- [x] **Step 1: 运行后端全量测试**

Run: `conda run -n cloud --no-capture-output npm test --prefix apps/platform-api`

Expected: PASS，0 failed。

- [x] **Step 2: 运行平台、治理和调度隔离验收**

```powershell
conda run -n cloud --no-capture-output npm run test:platform
conda run -n cloud --no-capture-output npm run test:governance
conda run -n cloud --no-capture-output npm run test:scheduler
```

Expected: 三项均退出 0；每项一次性数据库/容器清理完成。

- [x] **Step 3: 审计密钥、危险参数和围栏回退**

Run: `rg -n "local-only-change-this-secret|docker\.sock|spec\.env|payload\.env|runtime\.start\.requested|runtime\.stop\.requested|run_generation|route_version" apps/platform-api/src packages/db/migrations/039_runtime_control_fencing.sql docs/45-e1-runtime-control-safety.md`

Expected: E1 remote 控制路径没有默认密钥、docker.sock 或任意 env；start/stop 事件和 generation/route fence 均有实现与文档命中。

- [x] **Step 4: 检查工作区和提交历史**

Run: `rtk git status --short; rtk git diff HEAD~8..HEAD --check; git log --oneline -10`

Expected: 无未提交 E1 文件、diff check 无输出；提交按任务分隔。不得执行数据库迁移、启动真实 Controller、修改预发或推送远端，除非用户另行明确要求。

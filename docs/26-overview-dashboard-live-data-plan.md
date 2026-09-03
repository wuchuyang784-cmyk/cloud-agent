# 总览仪表盘接入真实用量数据 — 改造方案

> 目标：让 MVP 控制台「总览仪表盘」完全基于**用户真实用量数据**驱动，达到「一块屏看清平台运行状况」的监控效果。
> 范围：`apps/console-mvp`（前端）+ `apps/web` + `packages/db`（后端与仓储）。
> 状态：方案文档，未实现。
> 关键约束：**多用户并发 + 数据隔离**（见 §0.2）。

---

## 0. 现状与结论

### 0.1 前端现状
当前仪表盘（`apps/console-mvp/src/App.tsx` 的 `OverviewDashboard`）**全部为写死静态数据，零后端接入**：

| 区块 | 现状 | 代码位置 |
|---|---|---|
| 4 张指标卡（会话数/调用量/延迟/成功率） | 常量 `dashboardMetrics` | `App.tsx` ~186-205 |
| 调用趋势折线图 | 纯 CSS 动画 `chart-wave`，无真实点 | `App.tsx` ~442 |
| 模型调用分布环形图 | 百分比写死 | `App.tsx` ~442 |
| 最近活动 3 条 | 常量 `activities` | `App.tsx` ~436-440 |
| 数据更新时间文案 | 写死「今天 10:24」 | `App.tsx` |

### 0.2 后端现状与并发隔离基线（重要）
平台是**多租户**（organization）+ **多用户**（user）模型。仪表盘必须保证：**用户 A 绝不可看到用户 B 的用量/活动数据**，且多用户**并发请求同一接口时各自返回自己的数据**（无共享可变状态、无串数据）。

经核查后端真实实现，隔离现状如下：

| 数据源 | 是否带 `user_id` | 隔离能力 | 结论 |
|---|---|---|---|
| `usage_rollups` 表 | ✅ 有 `user_id` 列 | `listUsageRollups(orgId, userId, agentId)` 已支持 `userId` 过滤（`postgres-repository.mjs:546-555`，`userId` 条件在 `:550`） | ✅ 可严格按用户隔离 |
| `telemetry_events` 表 | ✅ 有 `user_id` 列 | 但 `listTelemetryEvents(organizationId, limit)` **仅按 `organization_id` 过滤，无 `userId` 参数**（`postgres-repository.mjs:1844-1849`） | ⚠️ **存在隔离漏洞**，须改造 |
| `control_audit_events` 表 | ❌ **无 `user_id` 列**（`021` migration `:438-454`，仅 `organization_id` + `actor_identity`） | 组织级审计流，只能按组织隔离 | ⚠️ 活动 feed 中审计事件为「组织级」，非「个人级」 |

> 真实用量采集链路后端已具备：Server Agent 心跳上报携带 `usage` 字段，落入 `usage_rollups`（`postgres-repository.mjs:339-352`）。已有 `usageSummary()`（`app.mjs:286`）、单 agent `GET /api/user/agents/:id/usage`（`app.mjs:1002`）、管理员跨 agent `GET /api/admin/usage`（`app.mjs:1122`）。

---

## 1. 后端改造

### 1.1 扩展仓储：按时间范围 + 用户过滤查询 rollups
`listUsageRollups` 当前不支持范围过滤（只 `ORDER BY bucket_start DESC LIMIT`）。扩展签名支持 `from`/`to`，**并强制 `userId` 入参以实现并发隔离**：

```js
// packages/db/postgres-repository.mjs
// 注意：userId 必传（调用方从 principal 注入），确保不同用户数据不串
async listUsageRollups(organizationId, userId, agentId, { limit = 1000, from, to } = {}) {
  const conditions = [];
  const values = [];
  if (organizationId) { values.push(organizationId); conditions.push(`organization_id=$${values.length}`); }
  if (userId) { values.push(userId); conditions.push(`user_id=$${values.length}`); }   // 隔离关键
  if (agentId) { values.push(agentId); conditions.push(`agent_id=$${values.length}`); }
  if (from) { values.push(from); conditions.push(`bucket_start >= $${values.length}`); }
  if (to) { values.push(to); conditions.push(`bucket_start <= $${values.length}`); }
  values.push(Math.max(1, Math.min(Number(limit) || 1000, 5000)));
  const { rows } = await this.pool.query(
    `SELECT * FROM usage_rollups${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY bucket_start DESC LIMIT $${values.length}`,
    values
  );
  return rows.map(mapUsageRollup);
}
```
> `mapUsageRollup` 已返回 `model / inputTokens / outputTokens / estimatedCostUsd / runCount / failedRunCount / latencySumMs / bucketStart`，可直接用于前端聚合。

### 1.2 修复遥测事件隔离漏洞（关键）
扩展 `listTelemetryEvents` 支持 `userId`，**让活动 feed 不串用户**：

```js
// packages/db/postgres-repository.mjs
async listTelemetryEvents(organizationId, limit = 500, userId) {          // 新增 userId 参数
  const conditions = ['organization_id=$1'];
  const values = [organizationId];
  if (userId) { values.push(userId); conditions.push(`user_id=$${values.length}`); }  // 隔离关键
  values.push(Math.max(1, Math.min(Number(limit) || 500, 2000)));
  const { rows } = await this.pool.query(
    `SELECT * FROM telemetry_events WHERE ${conditions.join(' AND ')} ORDER BY occurred_at DESC LIMIT $${values.length}`,
    values
  );
  return rows.map((row) => ({ id: row.id, organizationId: row.organization_id, userId: row.user_id, agentId: row.agent_id, runtimeId: row.runtime_id, layer: row.layer, componentId: row.component_id, eventType: row.event_type, severity: row.severity, traceId: row.trace_id, metrics: row.metrics, occurredAt: row.occurred_at?.toISOString?.() ?? row.occurred_at }));
}
```
> 调用方（`app.mjs`）需同步把 `principal.userId` 传入，避免仍按组织-wide 拉取。

### 1.3 新增会话数聚合（口径见 §3，可选）
会话存在于 `channel_conversations`（`018` migration `:39`）。新增仓储，**必带 `userId` 隔离**：

```js
async countConversations(organizationId, userId, { from, to } = {}) {
  const conditions = ['organization_id=$1'];
  const values = [organizationId];
  if (userId) { values.push(userId); conditions.push(`user_id=$${values.length}`); }   // 隔离关键
  if (from) { values.push(from); conditions.push(`created_at >= $${values.length}`); }
  if (to) { values.push(to); conditions.push(`created_at <= $${values.length}`); }
  const { rows } = await this.pool.query(
    `SELECT COUNT(DISTINCT id) AS total, COUNT(DISTINCT agent_id) AS active_agents FROM channel_conversations WHERE ${conditions.join(' AND ')}`,
    values
  );
  return { totalConversations: Number(rows[0]?.total ?? 0), activeAgents: Number(rows[0]?.active_agents ?? 0) };
}
```

### 1.4 新增平台级用量接口（用户视角）
`apps/web/app.mjs`，在 `GET /api/user/agents/:id/usage` 之后新增。**从 `principal` 注入 `userId`，不做任何跨用户查询**：

```js
const usageRangeMatch = url.pathname.match(/^\/api\/user\/usage$/);
if (usageRangeMatch && method === 'GET') {
  const principal = requireLogin(principal0);
  requirePermission(principal, PERMISSIONS.AGENT_READ, { organizationId: principal.organizationId, userId: principal.userId });
  const range = url.searchParams.get('range') ?? '7d';           // today | 7d | 30d
  const { from, to } = resolveRange(range);                       // 由当前时间推算（服务端时钟，非前端传入，防篡改）
  // 关键： userId 来自已认证的 principal，绝不接收前端传入的 userId 参数
  const rollups = await repository.listUsageRollups(principal.organizationId, principal.userId, undefined, { from, to, limit: 5000 });
  const summary = usageSummary(rollups);
  const modelBreakdown = aggregateModelBreakdown(rollups);
  const series = aggregateSeries(rollups, range);
  const sessions = await repository.countConversations(principal.organizationId, principal.userId, { from, to });
  return json(response, 200, {
    range,
    updatedAt: new Date().toISOString(),
    summary: {
      totalCalls: summary.runCount,
      failedCalls: summary.failedRunCount,
      successRate: summary.runCount ? 1 - summary.failedRunCount / summary.runCount : 1,
      avgLatencyMs: summary.runCount ? summary.latencySumMs / summary.runCount : 0,
      totalTokens: summary.inputTokens + summary.outputTokens,
      estimatedCostUsd: summary.estimatedCostUsd,
      totalConversations: sessions.totalConversations,
      activeAgents: sessions.activeAgents,
    },
    modelBreakdown,   // [{ model, calls, share }]
    series,           // [{ bucketStart, calls, failedCalls, avgLatencyMs }]
  });
}
```
> **并发说明**：该接口为纯查询、无共享可变状态；每个请求基于自身 `principal` 过滤，用户 A/B 并发调用各自命中 own `WHERE user_id=?` 条件，结果天然隔离。连接池（`this.pool`）处理并发，无需额外锁。

### 1.5 新增用户侧活动 feed 接口
```js
if (method === 'GET' && url.pathname === '/api/user/activities') {
  const principal = requireLogin(principal0);
  requirePermission(principal, PERMISSIONS.AGENT_READ, { organizationId: principal.organizationId, userId: principal.userId });
  const limit = Math.min(Number(url.searchParams.get('limit')) || 10, 50);
  // 遥测事件：按 userId 隔离（§1.2 修复后）
  const tele = await repository.listTelemetryEvents(principal.organizationId, limit * 2, principal.userId);
  // 审计事件：组织级，无法按用户隔离——仅取本组织，前端标注为「组织动态」
  const audit = await repository.listControlAuditEvents(principal.organizationId, limit * 2);
  const feed = mergeAndRank([...tele, ...audit]).slice(0, limit).map(toActivityItem);
  return json(response, 200, { activities: feed });
}
```
`toActivityItem` 契约（`tone` 由 severity/action 映射，error→danger、warn→warning、deploy/config→success）：
```ts
{ id: string; title: string; detail: string; occurredAt: string; tone: 'info'|'success'|'warning'|'danger'; scope: 'self'|'org'; agentId?: string }
```
> `scope` 字段显式区分「个人遥测」与「组织审计」，前端可对 `org` 级条目加「组织」标记，避免用户误以为都是自己的操作。

### 1.6 聚合辅助函数（app.mjs，放 `usageSummary` 旁）
```js
function aggregateModelBreakdown(rollups) {
  const byModel = new Map();
  let total = 0;
  for (const r of rollups) {
    const calls = r.runCount ?? 0;
    total += calls;
    byModel.set(r.model ?? 'unknown', (byModel.get(r.model ?? 'unknown') ?? 0) + calls);
  }
  return [...byModel.entries()].map(([model, calls]) => ({ model, calls, share: total ? calls / total : 0 }));
}
function aggregateSeries(rollups, range) {
  const buckets = new Map();
  for (const r of rollups) {
    const key = r.bucketStart;
    const cur = buckets.get(key) ?? { calls: 0, failedCalls: 0, latencySumMs: 0 };
    cur.calls += r.runCount ?? 0;
    cur.failedCalls += r.failedRunCount ?? 0;
    cur.latencySumMs += r.latencySumMs ?? 0;
    buckets.set(key, cur);
  }
  return [...buckets.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([bucketStart, v]) => ({ bucketStart, calls: v.calls, failedCalls: v.failedCalls, avgLatencyMs: v.calls ? v.latencySumMs / v.calls : 0 }));
}
function resolveRange(range) {
  const to = new Date();
  const from = new Date(to);
  if (range === 'today') from.setHours(0, 0, 0, 0);
  else if (range === '7d') from.setDate(from.getDate() - 7);
  else if (range === '30d') from.setDate(from.getDate() - 30);
  else from.setDate(from.getDate() - 7);
  return { from: from.toISOString(), to: to.toISOString() };
}
```

---

## 2. 前端改造（apps/console-mvp）

### 2.1 数据层 `src/api.ts` 新增
```ts
export interface UsageSummary { totalCalls: number; failedCalls: number; successRate: number; avgLatencyMs: number; totalTokens: number; estimatedCostUsd: number; totalConversations: number; activeAgents: number; }
export interface ModelSlice { model: string; calls: number; share: number; }
export interface UsageSeriesPoint { bucketStart: string; calls: number; failedCalls: number; avgLatencyMs: number; }
export interface UsagePayload { range: string; updatedAt: string; summary: UsageSummary; modelBreakdown: ModelSlice[]; series: UsageSeriesPoint[]; }

export async function fetchUsage(range: 'today' | '7d' | '30d'): Promise<UsagePayload> {
  const res = await fetch(`/api/user/usage?range=${range}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`usage ${res.status}`);
  return res.json();
}

export interface ActivityItem { id: string; title: string; detail: string; occurredAt: string; tone: 'info'|'success'|'warning'|'danger'; scope: 'self'|'org'; agentId?: string; }
export async function fetchActivities(limit = 10): Promise<ActivityItem[]> {
  const res = await fetch(`/api/user/activities?limit=${limit}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`activities ${res.status}`);
  return (await res.json()).activities ?? [];
}
```
> **前端隔离注意**：浏览器按 `credentials: 'include'` 携带当前用户 cookie，服务端据 cookie 解析 `principal`。前端**永远不要**把 userId 拼进请求参数（防越权/串数据）。切换账号登录后调用同一接口，返回自然切换为对应用户数据。

### 2.2 `OverviewDashboard` 改造要点
- 删除常量 `dashboardMetrics` / `activities` / 环形图写死百分比。
- state：`usage`（UsagePayload | null）、`activities`（ActivityItem[]）、`loading`、`error`。
- `useEffect` 依赖 `dashboardRange` 调 `fetchUsage(range)`；另起 `useEffect` 首屏调 `fetchActivities()`。
- 指标卡由 `usage.summary` 渲染：`totalCalls` / `successRate` / `avgLatencyMs` / `activeAgents`（或 `totalConversations`，见 §3）。
- 环形图由 `usage.modelBreakdown` 动态渲染（conic-gradient 按 share 算角度）。
- 折线图由 `usage.series` 数据点动态生成柱/线高度（替换 `chart-wave` 纯动画）。
- 「数据更新于」由 `usage.updatedAt` 格式化。
- 「最近活动」由 `activities` 渲染；`scope==='org'` 条目加「组织」标记；`tone` 映射颜色（danger/warn 高亮，达到监控一眼见异常）。
- **失败回退**：开发期无后端时保留最小 mock 常量避免空白；**上线应移除回退、强制真实数据，不显示假数字**（与「按真实用量显示」一致）。

### 2.3 轮询（监控感 + 并发安全）
当前在 `overview` 页时，每 30s 重新 `fetchUsage(dashboardRange)`（`setInterval` + 卸载清理），让延迟/调用量「动起来」；活动流 60s 刷新。
> 轮询每次都是独立请求、独立 `principal` 过滤，多用户各自刷新各自数据，无状态冲突。注意组件卸载时 `clearInterval`，避免内存泄漏与越界 setState。

---

## 3. 口径与隔离决策（需确认）

| 指标 | 真实来源 | 隔离方式 | 决策 |
|---|---|---|---|
| 调用量 / 成功率 / 延迟 / Token | `usage_rollups` 聚合 | `WHERE user_id=?`（§1.1） | ✅ 直接用，严格个人隔离 |
| 模型分布 | `usage_rollups` 按 model | 同上 | ✅ |
| 调用趋势 | `usage_rollups` 按 bucketStart | 同上 | ✅ 前端聚合 |
| 总会话数 | `channel_conversations` 计数 | `WHERE user_id=?`（§1.3） | 需新增；或降级用「总调用数」主指标 |
| 最近活动（个人） | `telemetry_events` | `WHERE user_id=?`（§1.2 修复） | ✅ 修复隔离后可用 |
| 最近活动（组织） | `control_audit_events` | 仅 `organization_id`，无 user_id 列 | ⚠️ 标注 `scope:'org'`，不冒充个人操作 |

**降级建议**：若会话数聚合成本高，总览主指标先用「总调用数 / 成功率 / 平均延迟 / 活跃 Agent 数」四张卡（全真实 + 个人隔离），会话数后续迭代补。

---

## 4. 并发与隔离验收清单（测试要点）

1. **用户隔离**：用户 A、B 各登录，分别调 `GET /api/user/usage`，断言 `summary` 仅含各自 `usage_rollups` 行（DB 直接比对 `WHERE user_id=A/B`）。
2. **遥测修复验证**：`listTelemetryEvents(orgId, limit, userId)` 加 userId 后，A 不应看到 B 的 telemetry 事件。
3. **并发压测**：用同一组织多用户 token 并发打 `GET /api/user/usage` + `/api/user/activities`，断言每个响应 `user_id` 与请求 token 一致、无交叉、无 500（连接池够用）。
4. **越权防护**：前端任何请求不携带 userId 参数；后端拒绝 `?user_id=` 等越权入参（仅信 `principal`）。
5. **范围篡改防护**：`range` 仅服务端 `resolveRange` 计算 `from/to`，前端不可传 `from/to` 任意值。
6. **空数据**：新用户无用量时接口返回全 0 结构而非 404，前端显示「暂无数据」而非假数字。

---

## 5. 落地阶段

| 阶段 | 内容 | 后端 | 前端 |
|---|---|---|---|
| P0 | 扩展 `listUsageRollups` 加 `from/to`；新增 `GET /api/user/usage`（个人隔离） | §1.1, §1.4, §1.6 | §2.1, §2.2 指标卡/环形图/趋势 |
| P0 | **修复 `listTelemetryEvents` 用户隔离漏洞** | §1.2 | — |
| P1 | 新增 `GET /api/user/activities` + `countConversations`（个人隔离） | §1.3, §1.5 | §2.2 活动流 |
| P1 | 会话数真口径（或降级用调用数） | §1.3 | 相应调整 |
| P2 | 轮询刷新 + 异常高亮 + 并发验收 | 复用现有 | §2.3, §4 |

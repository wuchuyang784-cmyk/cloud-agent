# Agent 数据 API 接入文档（后端扩展指南）

> 适用范围：`apps/console-mvp/`（独立静态部署的 React + Vite SPA）。
> 目的：开发阶段前端使用内置 mock 数据，后端就绪后无需改动 UI 代码，仅配置环境变量即可切换为真实接口。

---

## 0. 前端数据层现状

| 文件 | 职责 |
| --- | --- |
| `src/api.ts` | 唯一的数据访问层，封装 `fetchAgents()` / `fetchUsage()`，并对后端字段做映射与降级 |
| `src/App.tsx` | 通过 `useEffect` 调用 `fetchAgents()`，失败时二次 fallback 到 `MOCK_AGENTS` |

**接入开关（关键）：**

```ts
const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const USE_MOCK = API_BASE === '';
```

- `VITE_API_BASE` **未配置（本地/dev 默认）**：`USE_MOCK = true`，前端返回内置 mock，不发起任何网络请求。
- `VITE_API_BASE` **已配置**（如 `https://api.bairui.app`）：`USE_MOCK = false`，自动改走真实 HTTP 接口。

后端同学只需在部署前端时设置该环境变量，前端即自动切换，**无需改代码**。

---

## 1. 接口清单

所有接口均挂载在 `API_BASE` 之下，需携带会话 Cookie（`credentials: 'include'`），返回 `application/json`。

| 方法 | 路径 | 前端函数 | 用途 |
| --- | --- | --- | --- |
| GET | `/api/user/agents` | `fetchAgents()` | 获取当前用户全部 agent 列表 |
| GET | `/api/user/usage?range=today\|7d\|30d` | `fetchUsage(range)` | 获取调用量 / 用量统计 |

---

## 2. GET /api/user/agents

### 请求
```
GET {API_BASE}/api/user/agents
Accept: application/json
Cookie: <用户会话>
```

### 响应体（JSON）
```json
{
  "agents": [
    {
      "id": "agent-cs-01",
      "name": "客服 Agent #1",
      "description": "售前咨询与售后工单",
      "status": "RUNNING",
      "operational": { "code": "RUNNING" },
      "runtime": { "status": "running" },
      "settings": { "preferredModel": "DeepSeek V3" },
      "host": "agent-agent-cs-01.bairui.app"
    }
  ]
}
```

### 字段与前端映射

| 后端字段 | 类型 | 说明 | 前端 `Agent` 字段 | 映射规则 |
| --- | --- | --- | --- | --- |
| `id` | string | 唯一标识 | `id` | 原样 |
| `name` | string | 名称 | `name` | 原样 |
| `description` | string? | 描述 | `description` | 缺省 `''` |
| `operational.code` / `status` | string | 运行状态码 | `status` | 见下方状态枚举映射 |
| `runtime.status` | string | 运行时状态 | `status` | 作为次级取值 |
| `settings.preferredModel` | string? | 模型名 | `model` | 缺省 `'未配置'` |
| `host` | string? | 永久域名 | `host` | 缺省按 `agent-{id}.bairui.app` 占位 |

> 注：前端 `icon` / `color` / `channels` / `stats` 当前由前端按 MVP 规则展示（mock 阶段为占位）。后端如需接管展示，可扩展响应字段（见 §4 扩展点）。

### 状态枚举映射（`mapStatus`）

| 后端值（不区分大小写） | 前端状态 | 含义 |
| --- | --- | --- |
| `RUNNING` / `running` | `running` | 运行中 |
| `INITIALIZING` / `initializing` / `DEPLOYING` / `deploying` / `PENDING` | `initializing` | 初始化 / 部署中 |
| 其他 / 空 | `error` | 异常 |

### 错误码
| HTTP | 含义 | 前端行为 |
| --- | --- | --- |
| 401 | 未登录 | 跳登录（预留） |
| 403 | 无权限 | 提示无权限 |
| 其他非 2xx | 请求失败 | 抛错，`App.tsx` 兜底回退 mock |

---

## 3. GET /api/user/usage

### 请求
```
GET {API_BASE}/api/user/usage?range=today|7d|30d
Accept: application/json
Cookie: <用户会话>
```

### 响应体（JSON）
```json
{
  "range": "7d",
  "updatedAt": "2026-08-16T12:00:00Z",
  "summary": {
    "totalCalls": 72400,
    "failedCalls": 796,
    "successRate": 0.989,
    "avgLatencyMs": 401,
    "totalTokens": 10420000,
    "estimatedCostUsd": 71.3,
    "totalConversations": 512,
    "activeAgents": 3
  },
  "modelBreakdown": [
    { "model": "DeepSeek V3", "calls": 30408, "share": 0.42 }
  ],
  "series": [
    { "bucketStart": "08-06", "calls": 9800, "failedCalls": 110, "avgLatencyMs": 408 }
  ]
}
```

### 字段说明
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `range` | string | `today` / `7d` / `30d` |
| `updatedAt` | string(ISO8601) | 数据更新时间 |
| `summary.totalCalls` | number | 总调用次数 |
| `summary.failedCalls` | number | 失败次数 |
| `summary.successRate` | number | 成功率（0~1） |
| `summary.avgLatencyMs` | number | 平均延迟（ms） |
| `summary.totalTokens` | number | 令牌消耗总量 |
| `summary.estimatedCostUsd` | number | 预估成本（USD） |
| `summary.totalConversations` | number | 总会话数 |
| `summary.activeAgents` | number | 活跃 agent 数 |
| `modelBreakdown[].model` | string | 模型名 |
| `modelBreakdown[].calls` | number | 该模型调用数 |
| `modelBreakdown[].share` | number | 占比（0~1） |
| `series[].bucketStart` | string | 时间桶起始（今日维度为 `HH:MM`，其余为 `MM-DD`） |
| `series[].calls` | number | 该桶调用数 |
| `series[].failedCalls` | number | 该桶失败数 |
| `series[].avgLatencyMs` | number | 该桶平均延迟 |

### 错误码
同 §2（非 2xx 抛错，前端当前在 `USE_MOCK` 分支无法触发；接入真实后端后失败会由 `App.tsx` 兜底）。

---

## 4. 后端就绪后的扩展点

前端已做**零改动切换**，但为后续增强展示，可在响应中扩展以下字段（前端将按需消费，未提供时仍优雅降级）：

1. **Agent 详情增强**：`channels`（string[] 渠道）、`stats`（[{label,value}] 卡片指标）、`color`（主题色键名）、`icon`（图标键名）——用于去掉 `blue`/`—` 占位。
2. **新增接口**：如需 agent 详情、日志、对话记录等，在 `src/api.ts` 中新增 `fetchAgentDetail(id)` 等函数，遵循同一 `API_BASE` + `USE_MOCK` 模式，并在 `App.tsx` 接线即可。
3. **鉴权**：当前使用 `credentials: 'include'` 透传 Cookie；如改为 Bearer Token，仅需修改 `src/api.ts` 的 `headers`，不影响接口契约。

---

## 5. 本地联调与切换步骤

1. **纯前端演示（默认）**：不配置 `VITE_API_BASE`，启动 `npm run dev`，前端使用 mock。
2. **接入真实后端**：
   - 构建时设置环境变量：`VITE_API_BASE=https://api.bairui.app`（或本地 `http://localhost:4000`）。
   - 或使用 `.env` 文件：`apps/console-mvp/.env.local` 写入 `VITE_API_BASE=...`。
   - 重新 `npm run build`，前端自动改走真实接口。
3. **契约校验**：后端实现后，按本文 §2、§3 的字段逐一比对；状态枚举见 §2 映射表。

---

## 6. 兼容性约束

- 所有响应必须为合法 `application/json`。
- 时间统一使用 ISO8601（UTC）。
- `successRate` / `share` 等比例字段为 0~1 浮点数，前端按百分比展示。
- 列表为空时返回 `{ "agents": [] }`，不可返回 `null`。

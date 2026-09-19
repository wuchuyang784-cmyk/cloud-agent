# 32 平台级多租户架构（目标形态与改造清单）

> 本文定义项目从「个人用户 MVP」升级为「平台级多租户云 Agent 服务」的目标架构、
> 关键设计决策与分阶段改造清单。现状差距分析见对话记录，本文只写**目标与路径**。

---

## 1. 定位转变

| 维度 | 个人 MVP（现状） | 平台级服务（目标） |
|---|---|---|
| 租户 | 一人一组织，RLS 锁死 `owner_user_id` | 组织为租户，成员按角色共享 Agent |
| 身份 | 口令登录 + Cookie | 口令 + 组织上下文 + 角色 + API Key |
| 运行时 | worker 在宿主 `docker run` 拉实例（挂 docker.sock） | 编排层调度，平台不持有宿主 Docker 控制权 |
| 生命周期 | 只拉起，不停止、不回收、不巡检 | 状态机 + 心跳 + idle 回收 + 停删路由 |
| 资源治理 | 无配额、无限流、无并发上限 | 五维限流 + 并发配额 + 欠费阻断 |
| 授权 | 无角色判断、无 403、无审计 | RBAC 中间件 + 审计留痕 |
| 部署 | docker stack（含 docker.sock） | 应用本机/集群进程跑，**docker 只留数据库** |

---

## 2. 目标架构

```
┌─ 接入层 ─────────────────────────────────────────────────┐
│  Console (React)        │  公共 API  /api/v1/*（API Key） │
│  Caddy / Gateway：按 agent-{id} 子域反代（生产接 ticket）  │
└──────────────────────────────────────────────────────────┘
                          ↓
┌─ 平台控制面 Control Plane（platform-api）─────────────────┐
│                                                           │
│  ① Identity & Tenancy                                     │
│     Principal{userId, organizationId, role, orgs[]}        │
│     组织切换 · 成员管理 · RBAC · API Key                    │
│                                                           │
│  ② Agent Lifecycle                                        │
│     Agent CRUD · 模板 · 状态机                              │
│     pending → provisioning → ready → stopped / degraded    │
│                                                           │
│  ③ Runtime Orchestration  ← 核心抽象，去 docker 依赖        │
│     RuntimeDriver: provision / stop / health / route       │
│     ├─ local-driver   本机子进程（开发 · CI）               │
│     ├─ remote-driver  外部编排已起实例，平台登记+巡检（生产）│
│     └─ k8s/swarm-driver（后续）                             │
│                                                           │
│  ④ Quota & Metering                                        │
│     限流（IP/用户/组织/Agent/接口）· 并发配额 · 计量 · 计费  │
│                                                           │
│  ⑤ Audit                                                   │
│     audit_events 全量留痕                                  │
└──────────────────────────────────────────────────────────┘
                          ↓  信封签名（HMAC + nonce + 时间窗）
┌─ 运行时数据面 Runtime Plane ──────────────────────────────┐
│  Agent Runtime 实例（由编排层调度，平台不 docker run）       │
│  Runtime Boundary：按 agentId 解析 runtime_url 转发         │
└──────────────────────────────────────────────────────────┘
                          ↓
┌─ 存储层 ──────────────────────────────────────────────────┐
│  PostgreSQL + pgvector（唯一外部依赖，docker 只保留它）      │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 关键设计决策

### 3.1 运行时编排：RuntimeDriver 抽象（去 docker 依赖）

**决策**：平台**不再**通过 `docker run` 在宿主拉起 Agent 实例，也不再挂载
`/var/run/docker.sock`。取而代之的是 `RuntimeDriver` 接口：

```js
// src/runtime/orchestration/runtime-driver.mjs
export class RuntimeDriver {
  async provision(spec) {}   // -> { runtimeUrl, ref, status }
  async stop(spec) {}        // -> { stopped, ref }
  async health(spec) {}      // -> { status: running|degraded|offline, runtimeUrl }
  route(spec) {}             // -> { runtimeUrl }
}
```

实现：

| Driver | 形态 | 用途 |
|---|---|---|
| `local` | `spawn('node', wrapper)` 本机子进程 | 开发 / CI，无需 Docker |
| `remote` | 实例由外部编排（K8s / Swarm / 运行时池）拉起，平台按 `runtimeUrl` 登记并巡检 | **生产（平台级）** |

- `BAIRUI_RUNTIME_DRIVER=local|remote` 选择（默认 `local`）。
- `remote` 形态下平台只做：登记 `runtimeUrl`、健康检查、路由、回收通知；
  **拉起与资源限制交给编排层**（K8s Pod 的 `resources.limits`），天然获得
  非 root、只读根、cgroup 限制、网络隔离。
- `pi-engine.mjs` 删除 `docker run / docker rm / docker stop` 分支，
  改为调用 driver；`--memory/--cpus/--user/--read-only` 等加固随之由编排层负责。

### 3.2 租户与授权

- **Principal** 携带 `organizations[]` 与当前 `organizationId`，支持组织切换。
- **RLS 放宽**（新迁移）：
  - `personal` 组织：仍锁 `owner_user_id`（个人空间）。
  - `team` 组织：改为「组织成员可见」——
    `organization_id = app.organization_id AND (kind='personal' ? owner_user_id=app.user_id : 组织成员)`。
- **Agent 级权限**：启用现存的 `agent_memberships`（`owner/operator/viewer`），
  查询 Agent 时按其判定。
- **RBAC 中间件**：`requireRole('org_admin')` 统一返回 **403**；
  `platform_admin` 走独立 `/api/admin/*` 面。
- **审计**：登录、Agent 创建/删除、角色变更、配额拒绝等写 `audit_events`。

### 3.3 生命周期治理

- 路由补齐：`DELETE/PATCH /api/user/agents/:id`、`POST .../stop`、`POST .../restart`。
- 实例心跳：定期 `health`，写 `agent_engine_runs.last_seen_at`，
  超时置 `degraded/offline`。
- Reaper：idle TTL 到期自动 `stop`，清理僵尸实例。
- 状态权威落库（`agent_engine_runs`），不再只存 worker 进程内存。

### 3.4 配额与计量

- 限流中间件：IP / 用户 / 组织 / Agent / 接口五维，超限 **429**。
- 并发配额：每用户并发 Run、每组织并发 Run、每 Agent 并发 Session。
- 计费闭环：调用前校验余额，不足直接 **402**，不再允许余额为负；
  `usage_rollups` 真实写入，替换 `app.mjs` 里硬编码的 0。

### 3.5 路由分层

按 `docs/22`，把 `app.mjs`（548 行单体）拆为：

```
src/routes/
  auth.mjs         注册/登录/登出/me/组织切换
  user-runtime.mjs Agent/会话/消息/流式对话
  resources.mjs    资源库
  billing.mjs      账户/交易/用量
  admin-control.mjs 平台管理（platform_admin）
src/middleware/
  authenticate.mjs  Principal 解析
  authorize.mjs     requireRole → 403
  rate-limit.mjs    配额与限流
  audit.mjs         审计留痕
```

---

## 4. 本地开发形态（docker 只留数据库）

**唯一保留的容器**：`bairui-postgres`（PostgreSQL）。

应用一律本机进程直接跑，不再需要 docker stack、docker.sock、docker run：

```powershell
# 1) 数据库（唯一容器）
docker run --name bairui-postgres -e POSTGRES_USER=bairui `
  -e POSTGRES_PASSWORD=change-me-local-only -e POSTGRES_DB=bairui `
  -p 5432:5432 -d postgres:17-alpine

# 2) 应用（本机 node，无 docker）
$env:DATABASE_URL = 'postgresql://bairui_app:***@127.0.0.1:5432/bairui'
$env:BAIRUI_RUNTIME_DRIVER = 'local'      # 开发用本机子进程
node apps/platform-api/src/index.mjs        # api :8080
node apps/platform-api/src/worker-index.mjs # worker
node apps/platform-api/src/runtime/boundary-server.mjs  # boundary :8091
```

前端照旧 `npm run dev`（vite :5173）。

---

## 5. 改造路线

| 阶段 | 内容 | 对应缺口 |
|---|---|---|
| **A** | RuntimeDriver 抽象 + pi-engine 去 docker + stack 去 docker.sock + 本机只留数据库 | P0-1 |
| **B** | 租户与授权：组织切换、RLS 放宽、角色校验 403、审计写入 | P1-1 / P1-2 |
| **C** | 生命周期治理：stop/restart 路由、心跳巡检、idle reaper、状态落库 | P0-3 |
| **D** | 配额与计费闭环：限流 429、并发配额、余额校验 402、usage_rollups | P0-2 / P0-4 |
| **E** | 路由分层拆分（routes/ + middleware/），对接 OAuth / API Key | P1-3 |

阶段 A 是安全底线与本次明确要求，优先完成；B 决定「平台级」是否成立；
C/D 决定成本与资源是否失控；E 是长期工程化。

# 客户端业务后端方案设计

> 状态：客户端后端建设基线
> 适用范围：`apps/console-mvp`、Agent 独立使用入口、平台 BFF、Runtime Boundary、Agent Runtime
> 依据：`08-security-and-access-control.md`、`14-multi-tenant-agent-runtime.md`、`20-platform-agent-integration-guide.md`、`22-platform-route-boundaries.md`、`25-agent-runtime-env-and-request-routing.md`、`27-agent-runtime-template-strategy.md`、`28-dual-engine-platform-build-specs.md`、`apps/saas推荐.md`

## 1. 设计目标与边界

当前平台主要服务客户端业务，第一阶段优先打通“用户进入平台后，创建并使用自己的 Agent”这条链路：

```text
用户进入控制台
  -> 查看自己的 Agent
  -> 创建/初始化 Agent
  -> 打开 Agent 独立域名
  -> 创建会话并对话
  -> 查看个人用量、会话和运行状态
```

本方案满足：

- API 服务可水平扩展，普通读请求无本地状态；
- 组织、用户、Agent、会话和文件有明确的隔离边界；
- 浏览器永远拿不到 Runtime/Hermes/pi/dsh 的机器凭证、Provider Key 或内部地址；
- Agent 的创建、启动、停止、升级和回收是异步操作，不阻塞 HTTP 请求；
- 登录认证实现可以后置，但所有业务接口从第一天开始都依赖统一的 `Principal` 和授权策略；
- 保留现有 Control Authority、Runtime Boundary、PostgreSQL 权威模型和双引擎适配契约；
- SaaS 只承接通用能力，不接管 Agent 所有权、授权结果、运行时隔离和部署状态。

本方案不把平台改造成另一个 Agent Runtime。会话、消息、Run、工具、技能、记忆正文仍由 Agent Runtime / 引擎适配层负责；平台只负责身份、授权、路由、生命周期、配额、投影和审计。

## 2. 现状判断

当前仓库的 `apps/console-mvp` 是 Vite + React + TypeScript 前端，`src/api.ts` 通过 `VITE_API_BASE` 在 mock 和真实接口之间切换，已经约定了：

- `GET /api/user/agents`；
- `GET /api/user/usage?range=today|7d|30d`；
- 请求使用 `credentials: 'include'` 携带登录态；
- 前端不传 `userId`，用户身份必须由服务端会话解析；
- Agent 状态需要区分 `uninitialized`、`provisioning`、`starting`、`ready`、`degraded`、`offline`、`failed` 等真实状态。

设计文档已经确定：

1. PostgreSQL 是控制面权威；
2. 每个 Agent 对应一个隔离的运行时实例和稳定子域；
3. `/api/user/*` 是用户业务面，`/api/admin/*` 是管理面，`/api/internal/*` 只接受机器凭证；
4. Runtime 路由必须先通过当前用户和 Agent 所有权校验，再由服务端解析；
5. 控制面遥测和普通 API 不存储 Prompt、回复、对话正文、记忆正文、Provider Key 和主机敏感信息。

目前仓库没有与这些契约对应的完整后端服务目录。因此后端建设应先建立模块化单体和接口契约，再逐步拆分高负载边界，而不是直接把前端 mock 替换成若干互相重复的 SaaS 服务。

## 3. 总体架构

```text
                         +----------------------+
                         |  Browser / Client UI |
                         +----------+-----------+
                                    |
                         HTTPS, cookie or ticket
                                    |
              +---------------------v----------------------+
              | Edge Gateway / TLS / Agent subdomain      |
              | rate limit, request id, routing, headers  |
              +---------------------+----------------------+
                                    |
                +-------------------+-------------------+
                |                                       |
      +---------v----------+                  +---------v----------+
      | Platform BFF/API   |                  | Runtime Boundary   |
      | user/admin routes  |                  | agent-scoped proxy |
      | auth adapter        |                  | signed operations |
      +----+-----------+---+                  +----+-----------+---+
           |           |                           |
           |           +---------------------------+-----> Agent Runtime
           |                                           (pi / dsh instance)
           v
   +-------+--------+      +------------------+      +------------------+
   | PostgreSQL     |      | Redis            |      | Object Storage   |
   | control +      |      | limit/cache/SSE  |      | MinIO or R2      |
   | projections    |      | coordination     |      | artifacts/files  |
   +-------+--------+      +--------+---------+      +------------------+
           |                        |
           +------------+-----------+
                        v
              +----------------------+
              | Outbox / Worker      |
              | deploy, usage, sync |
              +----------+-----------+
                         |
                         v
              +----------------------+
              | Server Agent /       |
              | Scheduler / Supervisor|
              +----------------------+
```

### 3.1 第一阶段的部署形态

第一阶段采用一个 Node.js/TypeScript 模块化单体，按进程职责运行：

```text
api            用户 BFF、管理 API、Runtime Boundary HTTP 入口
worker         Outbox、部署命令、用量汇总、记忆投影和清理任务
server-agent   服务器侧出站控制客户端
runtime        每个 Agent 一个隔离容器/服务实例
```

`api` 可以启动多个副本；`worker` 使用数据库租约保证同一任务只被一个消费者处理。后续当流量明显增长时，再把 Runtime Boundary、SSE 网关和 Worker 独立扩容。不要在 MVP 阶段先拆成多个业务微服务，以免产生多套鉴权、事务和状态机。

### 3.2 推荐基础设施

| 能力 | MVP 建议 | 规模化方向 | 说明 |
| --- | --- | --- | --- |
| 数据库 | PostgreSQL | 主从/读副本 + PgBouncer | 控制面权威、业务元数据和聚合投影 |
| 缓存/限流 | Redis | Redis Cluster | 分布式限流、短期缓存、SSE 协调、幂等辅助 |
| 异步 | PostgreSQL Outbox + Worker | Redis Streams/NATS/Kafka | 部署与控制命令必须保留 Control Authority |
| 对象存储 | MinIO 或 Cloudflare R2 | R2/S3 多区域 | 文件和 Artifact 只走预签名 URL |
| 观测 | OpenTelemetry + Prometheus/Grafana | Tempo/Loki/告警平台 | 只上报脱敏指标和 opaque reference |
| 部署平台 | Docker Compose 或单节点 Swarm | Swarm/Kubernetes | Coolify 可管理平台服务，不直接替代 Agent 控制面 |
| 通用 SaaS | Resend、Sentry、PostHog 可选 | 按合规和成本决定 | 不把业务权限和对话正文交给第三方 |

## 4. 认证后置但不后置安全边界

### 4.1 统一身份抽象

后端先定义接口，不立即实现 Clerk、Better Auth、Keycloak 或其他登录产品：

```ts
type Principal = {
  userId: string;
  organizationId: string;
  roles: Array<'user' | 'org_admin' | 'platform_admin'>;
  sessionId: string;
  authnSource: 'dev' | 'better-auth' | 'clerk' | 'keycloak';
};

interface PrincipalResolver {
  resolve(request: Request): Promise<Principal | null>;
}
```

所有 `/api/user/*`、`/api/admin/*` 路由都先调用 `PrincipalResolver`，再调用授权策略。后续接入开源 SaaS 时只替换 `PrincipalResolver` 和用户同步适配器，业务服务不改。

### 4.2 开发期替身

认证功能尚未建设时，只允许使用受限的开发身份适配器：

- 仅在本地开发或隔离测试环境启用；
- 只接受服务端配置的固定测试用户，或本地专用 Header；
- 仅监听 localhost，不允许通过公网或生产配置启用；
- 启动时若 `NODE_ENV=production` 且仍使用 `dev` 身份，直接拒绝启动；
- 前端和客户端不能自行提交任意 `userId`、`organizationId` 或角色来获得身份。

这保证“暂不做登录页面”不会变成“业务接口没有身份边界”。未来优先选择 `Better Auth` 自托管；若需要快速商业化，可换成 Clerk，但两者都只能证明用户是谁，不能直接决定用户能否访问某个 Agent。

## 5. 用户登录后的核心流程

### 5.1 读取工作台

```text
GET /api/user/agents
  -> PrincipalResolver
  -> AgentPolicy.requireList(principal)
  -> AgentRepository.listByOwner(principal.userId, organizationId)
  -> 返回 Agent 元数据和脱敏运行状态
```

查询必须带 `organization_id` 和 `owner_user_id` 条件。不能先按 `agent_id` 查询，再在应用层补权限判断。响应不返回 Runtime 私网地址、机器凭证、API Key、工作区路径或对话正文。

`GET /api/user/usage` 和 `GET /api/user/activities` 只查询已经脱敏的 `usage_rollups`、`telemetry_events` 投影，并按当前 `Principal` 的用户范围过滤；不能把组织活动误显示为个人活动。

### 5.2 创建 Agent

```text
POST /api/user/agents
  -> 校验模板 manifest 和用户输入
  -> 事务写入 agents(status=uninitialized)
  -> 写入 deployment、desired_state、control_outbox
  -> 返回 202 Accepted + agent_id + status=provisioning
  -> Worker / Server Agent 执行部署
  -> 新鲜 Observation 验证后变为 ready
```

创建接口不能同步等待容器启动。请求需要支持 `Idempotency-Key`，重复提交返回同一 Agent 或同一创建结果。Agent 名称在同一所有者范围内建立唯一约束；模板引擎在创建时绑定，创建后不可随意切换引擎。

### 5.3 打开 Agent 独立域名

稳定地址为 `agent-{agent_id}.bairui.app`。网关根据 Host 找到 `agent_id`，但 Host 只是路由提示，不是授权依据：

```text
访问 agent-{id}.bairui.app
  -> 读取平台登录态或一次性短期 ticket
  -> ticket 绑定 user_id + organization_id + agent_id + expiry + nonce
  -> Runtime Boundary 再次校验 Agent 所有权、状态和配额
  -> 服务端解析该 Agent 的私有 Runtime route
  -> 代理请求或建立 SSE
```

浏览器看到的是稳定域名和业务响应，不看到 Runtime machine credential。Agent 停止、休眠或迁移时域名不变；平台返回准确的 `agent_not_ready`、`runtime_offline` 或 `quota_exhausted`，不能伪造成功消息。

### 5.4 会话和对话

用户 API 统一使用 Agent 作用域：

```text
GET  /api/user/agents/{agent_id}/sessions
POST /api/user/agents/{agent_id}/sessions
GET  /api/user/agents/{agent_id}/sessions/{session_id}
POST /api/user/agents/{agent_id}/sessions/{session_id}/chat/stream
POST /api/user/agents/{agent_id}/runs/{run_id}/cancel
```

每个请求先执行：

```text
principal -> organization -> agent -> membership/owner -> session -> runtime
```

服务端必须验证 `session.agent_id === path.agent_id`，不能接受客户端指定另一个 Agent 的 session。会话正文、消息、工具结果和记忆正文由运行时权威持有；PostgreSQL 只保留必要的 Agent-scoped 元数据、用量汇总、检索投影和 provenance。

SSE 连接要求：

- 不在连接期间持有数据库事务；
- 发送心跳，支持 `Last-Event-ID` 断线续传；
- 对单用户、组织、Agent 分别限制并发连接和 Run 数；
- 网关关闭响应缓冲，设置最大连接时长和空闲超时；
- Runtime 断开时返回机器可读错误，不把 5xx 转成假的 assistant 消息；
- 长任务转为 Run/Job，HTTP 只返回任务状态，不等待模型或工具执行结束。

### 5.5 文件与 Artifact

文件不经 API 进程中转大对象：

```text
POST /api/user/agents/{agent_id}/files/presign
  -> 服务端授权、校验 MIME/大小/用途
  -> 返回短期 PUT/GET URL
  -> 客户端直传 MinIO/R2
  -> 服务端保存 object_key、hash、size、owner、agent_id、retention
```

对象 Key 必须由服务端生成，例如 `org/{orgId}/agent/{agentId}/...`，不能直接使用客户端传入的路径。下载也必须再次授权并生成短期 URL。

## 6. 后端模块划分

```text
apps/web/                 HTTP 组合、错误边界、请求上下文
routes/auth-adapter       身份解析接口和开发身份适配器
routes/user               用户 Agent、会话、用量、文件接口
routes/admin              管理面元数据和运维接口
routes/internal           机器租约、回执、观察上报
services/authorization    owner/membership/org/role 策略
services/agent            Agent 创建、配置、生命周期
services/runtime          Runtime route、ticket、签名操作、SSE
services/usage            事件接收和聚合投影
services/storage          预签名、hash、retention、病毒扫描钩子
repositories/             只接受 Scope 的 PostgreSQL 读写
workers/                  outbox、部署、usage、memory、retention
packages/contracts        请求/响应、状态机、manifest、错误码
```

路由只负责参数解析和响应，业务规则放在 Service，数据库访问放在 Repository。Repository 方法必须带 `AccessScope`，例如 `listAgents(scope)`，禁止提供无作用域的 `listAllAgents()` 给用户业务代码。

## 7. 数据隔离模型

### 7.1 关键字段

所有用户业务资源至少包含：

```text
organization_id
owner_user_id 或 created_by
agent_id（Agent 子资源）
created_at / updated_at
```

建议的核心表：

```text
users / organizations / organization_members
agents / agent_memberships
agent_templates / agent_template_installs
deployments / desired_states / observations
runtime_routes / runtime_tickets
provider_connections / secret_refs
usage_events / usage_rollups / telemetry_events
file_objects / artifacts
control_outbox / control_commands / command_receipts
audit_events
```

会话和消息表可以保留迁移兼容结构，但新用户聊天 API 不把它们当作正文权威；正文权威按现有文档交给 pi/dsh 引擎适配层。

### 7.2 双层授权

第一层是应用层强制授权：每个请求解析 `Principal`，再由策略服务验证角色、组织、所有权或成员关系。第二层可在 PostgreSQL 增加 RLS 作为纵深防御，但数据库应用连接角色不能拥有绕过 RLS 的超级权限；事务内设置 `app.user_id`、`app.organization_id` 和 `app.role`。

无论是否启用 RLS，都必须保留应用层检查，因为 Runtime、对象存储、缓存和控制命令不由 PostgreSQL 自动保护。

### 7.3 Agent 隔离

一个 Agent 一个运行时实例，至少隔离：

- 容器/服务身份和独立 workspace；
- Provider Key、渠道 Token、Runtime machine credential；
- 网络出口策略和资源 limits；
- Runtime route 和域名；
- 会话、记忆、文件、Artifact 和用量命名空间。

任何跨 Agent 的共享能力都必须通过平台服务显式授权，不能通过共享文件夹、共享环境变量或通用 Runtime 管理端口实现。

## 8. 高并发设计

### 8.1 API 层

- API 副本无本地会话状态，前置网关做 TLS、压缩、限流和连接保护；
- 连接池大小按数据库最大连接数反推，生产使用 PgBouncer 事务池；
- 读接口优先查询聚合投影和缓存，避免每次总览都访问 Runtime；
- 列表统一使用 keyset pagination，禁止大 offset 扫描；
- 热点配置、Agent 状态和 runtime route 使用短 TTL Redis 缓存，并以版本号/失效消息保证更新；
- 所有外部调用设超时、重试上限、熔断和 bulkhead，不能让模型供应商拖住 API 线程。

### 8.2 限流和背压

限流维度至少包括：IP、用户、组织、Agent、接口类型。对聊天接口额外限制：

```text
每用户并发 Run
每组织并发 Run
每 Agent 并发 Session/Run
每 Provider 并发请求
单请求输入大小和上下文长度
```

超限返回 `429`，系统过载返回 `503` 并带 `Retry-After`。创建、部署、重启、备份等控制操作进入队列，不允许客户端瞬间触发大量同步编排请求。

### 8.3 数据库和异步任务

控制命令沿用现有 `queued -> leased -> accepted -> running -> verifying -> succeeded` 状态机，使用 `FOR UPDATE SKIP LOCKED` 或等价租约机制；完成条件必须是 receipt 加上新鲜 Observation 验证，而不是 HTTP 200。

事件写入采用事务 Outbox：业务状态和待投递事件在同一事务提交，Worker 批量拉取、幂等消费、失败重试和死信。Trigger.dev/Inngest 可以承接普通长任务和通知，但不能成为 Control Authority 的最终状态来源。

## 9. API 约定

用户 API 当前沿用文档中的 `/api/user/*` 路径；公共开发者 API 后续另开 `/api/v1/*`，避免把内部用户接口直接暴露成开放 API。

统一错误格式：

```json
{
  "error": {
    "code": "agent_not_ready",
    "message": "Agent is not ready",
    "requestId": "req_..."
  }
}
```

核心错误码和状态码：

| 错误码 | HTTP | 场景 |
| --- | --- | --- |
| `unauthenticated` | 401 | 没有有效 Principal |
| `forbidden` | 403 | 已登录但没有权限 |
| `agent_not_found` | 404 | Agent 不属于当前用户/组织 |
| `agent_not_ready` | 409 | 初始化或配置未完成 |
| `model_not_configured` | 409 | 没有可用模型连接 |
| `runtime_route_unavailable` | 503 | 没有可用私有路由 |
| `runtime_offline` | 503 | 心跳过期或运行时不可用 |
| `quota_exhausted` | 429 | 配额耗尽 |
| `idempotency_conflict` | 409 | 幂等键对应了不同请求 |
| `validation_error` | 422 | 请求字段不合法 |

所有创建和有副作用的请求都支持 `Idempotency-Key`；所有响应带 `X-Request-Id`，日志、追踪和审计使用同一 request id，但不记录消息正文和密钥。

## 10. SaaS/开源组件接入结论

| 组件 | 在本方案中的位置 | 当前是否接入 |
| --- | --- | --- |
| Better Auth | `PrincipalResolver` 的未来生产实现 | 暂不接入，先做接口和开发替身 |
| Clerk | 可替换的托管认证实现 | 仅在需要快速商业化时评估 |
| Keycloak/ZITADEL | 企业自托管 SSO/组织身份 | 企业客户阶段接入 |
| Trigger.dev/Inngest | 普通异步任务、通知、重试 | 不是控制命令权威 |
| Lago | 用量计费计算 | 后期接入，License/Quota 仍由平台确认 |
| Stripe/Lemon Squeezy | 支付、订阅、税务 | 后期接入，通过 Webhook 回写平台权益 |
| MinIO/R2 | 文件和 Artifact | 可以较早接入 |
| OpenTelemetry/Sentry | 观测和错误 | 可以较早接入，必须脱敏 |
| Supabase | 托管 PostgreSQL/Storage | 可用基础设施，不采用其整套 Auth/业务模型 |
| Coolify | 部署 API、Worker、网关等平台服务 | 可选，不替代 Agent Scheduler/Control Authority |

核心原则是：SaaS 提供“通用能力”，BaiRui 保留“业务权威”。付款状态不能直接授予 Agent 权限，认证身份不能直接绕过 Agent 所有权，任务平台不能直接改变 Agent 生命周期。

## 11. 分阶段落地

### P0：登录后用户闭环

- 建立 Node.js/TypeScript 模块化后端和统一错误边界；
- 建立 `PrincipalResolver`、`AccessScope`、`AuthorizationPolicy`，启用安全的开发身份替身；
- 实现 `GET /api/user/agents`、`GET /api/user/usage`、`GET /api/user/activities`；
- 实现 Agent 创建事务、幂等键、Outbox 和状态查询；
- 接通一个 dsh 或 pi 模板的 `spawn/health/route`；
- 先用 Docker Compose/单节点运行，补齐每 Agent 资源 limits；
- 前端移除“请求失败后显示假成功”的生产行为，真实接口失败显示准确状态。

### P1：可用的 Agent 数据面

- 实现独立域名网关、一次性短期 ticket 和 Runtime Boundary；
- 接通 sessions、chat stream、runs、cancel；
- SSE 断线续传、并发限制、模型 Provider 熔断；
- MinIO/R2 预签名上传；
- OpenTelemetry 指标和脱敏错误追踪；
- 双用户、双 Agent 并发隔离测试。

### P2：商业化和组织能力

- 接入 Better Auth 或选定的托管认证；
- 接入组织成员和 `agent_memberships`；
- 接入 Stripe/Lemon Squeezy + Lago，回写 `license_entitlements` 和配额；
- 接入邮件、邀请、密码重置和企业 SSO；
- 增加管理面，但管理面默认只看元数据、状态和证据引用。

### P3：规模化编排

- Redis Cluster 和独立 SSE/Runtime Boundary 副本；
- Outbox 消费迁移到 Redis Streams/NATS/Kafka（控制权仍在平台）；
- Swarm/Kubernetes 多节点调度、冷启动、scale-to-zero、节点池和灾备；
- PostgreSQL 读副本、归档、备份恢复演练；
- 压测并验证租户、用户、Agent 三层配额和故障降级。

## 12. 必须先验收的安全与性能用例

1. 用户 A 不能读取、调用、上传到或取消用户 B 的 Agent、Session、Run 和文件，即使手动替换路径参数。
2. 同一用户拥有多个 Agent 时，Agent A 的 Runtime credential、文件、记忆和会话不能出现在 Agent B。
3. Host、`agent_id`、ticket、session_id 任一项不匹配，都不能建立 Runtime 连接。
4. 创建、停止、重启和部署请求在重复提交、超时重试和 Worker 重启后只产生一个最终结果。
5. 运行时离线、配额耗尽、模型未配置时，接口返回稳定错误码，前端保留用户未发送内容。
6. 并发压测下，用户 API 无跨用户响应、无连接池耗尽、无无限重试和无未受控的 SSE 连接增长。
7. 日志、Trace、Telemetry、Outbox 和审计中搜索不到 Prompt、消息正文、API Key、Bearer Token、私钥和数据库密码。
8. PostgreSQL migration、控制状态机、ticket 重放、RLS/应用授权和对象存储路径均有自动化测试。

## 13. 最终建议

现在先建设“业务后端骨架和用户 Agent 数据面”，不要先建设登录页面，也不要先接入整套 Supabase 或完整 SaaS Starter。认证后置的正确方式是：接口先依赖不可绕过的 `Principal` 抽象，开发期用受限替身，平台设计稳定后再接入 Better Auth/Keycloak/Clerk 之一。

第一条真实闭环应是：

```text
开发 Principal
  -> GET /api/user/agents
  -> POST /api/user/agents
  -> Outbox/Worker 部署隔离实例
  -> agent-{id}.bairui.app ticket 访问
  -> Runtime Boundary 建立 SSE 对话
  -> usage_rollups 返回个人用量
```

这条链路既符合现有 MVP 和设计文档，也为后续登录、组织、计费、企业 SSO 和多节点扩展保留了稳定的接入位置。

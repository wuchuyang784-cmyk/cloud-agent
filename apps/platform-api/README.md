# 平台 API P0

这是面向客户端业务的第一阶段可运行后端切片。

当前实现包括：本地开发登录、按所有者隔离的 Agent API、异步模拟创建、按
Agent 隔离的会话创建、SSE 对话事件、按用户统计用量，以及支持幂等的 Agent
创建。

## 本地运行

```powershell
npm test --prefix apps/platform-api
npm start --prefix apps/platform-api
```

开发登录接口仅在非生产模式下开放：

```text
POST /api/auth/dev-login
{ "email": "...", "password": "..." }
```

本地启动且没有初始化数据时，可以使用 `dev@example.test` 和
`dev-password-change-me` 登录，也可以通过 `BAIRUI_DEV_EMAIL` 和
`BAIRUI_DEV_PASSWORD` 覆盖默认值。`NODE_ENV=production` 时不会启用这组
开发凭据。

设置 `DATABASE_URL` 后，API 和 Worker 会使用 PostgreSQL；会话、幂等记录、
Agent、用量和 Outbox 都会持久化，API 可以扩展为多个副本。未设置
`DATABASE_URL` 时才会回退到 `MemoryStore`，仅用于单进程开发测试。

首次连接已有数据库时，按顺序导入 `packages/db/migrations/` 中的
`001_platform_mvp.sql`、`022_agent_templates.sql`、`023_auth_sessions.sql`、
`024_worker_rls.sql`、`025_client_resources.sql`、`026_conversation_messages.sql`、
`027_client_resource_contents.sql`、`028_agent_user_features.sql` 与
`029_agent_engine_rls.sql`（仓库基线无 002-021 号迁移）。
应用账号建议使用非超级用户的 `bairui_app`，不要让平台 API 使用迁移管理员或
PostgreSQL 超级用户。

PowerShell 本地运行示例（密码不要提交到仓库）：

```powershell
$env:NODE_ENV = 'development'
$env:DATABASE_URL = 'postgresql://bairui_app:你的密码@127.0.0.1:5432/bairui'
$env:BAIRUI_SESSION_SECRET = '请替换为至少32字符的随机值'
$env:BAIRUI_DEV_EMAIL = 'dev@example.test'
$env:BAIRUI_DEV_PASSWORD = '请替换为本地开发密码'
npm start --prefix apps/platform-api
```

PostgreSQL 模式需要同时运行 Worker；否则 Agent 会保持 `provisioning`，不会被
模拟 Runtime 标记为 `ready`：

```powershell
npm run start:worker --prefix apps/platform-api
```

本阶段预留 `agent-{id}.localhost`，并由 Caddy 转发到平台 API。它不能直接
代理到 Runtime：生产路由必须先校验当前登录用户和 Agent 范围的 ticket，
再解析私有 Runtime 路由。模拟 Runtime 只是后续边界接入前的内部替身。

## 生产环境前置条件

- 已按顺序导入 `packages/db/migrations/` 全部迁移（001、022、023、024、025、
  026、027、028、029）的 PostgreSQL。
- API 和 Worker 使用同一个 `DATABASE_URL`。
- `BAIRUI_SESSION_SECRET` 使用随机的至少 32 字符密钥。
- 当前仍使用模拟 Runtime；它只用于平台 API 的开发验证。
- 在启用直接主机名路由前，先提供 Agent ticket 接口和 Runtime Boundary。
- 将 `BAIRUI_SESSION_SECRET` 设置为随机生成且长度至少为 32 个字符的密钥。

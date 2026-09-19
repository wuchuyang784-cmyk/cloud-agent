# 平台 API

## 当前平台模式（2026-09-17）

默认 BAIRUI_PLATFORM_MODE=platform，要求 Better Auth + PostgreSQL；Agent 写操作、对话与模拟充值关闭，资源库与本人历史记录保留。npm run dev 只启动 API 和控制台。

操作说明以 [平台模式与认证代理安全](../../docs/36-platform-mode-and-auth-proxy.md) 为准，认证迁移见 [第一阶段接入](../../docs/33-phase1-better-auth.md)。本批无需新增 SQL，不覆盖现有 .env。

## 历史 P0 实现记录

以下内容仅用于理解旧实现和非生产 legacy 回归；其中默认本地认证、内存回退、Worker 启动与生产条件不再适用于平台模式。

这是面向客户端业务的第一阶段可运行后端切片。

当前实现包括：账号注册与登录（生产默认本地账号模式）、按所有者隔离的 Agent API、
异步模拟创建、按 Agent 隔离的会话创建、SSE 对话事件、按用户统计用量，以及支持
幂等的 Agent 创建。

## 本地运行

```powershell
npm test --prefix apps/platform-api
npm start --prefix apps/platform-api
```

身份模式由 `BAIRUI_AUTH_MODE` 选择；未显式设置时默认使用本地账号（`local`），
支持注册、登录与个人组织隔离。需要受限开发替身时显式设置 `BAIRUI_AUTH_MODE=dev`。

本地账号模式提供真实的注册与登录，生产环境同样开放：

```text
POST /api/auth/register   { "email": "...", "password": "...", "displayName": "..." }
POST /api/auth/login      { "email": "...", "password": "..." }
POST /api/auth/logout
GET  /api/auth/me
```

注册口令至少 8 位。注册会为该用户创建一个独立的个人组织
（`organizations.kind='personal'`）并写入 `organization_members`（角色
`org_admin`），随后直接签发会话。个人组织是真实组织，未来升级为团队只需追加成员，
无需迁移任何业务数据。

开发替身模式仅供本地开发，只接受服务端配置的固定测试用户：

```text
POST /api/auth/dev-login
{ "email": "...", "password": "..." }
```

本地启动且没有初始化数据时，可以使用 `dev@example.test` 和
`dev-password-change-me` 登录，也可以通过 `BAIRUI_DEV_EMAIL` 和
`BAIRUI_DEV_PASSWORD` 覆盖默认值。`dev-login` 在 `NODE_ENV=production` 时返回 404，
且 `dev` 模式在生产环境会被拒绝启动。

设置 `DATABASE_URL` 后，API 和 Worker 会使用 PostgreSQL；会话、幂等记录、
Agent、用量和 Outbox 都会持久化，API 可以扩展为多个副本。未设置
`DATABASE_URL` 时才会回退到 `MemoryStore`，仅用于单进程开发测试。

首次连接已有数据库时，按顺序导入 `packages/db/migrations/` 中的
`001_platform_mvp.sql`、`022_agent_templates.sql`、`023_auth_sessions.sql`、
`024_worker_rls.sql`、`025_client_resources.sql`、`026_conversation_messages.sql`、
`027_client_resource_contents.sql`、`028_agent_user_features.sql`、
`029_agent_engine_rls.sql`、`030_agent_engine_mock_default.sql` 与
`031_multi_organization_reservations.sql`（仓库基线无 002-021 号迁移）。
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

- 已按顺序导入 `packages/db/migrations/` 全部迁移（001、022-031）的 PostgreSQL。
- API 和 Worker 使用同一个 `DATABASE_URL`。
- `BAIRUI_SESSION_SECRET` 使用随机的至少 32 字符密钥。
- 当前仍使用模拟 Runtime；它只用于平台 API 的开发验证。
- 在启用直接主机名路由前，先提供 Agent ticket 接口和 Runtime Boundary。
- 将 `BAIRUI_SESSION_SECRET` 设置为随机生成且长度至少为 32 个字符的密钥。

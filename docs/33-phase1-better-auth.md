# 第一阶段：平台账号与个人空间

日期：2026-09-16。

2026-09-17 补充：当前默认平台模式已关闭 Agent 写入/执行与模拟充值，日常启动只运行 API 和控制台；原文阶段记录保留，新增约束与启动操作以 [36-platform-mode-and-auth-proxy.md](36-platform-mode-and-auth-proxy.md) 为准。本批无新增 SQL。

## 定位与范围

目标是平台级多用户服务，不以单用户 MVP 演示作为验收标准。本批交付第一阶段的认证接入与个人空间映射，不代表整个阶段或生产上线条件已完成。

依据 apps/saas推荐.md 的自托管路线，接入开源 Better Auth，版本固定为 1.7.5。不是仅参考 SaaS 页面，也不整体替换现有项目。账号凭据和会话交给 Better Auth；业务授权、用户与组织隔离仍由平台 Principal、Store 和 PostgreSQL RLS 负责。

## 已实现

- 新增显式认证模式 better-auth；原 local/dev 保留用于旧环境和回归测试，不能视作正式部署方案。
- 原生邮箱密码注册、登录、退出；密码长度 12 至 128 字符。
- Cookie 会话有效期 8 小时，不启用 Cookie 身份缓存；退出后其他 API 实例查询不到原会话。
- 校验固定访问来源；生产模式要求 HTTPS、至少 32 字符的独立密钥和 PostgreSQL。
- 认证表使用 ba_ 前缀，与已有 users、auth_sessions 分离。
- 首次通过有效会话访问平台时，将 better-auth:加身份 ID 写入 users.auth_subject，在一个事务内建立用户、个人组织与成员关系。
- 并发首次访问用 PostgreSQL 事务锁串行化同一个身份，避免重复个人空间；映射失败可重试。
- 不按邮箱自动合并旧账号；遇到历史邮箱冲突返回 identity_link_required，保留原数据。
- 前端通过 /api/auth/config 选择认证协议，再从 /api/auth/me 获取平台身份，不把认证组件返回的用户 ID 当成业务授权。
- Better Auth 模式下，旧 login、register、dev-login、logout 接口均关闭；仅开放当前需要的三个原生认证写入端点。
- 前端移除共享开发账号一键体验入口和硬编码开发凭据。
- 会话过期时返回登录页并清空当前用户数据；退出请求失败会提示错误，不冒充已撤销服务端会话；过期前发出的刷新结果不会覆盖新账号状态。

认证账号创建与业务空间创建是两个步骤，不是跨组件分布式事务。注册成功后前端立即请求 /me；如果业务数据库短暂故障，下一次登录或 /me 请求可重试空间创建。此时不会获得其他用户的数据。

## 数据库操作

请先备份。在 Navicat 中确认当前选中的是平台使用的数据库，而不是默认 postgres 数据库。

1. 原数据库迁移已到 030 时，先执行 packages/db/migrations/031_multi_organization_reservations.sql。
2. 再执行 packages/db/migrations/032_better_auth.sql。032 只执行一次；重复执行会报表已存在并回滚，不能通过删除认证表来解决。
3. 若 SQL 由管理员导入、API 使用 bairui_app，执行以下授权；实际应用角色名称不同时替换角色名。不要为应用账号授予超级用户或 BYPASSRLS。

```sql
GRANT SELECT, INSERT, UPDATE, DELETE
ON ba_user, ba_session, ba_account, ba_verification, ba_rate_limit
TO bairui_app;

SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND tablename LIKE 'ba_%'
ORDER BY tablename;
```

五张认证表仅供服务端访问，不适用当前业务表的会话 RLS。不要向浏览器、匿名数据库角色或公共 API 暴露它们。已有业务表 RLS 保留。

旧账号密码不自动迁移，不直接修改 auth_subject 冒充绑定。首次验收请使用未注册过的新邮箱；历史账号迁移需要独立核验身份的流程。

## 本地启动

在原来已经配置 DATABASE_URL 的后端 PowerShell 窗口执行。BETTER_AUTH_URL 必须是浏览器地址栏中的控制台来源，不是容器内部 API 地址。以下示例固定前端 5173 端口：

```powershell
$env:BAIRUI_AUTH_MODE = 'better-auth'
$env:BETTER_AUTH_URL = 'http://localhost:5173'
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$env:BETTER_AUTH_SECRET = [Convert]::ToBase64String($bytes)
npm start --prefix apps/platform-api
```

密钥只在可信的本地配置或 Secret 管理中保存，不发到聊天、不提交 Git。所有 API 副本使用同一密钥；重启时保留同一密钥，变更密钥会使原会话失效。

另一个 PowerShell 窗口：

```powershell
npm run dev --prefix apps/console-mvp -- --host 127.0.0.1 --port 5173 --strictPort
```

访问 http://localhost:5173。若端口已占用，可选择其他端口，但必须同时修改 BETTER_AUTH_URL 并重启后端。不要混用 localhost 与 127.0.0.1。

## Swarm 与安全边界

编排文件已透传 BAIRUI_AUTH_MODE、BETTER_AUTH_URL、BETTER_AUTH_SECRET，暂不自动切换现有部署，避免数据库未迁移导致启动失败。必须显式设置 better-auth 才会接入新认证。

正式部署使用 NODE_ENV=production，BETTER_AUTH_URL 指向 Caddy 对外 HTTPS 域名；当前 Secret 环境变量透传需在正式上线前改成受控 Secret 注入。

Better Auth 限流记录落入 PostgreSQL，不使用各副本独立内存。当前只信任 TCP 对端 IP，覆盖浏览器伪造的 IP 头；通过 Caddy 时会把代理视为同一个来源，这是保守限制，不是已完成的生产分布式限流。下一批需要配置可信代理边界、网关限流、账号维度策略和压测。不要直接相信公网传入的 X-Forwarded-For。

尚未配置验证邮件和找回密码，因此当前注册邮箱不是已验证邮箱；不得据此开放团队邀请、敏感邮箱变更或旧账号自动绑定。邮件服务与发送域名需要用户提供后才能接入，不伪造邮件送达结果。

## 验收与剩余工作

- 已通过：真实 Better Auth 处理器注册、登录、退出、来源拒绝、旧接口关闭。
- 已通过：临时 PostgreSQL 全量迁移、认证表字段与锁定版本 schema 核对。
- 已通过：非超级用户且无 BYPASSRLS 的账号访问数据库；两个 API 实例共享会话；12 个并发首次访问仅建一个个人空间；跨用户资源访问返回 404；一个实例退出后另一个返回 401。
- 这些是功能和隔离测试，不是高并发容量、吞吐或生产可用性结论。
- 本批不修改用户现有数据库；实际部署需要按上文导入迁移、授权、设置环境变量后验收。
- 第一阶段后续：平台模式统一关闭 Agent 生命周期与模拟充值入口，前后端能力开关一致；审计与可观测性；生产配置全面 fail-fast；备份与恢复。
- 第二阶段：模拟调度、资源配额、队列公平性、多副本故障恢复和明确负载模型下的容量测试。

常规测试：npm test --prefix apps/platform-api；npm test --prefix apps/console-mvp；npm run build --prefix apps/console-mvp。

真实数据库集成测试：仅将 BAIRUI_TEST_DATABASE_URL 指向一次性测试数据库，再执行 node --test apps/platform-api/test/better-auth-postgres.test.mjs。测试创建独立随机 schema 和无登录应用角色，最后清理。不要指向生产库。

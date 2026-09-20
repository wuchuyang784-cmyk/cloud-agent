# 双端平台 A 批实施计划

> 执行流程：using-superpowers、writing-plans、executing-plans、test-driven-development、verification-before-completion。用户已确认设计，当前会话顺序执行，不自动提交或部署业务环境。

**目标：** 独立管理端、显式平台角色、只读用户及 Agent 列表；保留客户端个人空间隔离。

**架构：** 两个 React 前端通过同源 `/api` 共用 Better Auth 和模块化 API。管理端入口 `/admin/`；全局角色独立于组织角色。数据库提供固定字段、重复鉴权的受限查询函数，禁止应用自行授予角色。

**技术栈：** 现有 React/Vite/lucide、Node.js、Better Auth、PostgreSQL；本机命令统一 Conda cloud。

## 已确认边界

- SaaS 使用方式：复用已接入的 Better Auth，参考 Open SaaS 的独立后台、账户列表与权限分层，不搬入其 Wasp/Prisma 或第二套认证。
- 暂停账号服务允许只读登录；封禁账号禁止登录并撤销会话。这是 D 批规则，A 批不提供可点击的假封禁操作。
- B 为本人监控，C 为运维监控，D 为治理闭环，E 为真实 Runtime。本批不启用 Agent 执行，不修改 bairui 或预发，不引入组织共享。
- 管理员具体账号由用户指定；迁移不设默认管理员、不按邮箱或个人空间角色自动提权。

## 任务与检查点

- [x] 1. 后端红灯：`apps/platform-api/test/admin.test.mjs` 验证匿名 401、个人 org_admin 403、伪造角色无效、显式授权可读、撤权即拒绝、只读字段及有界分页。
  - 命令：`conda run -n cloud --no-capture-output node --test apps/platform-api/test/admin.test.mjs`。
  - 首次期望管理 API 尚不存在导致授权正例失败，之后实现至通过。
- [x] 2. 数据和查询：新增 `034_platform_admin.sql`、`src/admin/store.mjs`、`src/admin/routes.mjs`；在 `app.mjs` 接入路由。MemoryStore 与 PostgreSQL 查询契约一致。
  - 只允许 `/api/admin/me`、`/api/admin/users`、`/api/admin/agents` 的 GET。
  - 查询参数固定为 q/after/limit，以及 Agent 的 ownerUserId/status；不接受 actor/role/organizationId 注入。
  - SQL 函数固定 search_path、撤销 PUBLIC 执行权、再次查询当前角色；应用角色没有角色绑定写策略。
- [x] 3. PostgreSQL 验收：新增 `admin-postgres.test.mjs`，接入独立测试库 runner。覆盖双 API、受限角色、RLS、危险字段、授权/撤权、审计和原客户端隔离。
- [x] 4. 管理端：新增 `apps/admin-console`，登录、无权限、错误、空态、用户表、Agent 表、筛选、分页、刷新、退出。每次权限失败清空数据，取消过期请求；不持久化身份数据。
- [x] 5. 开发入口：`dev-services.mjs` 增加管理端 Vite，客户端同源代理 `/admin/`；保持既有认证可信源不变。补预发构建与 Caddy 路径配置，但不执行部署或自动迁移。
- [x] 6. 验证与文档：后端回归、独立数据库专项、双前端构建、启动配置测试；浏览器检查桌面/移动端、登录、权限拒绝、筛选、分页、退出及过期响应。
  - 新增中文 `docs/39-dual-console-phase-a.md`，说明手动备份、034 导入、最小函数授权、显式 DBA 角色授予及撤销。
  - 结果：管理后端 4、管理前端 7、平台 22、调度 10、客户端 13、预发配置 54、监控配置 20 项通过；常规后端 161 通过，3 项数据库专项由独立命令覆盖。双前端构建、实际 Caddy 解析和桌面/移动端真实认证浏览器验收通过。
  - 业务库和常驻预发未改动，首个真实管理员未指定；用户侧实际导入与授权仍待验收。

## 验收不可替代项

普通用户不能进入管理 API；旧的组织 `platform_admin` 字段也不能替代新绑定。全局权限不改变 `/api/user/*` 的本人查询范围。管理端不输出凭据、内部 Runtime 地址、配置或对话正文。模拟测试通过不代表实际 Runtime 停止和监控已验收。

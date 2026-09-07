# BaiRui Cloud Agent Platform 项目级协作说明

本文件是仓库级 Codex/Agent 工作指引。进入本项目后，优先遵循本文件，再结合用户当次请求执行。

## 项目定位

- 本仓库位于 `E:\cloud-agent`，当前是 BaiRui Cloud Agent Platform 的本地 MVP 落地工程。
- 平台优先服务客户端业务场景：用户进入控制台后，可以创建、查看、使用自己的 Agent，并在资源库中管理知识库、Skill 等客户端业务资源。
- 当前登录采用本地开发登录接口，正式登录认证、管理端、计费、组织成员管理等功能后置。
- 当前 Runtime 使用模拟 Runtime，后续再替换为真实 Runtime Boundary / Agent Runtime。:codex-annotation{index="1"}
- SaaS/开源 SaaS 只作为通用能力参考或承接，不接管 Agent 所有权、用户隔离、权限边界、运行时隔离和部署状态。

## 目录结构

- `apps/platform-api/`：平台后端 API、开发登录、Agent 生命周期、会话、资源库、用量、Worker 和模拟 Runtime。
- `apps/console-mvp/`：客户端 MVP 控制台，React + Vite，访问后自动开发登录并进入控制台。
- `packages/db/migrations/`：PostgreSQL 数据库结构迁移，按文件名前缀顺序执行。
- `infra/postgres/`：本地 PostgreSQL 使用说明。
- `infra/swarm/`：Docker Swarm 编排文件。
- `infra/caddy/`：Caddy 本地反向代理配置，预留 `agent-{id}.localhost` 访问方式。
- `docs/`：设计文档、客户端后端方案、安全隔离、Runtime、控制面、部署和验收资料。
- `output/`：生成产物或临时输出，非必要不要改动。

## 当前关键边界

- 客户端控制台不展示平台管理、组织成员、License、服务器、审计日志等管理端功能。
- 左侧导航中，“资源库”属于“平台状态”区域，不属于“工作台”。
- “智能体 Agents”工作区保留原 MVP 导航：快速开始、我的项目、运行记录、接入配置。
- Agent 模板属于“智能体 Agents / 快速开始”，不要放回资源库。
- 资源库用于客户端业务资源，支持 `knowledge_base`、`skill`、`tool`、`plugin` 四类，持久化在 PostgreSQL 的 `client_resources` 表，后续可挂载给 Agent 调用。
- 所有用户数据接口必须基于当前 Principal / session scope，不允许通过前端传入用户 ID 或组织 ID 来越权访问。
- 跨用户、跨组织访问资源时应返回 `404`，避免泄露资源是否存在。

## 后端约定

- 后端入口：`apps/platform-api/src/app.mjs`。
- 本地启动：

```powershell
npm start --prefix apps/platform-api
```

- Worker 启动：

```powershell
npm run start:worker --prefix apps/platform-api
```

- 模拟 Runtime 启动：

```powershell
npm run start:runtime --prefix apps/platform-api
```

- 未设置 `DATABASE_URL` 时使用 `MemoryStore`，只适合单进程开发测试。
- 设置 `DATABASE_URL` 后使用 PostgreSQL，API 和 Worker 必须使用同一个数据库连接串。
- PostgreSQL 应用账号建议使用非超级用户，例如 `bairui_app`。
- 不要把真实数据库密码、会话密钥、Provider Key 或 Runtime 内部地址写入仓库。
- `BAIRUI_SESSION_SECRET` 必须使用至少 32 字符的随机字符串，本地开发也不要使用生产密钥。

## 数据库迁移

首次准备数据库时，按顺序执行：

```text
packages/db/migrations/001_platform_mvp.sql
packages/db/migrations/022_agent_templates.sql
packages/db/migrations/023_auth_sessions.sql
packages/db/migrations/024_worker_rls.sql
packages/db/migrations/025_client_resources.sql
packages/db/migrations/026_conversation_messages.sql
packages/db/migrations/027_client_resource_contents.sql
packages/db/migrations/028_agent_user_features.sql
packages/db/migrations/029_agent_engine_rls.sql
```

新增表结构时：

- 在 `packages/db/migrations/` 下新建递增编号 SQL 文件。
- PostgreSQL 表要考虑组织、用户、Agent 或会话范围隔离。
- 涉及用户业务数据的表优先增加 RLS 策略和范围索引。
- 后端 Store 需要同时支持 PostgreSQL 和 MemoryStore，测试不能只覆盖其中一个分支。

## 前端约定

- 前端入口：`apps/console-mvp/src/App.tsx`。
- API 封装：`apps/console-mvp/src/api.ts`。
- 样式：`apps/console-mvp/src/styles.css`。
- 本地启动：

```powershell
npm run dev --prefix apps/console-mvp
```

- 构建：

```powershell
npm run build --prefix apps/console-mvp
```

- 控制台是客户端 MVP，不要把管理端能力塞入当前 UI。
- 修改 UI 时优先保持现有 TDesign 风格、紧凑业务控制台布局、8px 以内圆角和现有 CSS 变量。
- 按用户要求，当前访问控制台后直接看到控制台，不新增登录页。
- 使用 lucide-react 图标，避免手写图标。
- 不要做营销落地页；用户要的是可操作的业务控制台。

## 常用验证命令

后端测试：

```powershell
npm test --prefix apps/platform-api
```

前端导航和静态检查测试：

```powershell
npm test --prefix apps/console-mvp
```

前端构建：

```powershell
npm run build --prefix apps/console-mvp
```

针对资源库相关改动，至少运行：

```powershell
node --test apps/platform-api/test/resources.test.mjs
npm test --prefix apps/console-mvp
```

## 开发工作规则

- 修改代码前先读相关文件和测试，避免凭记忆重写已有 MVP 行为。
- 工作区可能已有用户或其他任务的改动，不要使用 `git reset --hard`、`git checkout --` 等破坏性命令。
- 手工编辑文件优先使用 `apply_patch`。
- 搜索文件优先使用 `rg` 或 `rg --files`；大输出命令可优先尝试 `rtk`。
- 文档默认用中文书写，除非用户明确要求英文。
- 保持改动范围小，围绕用户当前要求落地，不做无关重构。
- 若用户明确说“不要自己规划解决”，遇到需要外部信息或产品取舍时直接说明需要用户提供什么。

## 安全与隔离要求

- 所有用户态 API 默认只返回当前登录用户范围内数据。
- Agent、会话、资源、用量等数据必须同时考虑用户隔离、组织隔离和 Agent 隔离。
- Runtime 内部凭据、机器凭据、Provider Key 不得暴露给浏览器。
- `agent-{id}.localhost` 或未来独立域名访问必须先经过平台票据校验，再进入 Runtime Boundary。
- 删除、更新、查询资源时，不要根据前端传入的 owner 字段决定授权。

## 当前优先级

1. 客户端 MVP 控制台体验恢复和后端接入。
2. PostgreSQL 持久化、RLS、Store 双实现和测试覆盖。
3. 模拟 Runtime 下的 Agent 创建、会话、用量、资源库闭环。
4. Docker Swarm + Caddy 本地部署验证。
5. 正式登录认证、管理端能力、真实 Runtime Boundary 后续再加。


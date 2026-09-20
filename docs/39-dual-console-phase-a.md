# 双端平台 A 批：管理端入口与只读权限

日期：2026-09-19。本文只对应 A 批；并不表示平台运维、实时 Agent 监控或封禁执行链已完成。

## 1. 交付范围

| 客户端 | 管理端 |
| --- | --- |
| 保留原控制台及本人资源库、个人记录 | 新增独立 `apps/admin-console` |
| `/api/user/*` 始终保持本人范围 | `/api/admin/*` 每次验证显式平台角色 |
| 个人空间 `org_admin` 不获得管理权限 | 用户账号、Agent 历史登记列表，只读 |
| Agent 创建、对话、启动与关闭继续禁用 | 不提供封禁、暂停、改角色或操作 Runtime 的接口 |

管理端列表支持有界搜索、游标分页、所属用户与记录状态筛选。`ready` 等状态来自现有数据库记录，**不是实时健康检查**；本批没有 CPU、内存、运行时日志或服务器资源仪表盘。

本批 SaaS 路线：继续复用已接入的 Better Auth 凭据、会话与共享认证限流；按照 `apps/saas推荐.md` 中 Open SaaS 的后台分离思路建立独立管理入口，但不导入 Wasp/Prisma，不维护第二套用户密码，不让 SaaS 的认证成功代替业务授权。没有开启 Better Auth admin 插件的广泛管理接口。后续 Grafana 仍属于运维侧，不向普通客户端开放。

## 2. 先备份，再导入 034

以下操作由你在 Navicat 中使用 DBA 连接执行。开发服务可以先停止。**不是在受限的 `bairui_app` 连接中执行迁移。**

1. 备份 `bairui`，保留可恢复的备份文件；确认此前 031、032、033 已导入。
2. 打开 DBA 连接中的 `bairui` 数据库，先执行：

```sql
SELECT current_database(), current_user, current_schema();
```

应确认数据库为 `bairui`，目标 schema 为 `public`。若你的表在其他 schema，不要直接使用下文的 `public` 示例，先告知实际 schema。

3. 通过 Navicat 的执行 SQL 文件功能导入 `packages/db/migrations/034_platform_admin.sql`。
4. 给应用账号最小权限（以下假设实际应用账号叫 `bairui_app`）：

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM bairui_app;
GRANT USAGE ON SCHEMA public TO bairui_app;
REVOKE ALL ON TABLE public.platform_role_bindings, public.platform_admin_audit FROM bairui_app;
REVOKE ALL ON FUNCTION public.platform_admin_read(text,text,text,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_admin_read(text,text,text,text,integer,text,text) TO bairui_app;
```

应用账号必须是 `NOSUPERUSER NOBYPASSRLS`，不能是数据库/schema/函数的所有者，也不能继承 DBA、函数所有者或可创建对象的角色。不要把 DBA 的连接串写入应用 `.env`。检查：

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
FROM pg_roles WHERE rolname = 'bairui_app';
SELECT has_schema_privilege('bairui_app', 'public', 'CREATE') AS may_create;
SELECT has_function_privilege('bairui_app',
  'public.platform_admin_read(text,text,text,text,integer,text,text)', 'EXECUTE') AS may_read_admin;
```

预期四个权限布尔值 `rolsuper/rolbypassrls/rolcreaterole/may_create` 均为 false，`may_read_admin` 为 true。应用仍使用原受限账号，不需要新增管理员数据库连接串或密钥。

## 3. 由你指定第一个管理员

迁移**不会自动选择邮箱、不会创建默认管理员、不会按组织角色提权**。

先使用已有邮箱正常登录一次客户端，完成 Better Auth 身份与业务用户映射。再由 DBA 查询你选择的邮箱：

```sql
SELECT id, email, display_name,
       coalesce(starts_with(auth_subject, 'better-auth:'), false) AS auth_linked
FROM public.users
WHERE email = '替换为你自己选择的已注册邮箱';
```

确认恰好一行且 `auth_linked = true`，核对返回的用户 ID。将其替换到下方，再单独执行：

```sql
INSERT INTO public.platform_role_bindings(user_id, role, granted_by, reason)
SELECT id, 'platform_viewer', current_user, '双端 A 批首次只读验收'
FROM public.users
WHERE id = '替换为刚核对的用户ID'
  AND starts_with(auth_subject, 'better-auth:');
```

应插入一行。若为零行或主键冲突，先核对账号和既有授权，不要改成无条件批量授权。

三类平台角色已独立建模：`platform_viewer`、`platform_operator`、`platform_admin`。**A 批三者都只有 `users:read`、`agents:read`，首次验收用权限最小的 `platform_viewer` 即可。** 个人空间的 `org_admin` 以及历史组织 `platform_admin` 字段均不代表该授权。

撤销管理端权限：

```sql
UPDATE public.platform_role_bindings
SET revoked_at = now(), reason = '撤销管理端访问'
WHERE user_id = '替换为目标用户ID' AND revoked_at IS NULL;
```

下一次管理 API 请求即拒绝；页面在刷新、恢复焦点或可见时定时检查后清空数据。已经显示过的信息无法追溯收回。**这只是撤销平台管理权限，不是封禁登录或暂停 Agent。**

## 4. 启动与访问

所有本机命令在 Conda `cloud` 环境运行：

```powershell
conda activate cloud
Set-Location E:\cloud-agent
npm run dev
```

已有服务先正常 Ctrl+C 停止，再重启。首次启动会安装新增管理端依赖。默认服务为 API 8080、客户端 Vite 5173、管理端 Vite 5174；没有 Worker 或 Runtime。

- 客户端访问原来的根路径。
- 管理端在**相同域名、相同端口**后加 `/admin/`，例如 `http://localhost:5173/admin/`。
- 必须保持与 `.env` 中 `BETTER_AUTH_URL` 的访问 origin 一致。如果原认证配置是 `http://127.0.0.1:5173`，则使用 `http://127.0.0.1:5173/admin/`。不要混用 localhost 与 127.0.0.1。
- 5174 只是内部开发代理端口，不作为独立认证入口。占用时可设置 `ADMIN_CONSOLE_PORT`，客户端代理与管理端会一起读取，需重启服务。
- 两端共享 Better Auth 会话；在管理端退出，也会使同一浏览器中的客户端会话失效。管理端没有注册、共享开发登录或另一套密码。

预发 Caddy 构建已增加 `/admin/` 静态入口。**A 批初始交付没有部署预发，也没有自动更新现有数据库。** 后续用户明确指定账号后的业务库配置见第 8 节，不代表预发部署完成。新建独立预发会包含 034 和函数执行授权，但不自动选管理员；已有预发仍遵守迁移与版本校验，不允许靠删除状态文件、卷或 Secret 绕过。

## 5. 验收

1. 未登录访问管理端，应显示登录页。
2. 用普通账号登录，应显示“无管理端访问权限”。
3. 用上面显式授权的账号登录，应看到用户列表和历史 Agent 列表；没有历史 Agent 时显示空态。
4. 测试搜索、分页、用户对应 Agent 筛选、记录状态筛选与退出。
5. DBA 撤销该角色后刷新管理端，应拒绝访问，列表清空；普通客户端仍可登录并查看本人资源。
6. 管理账号访问其他用户的 `/api/user/agents/{id}` 仍为 404，不能把客户端接口用作跨用户入口。

自动化验证（新建并清理独立测试库，不读取业务 `.env`）：

```powershell
npm run test:admin
npm run test:admin:web
npm run test:platform
npm run test:scheduler
npm test --prefix apps/platform-api
npm test --prefix apps/console-mvp
npm run build:admin
npm run build --prefix apps/console-mvp
npm run test:preprod:config
npm run test:monitoring:config
```

`npm test --prefix apps/platform-api` 会跳过未指定独立数据库的 PostgreSQL 专项，不能代替 `test:admin` 和 `test:platform`。

### 本次验证结果（2026-09-19）

- 管理后端专项 4 项、管理前端 7 项通过；独立 PostgreSQL 验证双 API、真实会话、显式授权与撤销、RLS、自授角色被拒绝，以及撤去管理表全部权限后仍可通过受限函数读取。
- 平台专项 22 项、模拟调度专项 10 项通过，均使用一次性测试数据库。后端常规回归 161 项通过、3 项 PostgreSQL 专项跳过；这 3 项已由独立数据库命令另行覆盖。
- 客户端回归 13 项、预发配置 54 项、监控配置 20 项通过；两个前端生产构建通过。
- 使用本机 Caddy 镜像实际解析配置，监控开、关两种配置均通过；未据此声称已部署预发或监控。
- Playwright 通过同源代理连接真实 Better Auth 和独立测试库，验证登录、无权限、搜索、分页、所属用户/状态筛选、空态、撤权及退出；检查 1440×960 和 390×844 截图，无页面脚本错误，移动端无整页横向溢出。宽表在表格区域内横向滚动。
- A 批初始独立验收未读取业务 `.env`，未对 `bairui` 或常驻预发执行迁移、授权、重启；后续用户指定首个管理账号后的配置记录见第 8 节。

## 6. 安全与运行边界

- 三个管理 GET 路由：`/api/admin/me`、`/api/admin/users`、`/api/admin/agents`；所有响应 `no-store`，已知路径的写方法为 405。
- actor 只来自服务端 Principal；`role`、`organizationId`、未知参数、重复参数被拒绝。查询每页最多 100 行，按 ID 游标推进，不执行全表总数查询。查询事务有 3 秒语句超时；超时或数据库异常只返回 `admin_unavailable`。
- 数据库只读函数每次复核角色，返回固定字段，不暴露密码哈希、认证 subject、Cookie、Provider Key、配置、内部 Runtime URL 或对话内容。函数固定 schema 引用和 search_path，PUBLIC 无执行权。
- `platform_role_bindings` 和 `platform_admin_audit` 强制 RLS，应用无写策略；即使历史脚本误授普通 DML，也不能自授角色。不要授 TRUNCATE、DDL、所有者或超级用户权限。
- SECURITY DEFINER 函数所有者是受信任 DBA，需要访问 FORCE RLS 数据；应用本身仍不具备 BYPASSRLS。该函数信任平台后端提供的 actor，**不是防御应用数据库凭据泄漏的独立认证层**，不能开放给终端用户直接调用 SQL。大规模公网部署前可进一步分离管理 API 运行身份与凭据。
- 管理查询成功记录 actor、列表类型、返回条数和时间；授权变更记录目标用户与数据库操作者。不记录查询词、邮箱、正文或密钥。审计表不是本批管理 UI 的功能；保留、归档、防篡改外送在治理/运维批次补齐，DBA 仍可修改数据。
- 本批不承诺互联网级容量或强制实时撤权推送；搜索大表性能、专用管理请求限流与管理端 MFA 属于后续生产加固。数据库不可用、缺少 034、缺少 EXECUTE 或函数所有者权限不足时返回 503，不降级成管理员。

## 7. 后续顺序

1. B：客户端本人 Agent 监控，按 Principal/Agent 所有权隔离，明确无数据、采样时间和状态陈旧。
2. C：管理端服务器资源、部署、运维与已有监控体系接入。
3. D：账号与 Agent 治理。已确认：暂停账号服务允许只读登录；封禁账号禁止登录并撤销会话、阻止 Agent 服务；解除封禁不自动启动 Agent。必须覆盖执行器、排队任务、入口票据与审计，不能只改 UI 标记。
4. E：真实 Agent Runtime 接入及配额隔离。

其他环境实际使用管理端前，仍须完成数据库的 A 批迁移与验收，并明确管理员的登录邮箱。B 批独立交付见 `docs/40-dual-console-phase-b.md`；当前业务库管理员配置见下节。不要发送密码、数据库连接串或认证密钥。

## 8. 业务库首个管理员配置（2026-09-19）

用户明确选择了已注册邮箱，并授权其成为首个平台管理员。本次针对 `bairui-postgres` 容器中的 `bairui` 执行，未修改常驻预发。

- 先核对 Better Auth 身份与业务用户一一对应，再生成 PostgreSQL 自定义格式备份。备份位于被 Git 忽略且限制访问权限的 `output/admin-provisioning/`，通过归档解码和复制前后 SHA-256 校验；未进行恢复演练。
- 导入 034，应用继续使用 `bairui_app`，仅增加受限管理查询函数 EXECUTE 权限；管理表无直接读写权限，应用无超级用户、BYPASSRLS、建角色和 schema CREATE 权限。
- 对核对过的唯一用户 ID 授予 `platform_admin`，在 Better Auth 与业务用户两处将显示名称改为 `admin`。事务中确认认证凭据和个人空间成员关系未变，没有创建新用户，授权变更已有审计记录。
- 使用 `.env` 中的真实受限应用连接验证管理身份及用户/Agent 列表读取；其余 4 个账号没有管理权限，两张管理表直接查询均被拒绝。独立 `npm run test:admin` 重新执行，4 项通过。
- 业务库未导入 033 模拟调度表；034 管理查询不依赖该表，本次没有额外导入或启用模拟调度。独立调度测试通过不等于业务库已经迁移。

账号仍用原邮箱、原密码登录，`admin` 是显示名称，不是新增的用户名登录方式；这是为同一身份增加管理权限，不搬迁或删除客户端数据。真实邮箱、密码及连接串不写入本文。

当前开发服务仍是旧进程，内部管理端 5174 未启动。用户需在原开发终端 `Ctrl+C`，进入 Conda `cloud` 后运行 `npm run dev`，再使用与 `BETTER_AUTH_URL` 一致的 origin 打开 `/admin/`。本机已配置为 `http://localhost:5173/admin/`，不要混用 `127.0.0.1`。真实账号的浏览器登录尚未代验，也未为验收读取或重置原密码。

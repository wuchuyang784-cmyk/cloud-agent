# 双端平台 D1：账号治理与技术实现路径

日期：2026-09-20。

本批在现有客户端、管理端和 Better Auth 上增加账号治理闭环，不接模型、不接真实 Agent，不部署服务器。代码验收使用一次性数据库和测试身份，不连接业务 `bairui`，不改变真实管理员、账号密码或常驻预发。

## 1. 交付范围

| 账号状态 | 注册后的再次登录 | 本人业务查询 | 业务写入 | 管理端 |
| --- | --- | --- | --- | --- |
| `active` 正常 | 允许 | 按原所有权授权 | 按原能力开关授权 | 需要显式平台角色 |
| `suspended` 服务暂停 | 允许 | 允许 | 拒绝，返回 403 | 拒绝 |
| `banned` 封禁 | 拒绝，撤销全部现有会话 | 拒绝 | 拒绝 | 拒绝 |

- 只有正常状态的 `platform_admin` 可以提交治理操作。`platform_viewer`、`platform_operator` 可以查看治理状态和审计，不能写入。
- 暂停、封禁和解除均需填写原因。不能操作当前登录账号，也不能限制最后一个有效管理员。
- 解除只恢复账号准入；不恢复旧会话、不恢复已提交失败的业务请求、不启动 Agent、不打开平台关闭的能力。
- 不删除用户、个人空间、资源库、Agent 历史和用量记录，不按邮箱创建重复身份。
- “只读”指业务请求准入；登录、退出、认证映射，以及既有查询初始化默认设置等内部维护行为并不意味着零数据库写入。

## 2. 技术路径

```text
管理端用户列表 / 治理弹窗
  -> Better Auth Cookie 会话
  -> 后端 Principal + 当前账号状态 + 显式平台管理员角色
  -> 同源与 JSON 校验 + 参数边界
  -> PostgreSQL 治理函数
     -> 版本与请求号校验
     -> 更新账号状态 + 封禁撤销会话 + 追加审计（同一事务）
  -> 管理端重新读取状态与审计

客户端请求
  -> Better Auth 解析身份
  -> 每次从 PostgreSQL 读取账号准入状态
  -> 平台能力开关 + 用户/组织/资源所有权与既有 RLS
  -> 业务接口
```

### 2.1 复用 SaaS 认证能力

继续使用已安装的 Better Auth 管理密码、登录和会话；没有另建管理端密码系统，也没有用 SaaS 角色替换平台所有权授权。

`apps/platform-api/src/auth/better-auth-resolver.mjs` 在登录创建会话前检查封禁状态。PostgreSQL 会话表增加触发器作为并发保护：同一认证身份的会话创建与治理事务共享事务级 advisory lock，封禁提交后不能通过并发登录残留有效会话。新用户注册本身处于 Better Auth 事务中，该路径直接由同一连接上的触发器检查，不在钩子中再次申请连接，避免小连接池耗尽时互相等待。

会话 Cookie 缓存和自动刷新继续关闭。封禁事务删除该身份的全部 `ba_session`，解除不会恢复这些记录。MemoryStore 仅供测试/legacy，测试通过 Better Auth 的 `deleteUserSessions` 撤销会话，不能替代生产数据库的事务并发保证。

### 2.2 数据与最小权限

迁移：`packages/db/migrations/036_account_governance.sql`。

| 对象 | 职责 |
| --- | --- |
| `platform_account_governance` | 用户级状态、递增版本、变更时间；从未治理的用户投影为 active / version 0 |
| `platform_governance_audit` | 操作者、目标用户、前后状态、预期版本、原因、请求号、结果与时间 |
| `platform_account_access` | 后端每次请求读取账号状态 |
| `platform_account_session_allowed` | 创建认证会话前检查封禁 |
| `platform_governance_accounts` | 管理列表批量读取账号状态，最多 100 个 ID |
| `platform_governance_read` | 按目标用户读取状态与审计，每页最多 25 条 |
| `platform_governance_change` | 原子治理变更 |

两张新增表强制 RLS，应用账号不直接读写表或使用审计序列。受限函数固定 `search_path`、限定表 schema，撤销 PUBLIC EXECUTE；由 DBA 赋予应用账号所需函数的 EXECUTE。

函数仍信任后端提供的 actor。它们不是应用数据库凭据泄漏后的独立身份认证层；不向浏览器暴露数据库连接，应用账号不得拥有超级用户或 BYPASSRLS。

### 2.3 并发、一致性与重试

- `expectedVersion` 是乐观锁：状态已被别人改变时返回 409，必须刷新确认。
- `requestId` 是 UUIDv4 幂等键，唯一范围为操作者。相同请求重试返回原结果，不重复更新或插入审计；相同请求号携带不同内容返回 409。
- 低频治理写入使用短事务 advisory lock 串行，防止两个管理员同时封禁对方导致无有效管理员。普通业务查询不取得这把全局治理锁。
- 更新状态、撤销会话、写审计必须一起成功或回滚。审计失败时不得显示治理成功。
- 治理数据库查询设置 3 秒 statement timeout；无法确认账号状态时返回 503，不回退为正常状态。它是数据库语句限时，不是对所有外部链路的总耗时保证。
- API 副本共享 PostgreSQL 状态，不依赖单个 Node 进程中的账号状态缓存。

### 2.4 后端接口

`GET /api/admin/users/:userId/governance` 查询状态与审计，可带 `after` 游标。

`POST /api/admin/users/:userId/governance` 提交操作：

```json
{
  "status": "suspended",
  "expectedVersion": 0,
  "reason": "人工核查期间暂停业务写入",
  "requestId": "d3970b87-1857-41fc-a8b0-0df10c76426a"
}
```

示例请求号只说明格式，实际每个新操作生成新 UUID。接口拒绝额外字段、非法状态、非法游标和超长原因；请求体最多 4 KiB，原因 2 至 500 字符，不允许控制字符。POST 必须匹配 `BETTER_AUTH_URL` 的 Origin，且使用 JSON。

后端由当前会话确定操作者；请求体不能指定 actor/owner 来提升权限。客户端的 `/api/user/*` 仍只允许本人范围，所有治理响应为 no-store。

主要实现：`apps/platform-api/src/admin/governance.mjs`、`admin/routes.mjs`、`admin/store.mjs`、`app.mjs`。

### 2.5 双端界面

- 管理端：用户列表增加账号状态、治理入口；弹窗包含当前状态、操作原因、影响提示和审计历史。自操作与只读角色不显示提交表单。
- 请求超时后保留原请求号和参数重试，不把“服务器可能已提交”误显示为失败或成功。409 需刷新；POST 成功但回读失败时明确提示核对状态。
- 退出、切换列表和关闭弹窗通过请求取消与 generation 检查隔离旧响应，防止恢复旧账号数据。
- 客户端：显示暂停横幅；每 30 秒、窗口重新获得焦点、页面重新可见，以及收到暂停拒绝时重新检查身份。不是 WebSocket 实时推送；安全准入由服务端每个请求执行，不依赖横幅是否刷新。
- 客户端原资源库和导航保留。业务写按钮可能仍显示，但暂停后的写请求由后端统一拒绝，并显示中文提示。

界面实现：`apps/admin-console/src/GovernanceDialog.tsx`、`session.ts`、`App.tsx`；客户端 `apps/console-mvp/src/App.tsx`、`api.ts`。

## 3. 业务库启用步骤

本批未自动执行以下操作。代码已读取新治理函数，业务库缺少迁移或授权时将拒绝相关访问，而不是忽略治理。

1. 进入维护窗口，先备份 `bairui`。停止全部旧 API 副本的业务流量，避免新旧版本混跑。不要对正在使用的预发直接执行故障验收。
2. 在 Navicat 确认选中 `bairui`，以 DBA 身份执行 `036_account_governance.sql`。依赖已有基础表、032 Better Auth、034 平台角色；不依赖模拟调度 033。保留当前已使用的 035 基础设施迁移。
3. 仍使用 DBA 执行下面的最小授权。示例应用角色为 `bairui_app`；若实际连接使用其他角色，先核实后替换角色名，不改真实账号密码。

```sql
BEGIN;
GRANT EXECUTE ON FUNCTION
  public.platform_account_access(text),
  public.platform_account_session_allowed(text),
  public.platform_governance_accounts(text,text[]),
  public.platform_governance_read(text,text,bigint),
  public.platform_governance_change(text,text,text,integer,text,uuid)
TO bairui_app;

REVOKE ALL ON TABLE
  public.platform_account_governance,
  public.platform_governance_audit
FROM bairui_app;
REVOKE ALL ON SEQUENCE public.platform_governance_audit_id_seq FROM bairui_app;
COMMIT;
```

不额外授予会话触发器函数 EXECUTE，也不授予应用账号治理表直写权限。如该角色通过角色继承具有额外表权限，需要 DBA 一并核实，不能只依赖上面的直接授权检查。

4. 所有 API 副本升级到相同版本后恢复流量。本地启动继续使用 Conda `cloud` 和 `npm run dev`；无需新增业务密钥。入口仍是客户端 `http://localhost:5173/`，管理端 `http://localhost:5173/admin/`，以实际配置的 `BETTER_AUTH_URL` 为准。
5. 使用原管理员账号登录管理端，选择专门验收账号进行“暂停 -> 封禁 -> 解除”。不要用唯一管理员或真实业务账号试验；不要发密码或密钥给开发工具。
6. 核对暂停账号可再次登录、能读本人资源但不能新增；封禁后旧会话失效且不能登录；解除后需重新登录，资源保留，Agent 执行仍关闭。

`scripts/preprod-config.mjs` 只补齐未来新建独立预发的授权和撤权。已有常驻预发不会自动迁移。执行治理后，不应直接降级到忽略治理状态的旧代码；回滚需要保留同等访问阻断措施。

## 4. 验证入口

全部命令在 Conda `cloud` 执行。以下数据库专项自动创建并清理独立测试数据库，不读取业务 `.env`：

```powershell
conda activate cloud
Set-Location E:\cloud-agent
npm run test:governance
npm run test:platform
npm run test:admin
npm run test:client-monitoring
npm run test:infrastructure
npm run test:scheduler
```

前后端回归与构建：

```powershell
npm test --prefix apps/platform-api
npm test --prefix apps/console-mvp
npm run test:admin:web
npm run build:admin
npm run build --prefix apps/console-mvp
npm run test:preprod:config
```

浏览器专项为 `npm run test:governance:web`，需要先通过 `BAIRUI_PLAYWRIGHT_MODULE` 指向已安装 Playwright 的入口；可用 `BAIRUI_BROWSER_EXECUTABLE` 指定本机已安装的 Chromium。脚本不自动安装工具，不关闭认证限流；收到 429 按 Retry-After 有界重试。它创建一次性数据库、专用 Vite/API 和测试账号，完成后清理，不复用业务服务。

截图输出到 `output/playwright/admin-phase-d1/`，包括桌面、390px 和 320px。

### 4.1 本次实际验证结果

2026-09-20，在本机 Conda `cloud` 完成以下验证；均不代表业务库已迁移或生产环境已部署。

| 验证 | 结果 |
| --- | --- |
| `test:governance` | 13 项通过，无跳过；包含受限角色、双 API、单连接池、会话并发封禁、管理员互封与事务回滚 |
| `test:platform` | 24 项通过，无跳过；在最终认证代码上重跑 |
| `test:admin` / `test:client-monitoring` / `test:infrastructure` | 分别 4 / 7 / 9 项通过 |
| `test:scheduler` | 10 项通过 |
| 后端完整回归 | 173 项通过、6 项跳过、0 项失败；6 项为需专项入口提供独立 PostgreSQL 配置的用例，已分别通过对应数据库专项 |
| 客户端 / 管理端前端测试 | 分别 19 / 13 项通过 |
| 客户端 / 管理端生产构建 | 均通过 |
| `test:preprod:config` | 54 项通过；未启动或修改常驻预发 |
| `test:governance:web` | 真实注册登录、暂停、封禁、解除、资源保留、旧会话失效、权限隔离通过；桌面、390px、320px 无页面横向溢出 |

浏览器专项使用真实 Better Auth 和独立 PostgreSQL，不以模拟响应代替治理链路。注册、登录受到原有限流约束，测试按 `Retry-After` 等待；临时服务和数据库已由脚本清理。

另完成针对会话封禁竞态、连接池事务和账号准入的独立代码审查，未发现本次范围内可复现的严重或重要问题。审查不是全面安全审计，也不替代后续容量测试或部署验收。

## 5. 本批边界与下一步

- 这是账号级准入治理，不是完整 Agent 治理。没有修改 Agent 状态、杀进程、停止 Swarm 服务或回收真实资源。
- 已通过准入检查的在途请求不承诺被撤销。未来接真实 Runtime 前，D2 需要把治理状态接到调度准入、任务取消、停止命令、重试和执行结果回执。
- 封禁后的旧页面可能在下次请求前仍显示已加载内容；服务端已拒绝新的授权访问，不代表能够撤回用户此前获得的数据。
- 本机双 API 与临时数据库测试不是公网生产、跨主机高可用或高并发容量认证。每请求状态查询的数据库开销需要在后续容量阶段测量，不能为提高吞吐而缓存并延迟封禁生效。
- 服务器部署仍按用户决定暂缓，C 批采集与管理端资源页面保持原有边界。

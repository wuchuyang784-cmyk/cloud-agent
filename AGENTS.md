# BaiRui Cloud Agent Platform 项目级协作说明

本文件是仓库级 Codex/Agent 工作指引。进入本项目后，优先遵循本文件，再结合用户当次请求执行。

## 开发环境

- 本项目的开发虚拟环境统一为 Conda `cloud`。交互终端先执行 `conda activate cloud`；自动化工具使用 `conda run -n cloud --no-capture-output <命令>`。
- 不新建其他开发环境，不在 `base` 环境安装本项目依赖。Docker 镜像中的独立运行环境不等同于本机 Conda 环境。

## 当前平台化任务（2026-09-17，优先于下方历史 MVP 说明）

- 当前目标是平台级多用户云 Agent 服务，不再以单用户 MVP 演示作为验收标准。
- 第一阶段先做真实账号、个人空间隔离、页面与数据库记录；调度和真实 Agent 使用分阶段验收。
- 已接入开源 Better Auth 1.7.5，需先导入 031、032 并显式设置 BAIRUI_AUTH_MODE=better-auth；不自动迁移旧账号或按邮箱合并业务数据。
- 控制台未登录时展示注册/登录页，已移除共享开发账号入口。下方“自动开发登录”“不新增登录页”属于旧阶段要求，不再适用。
- 默认 BAIRUI_PLATFORM_MODE=platform：必须 Better Auth + PostgreSQL，关闭用户侧 Agent 写操作、对话执行与模拟充值，保留本人历史查询、资源库与个人记录。前端能力默认关闭，失败/退出/乱序响应不能重新开启。
- npm run dev 在平台模式只启动 API、客户端和管理端前端；旧 Agent Worker/Runtime 的独立入口也拒绝启动。legacy 仅供非生产显式回归，不代表正式 Agent 接入。
- BAIRUI_TRUSTED_PROXIES 默认留空，仅允许真实代理 IP/CIDR；不要信任整个 overlay 或伪造转发头。双 API 共享 Better Auth 数据库限流。实现边界及本机验收见 docs/36-platform-mode-and-auth-proxy.md。
- 认证接入见 docs/33-phase1-better-auth.md，当前平台模式、启动与代理安全以 docs/36-platform-mode-and-auth-proxy.md 为准。保留现有个人空间授权，不自行扩展团队共享。
- Better Auth 承担凭据与会话，平台仍掌握 Principal、业务所有权与 RLS；不得把认证成功等同于业务授权。

## 项目定位

### 双端平台 D1：账号治理（2026-09-20，独立验收，业务库未启用）

- 管理端用户列表可查看账号状态和治理审计；只有 active 的 `platform_admin` 可暂停、封禁、解除。viewer/operator 只读，不能操作自己或限制最后一个有效管理员。
- suspended 允许登录和本人业务查询，拒绝业务写入及管理端访问；banned 禁止登录并撤销全部 Better Auth 会话；解除不恢复旧会话、不启动 Agent、不改变平台能力开关。客户端导航和资源库保留。
- 新迁移 `036_account_governance.sql` 依赖基础表、032、034，不依赖模拟调度 033。治理状态和审计表 FORCE RLS，应用账号只获五个受限函数的 EXECUTE，不直读写治理表或使用审计序列。
- 状态、会话删除和审计在同一事务提交；版本校验、请求 UUID 幂等和短事务锁保护并发治理。会话创建触发器与治理共享身份锁，防止并发登录留下有效会话。缺表、缺权限或状态不确定时拒绝访问，不回退放行。
- 客户端每 30 秒、焦点/可见性变化或暂停拒绝时刷新身份；这不是实时推送。后端每次按账号状态准入，不依赖界面刷新，也不承诺撤销已准入的在途操作。
- `npm run test:governance` 和 `test:governance:web` 使用一次性测试库与测试身份，不读取业务 `.env`；后者需本机已安装的 Playwright/Chromium。不得关闭认证限流以使验收通过。
- 中文技术路径和启用步骤见 `docs/42-dual-console-phase-d1.md`。本批没有迁移业务 `bairui`、修改真实账号或常驻预发。启用前备份、执行 036、最小授权，所有 API 同版升级；不要让忽略治理的旧副本继续接流量。
- D1 仅完成账号准入治理，Agent 强停、调度取消、资源回收和真实 Runtime 仍属后续 D2/E；不能把本批写成真实 Agent 治理或生产高并发已验收。

### 双端平台 C 批：管理端服务器资源（2026-09-20，业务库已接入）

- 管理端 `/admin/` 新增“服务器资源”，展示采集主机 CPU 使用率、逻辑 CPU 数、内存，以及 Swarm 节点容量、非终态任务预留/限制、服务副本和未分配任务。客户端不增加跨用户或服务器管理入口。
- 继续不接模型、模型 API 或真实 Agent；平台模式的 Agent 写入和执行保持关闭。复用 Better Auth、显式平台角色和现有管理端，不增加另一套账号系统。
- 新迁移 `035_platform_infrastructure.sql` 依赖基础表和 034、不依赖 033。两张资源表强制 RLS；应用账号只获读取函数 EXECUTE，独立采集登录账号只获上报函数 EXECUTE，由 DBA 绑定 `session_user` 与采集源。
- 独立采集进程使用操作系统指标和固定只读 Docker CLI，API 不挂载 docker.sock。入口为 `npm run infra:check`、`npm run infra:once`、`npm run infra:collect`；配置独立保存在已忽略的 `.env.infrastructure`，不复用业务 `.env` 或应用账号。
- Windows 主机实测值和 Docker Desktop Linux VM 容量分开；预留/限制不是实际用量。节点实测 CPU/内存仍为 null；每源仅保存最新快照，超过 90 秒标为过期，无数据不补零。
- 采集边界为本机 Docker context、最多 32 节点/128 服务/2048 条任务记录，单轮 Docker 查询最多 20 秒。Docker 只读是本批代码的操作范围，不是对持有 Docker 权限账号的沙箱。
- `npm run test:infrastructure` 9 项通过（含新增 Linux 服务模板静态检查），桌面/390px/320px 浏览器验收通过，包含真实只读采样、过期、不可用、空状态、撤权和普通用户拒绝；管理端、客户端及平台模式回归通过。中文说明见 `docs/41-dual-console-phase-c.md`。
- 用户确认后已备份业务库 `bairui` 并执行 035，配置应用最小读取授权、独立受限采集账号及 `development-host` 源；真实快照入库且经应用投影为 fresh。原管理员授权读取和 4 个普通用户拒绝已验证，不改账号密码或伪造登录会话。
- 本地开发服务已重启，独立采集进程在 `cloud` 环境启动；凭据仅保留于受限本地配置，不进入 Git。未安装 Windows 开机服务，未修改常驻预发。操作记录和备份在已忽略的 `output/infrastructure-provisioning/20260920/`，不要按历史 PID 盲目停止进程。
- Linux 原生采集部署说明及 systemd 模板见 docs/41 第 8 节与 `infra/systemd/bairui-infrastructure.service`。服务器需单独迁移授权、每主机独立源和凭据；manager 采集集群，worker 只采主机。模板未在 Linux 实机部署，Docker 权限仍需明确评审。
- 既有 Prometheus/Grafana 部署、治理封禁、自动扩缩容和真实 Runtime 不属于本批完成范围。

### 双端平台 B 批：客户端本人 Agent 监控（2026-09-19）

- 客户端“开发与部署 / 可观测”已接入本人 Agent 只读列表、搜索、分页和今日/近 7 天/近 30 天的历史用量；不改变原导航、资源库和平台能力开关。
- `/api/user/monitoring/agents` 与明细接口始终按 Principal 的组织、用户和 Agent 所有权授权；平台管理员使用这些客户端接口也不能跨用户。所有响应 no-store，不返回内部 Runtime 地址或事件 metadata。
- `runtime_routes.last_seen_at` 只是生命周期记录，不是持续心跳。超过 5 分钟标为陈旧；真实采样时间、CPU、内存保持 null。用量仅包含已入库事件，不伪造成功率、费用和缺失日期的零值。
- 复用现有表，不新增业务迁移。PostgreSQL 查询语句限时 3 秒；前端请求超时、切换、退出、乱序响应会清空并隔离旧数据。`npm run test:client-monitoring` 建立独立测试库，不读取业务 `.env`。
- 中文接入与验收见 `docs/40-dual-console-phase-b.md`。独立数据库专项 7 项及桌面/手机浏览器验收通过，不代表真实 Runtime 或业务库/常驻预发已部署。
- 用户已明确指定首个管理员的已有邮箱账号。2026-09-19 已备份业务库 `bairui`、导入 034、授予最小函数权限，并将该账号显示名称设为 `admin`、平台角色设为 `platform_admin`；保留原密码、认证身份和个人空间，不新建重复账号。真实邮箱与备份只保留在本地，不写入通用文档。

### 双端平台 A 批：管理入口与只读权限（2026-09-19）

- 管理端为独立 `apps/admin-console`，正式开发入口是客户端相同 origin 的 `/admin/`，内部 Vite 默认 5174。复用 Better Auth 会话，不增加另一套密码、注册或共享登录；管理端退出会使同一浏览器的客户端会话失效。
- 迁移 `034_platform_admin.sql` 建立显式 `platform_viewer/operator/admin` 角色、受限管理查询函数与访问记录。三类角色本批均只读；个人空间 `org_admin`、历史组织角色不能获得管理端权限。
- `/api/admin/me`、`/api/admin/users`、`/api/admin/agents` 每次按服务端 Principal 复核平台授权。固定返回字段、有界游标分页、no-store；`/api/user/*` 继续只允许本人范围。
- 应用账号只授管理函数 EXECUTE，不授 BYPASSRLS 或管理表写权限；两张管理表强制 RLS。SECURITY DEFINER 函数信任后端 actor，不是防止应用数据库凭据泄漏的独立认证层。
- 本批 Agent 状态来自数据库记录，不是实时健康指标。不提供暂停、封禁、改角色或 Runtime 操作。客户端 UI 不增加管理端功能。
- 中文接入见 `docs/39-dual-console-phase-a.md`。当前业务库已在用户明确授权后完成首个管理账号配置；其他环境仍须先备份、迁移并明确指定账号。禁止自动提升其他真实账号或重建预发来绕过迁移。
- 独立验证入口 `npm run test:admin`、`npm run test:admin:web`、`npm run build:admin`。业务库已用真实受限应用连接验证管理员读取、其他 4 个账号拒绝、管理表直读拒绝；真实账号浏览器验收仍需用户重启开发服务后使用原密码完成。常驻预发未修改，不代表监控部署、真实 Agent 或平台治理已完成。
- 后续顺序：B 本人 Agent 监控，C 管理端基础设施观测，D 治理执行闭环，E 真实 Runtime。D 批规则：暂停账号服务允许只读登录；封禁账号禁止登录并撤销会话、阻止 Agent 服务；解除不自动启动 Agent。

### 第三阶段 3.2 监控与本地告警（2026-09-19，代码已验证，未部署验收）

- 入口为 `npm run monitor:up/status/stop/alerts/password`，说明见 `docs/38-phase3-monitoring.md`。源码命令使用各自独立 npm script，不把冒号后的斜线组合当作命令执行。
- 使用 Prometheus、Grafana、Alertmanager 和白名单告警接收器；监控网络独立且内部隔离，Grafana 只经 Caddy 的回环 `9443` 访问，不塞入客户端 UI。
- API 指标默认为关闭；预发启用后使用专用端口和独立 Secret，按 tasks DNS 分别采集两份 API。指标和错误日志不得记录身份、正文、Cookie、原始 URL/SQL。
- 新监控资源归属、卷、Secret 和开关记入现有预发状态。禁止缺失后自动生成替代数据；普通预发启停保留并恢复已接入监控，停止不删卷。
- 本机组合测试 79 项通过，后端与前端回归、独立 PostgreSQL 平台/调度专项通过；Caddy 实际配置解析通过。初始化中断可重试已确认归属的卷根目录权限，不替换 Secret，不修改已完成安装的卷权限。
- Docker Hub 拉取先前返回 EOF，最近重试为官方 registry 连接超时。官方 promtool/amtool、实际部署、故障告警和浏览器验收尚未完成；需用户确认可用代理或批准镜像来源。不得把代码或单元测试通过写成平台运维已验收。
- `test:monitoring` 会暂降仅预发 API 副本并重建监控服务，不对正在使用的预发执行。通知只在本机，不能覆盖整机停机或替代外部告警。

### 第三阶段 3.1 常驻预发（2026-09-18）

- 操作入口为 `npm run preprod:up`、`preprod:status`、`preprod:stop`，说明见 `docs/37-phase3-local-preprod.md`。
- 这是独立 `bairui_preprod` 数据库和 Secret，不读取业务 `.env`，不修改 `bairui-postgres` / `bairui`。下方“Docker 只运行数据库”仅限日常开发，不适用于本独立预发。
- 平台生产模式：Swarm 双 API + 单 PostgreSQL，Caddy 常驻容器只绑定 `127.0.0.1:8443`，提供构建后的控制台。没有任何 Agent/模拟 Worker。
- 不自动信任本地 CA，不自动删除卷或 Secret，不自动迁移已有预发数据库。保留 `output/preprod/state.json`；操作前校验资源归属和本机单节点条件。
- 已有镜像须匹配本安装标签；已完成安装的环境缺少数据库卷或证书卷时，禁止自动创建替代卷并继续启动。
- API 仅信任 Caddy 确切 overlay IP；网关重建先停止 API，再更新代理配置。不得信任整个网段。
- `test:preprod:config` 验证配置/运行入口，`test:preprod` 会重启仅本预发的服务并保留测试账号和资源；不要对正在使用的预发执行故障验收。
- 本批不代表公网生产、跨节点高可用、持续高并发或真实 Agent 已验收；监控、容量及备份恢复须后续交付。

### 第二阶段模拟调度（2026-09-17）

- 首批实现位于 apps/platform-api/src/scheduler/，迁移为 033_simulation_tasks.sql。
- 本机参数：10 测试用户、每用户并发 5、全局并发 10、每 Worker 并发 5。
- 模拟入口默认关闭，需显式开关和账号白名单；生产环境禁用。
- 使用根目录 npm run test:scheduler 验收，自动建立并清理临时数据库，不读取业务 .env。
- 不把双 Store 测试当作 Swarm 多进程或真实资源隔离验收；后续范围见 docs/34-phase2-scheduler.md。
- 独立 Swarm 多进程验收使用 npm run test:scheduler:swarm；只在本机单节点 manager 执行，自动建立与清理本次环境，不读取业务 .env。范围与限制见 docs/35-phase2-swarm-acceptance.md。

- 本仓库位于 `E:\cloud-agent`，当前目标是 BaiRui Cloud Agent Platform 多用户平台；下方引擎实现保留供后续阶段接入。
- 当前用户进入控制台后，可以管理自己的知识库、Skill 等资源和个人记录，Agent 历史数据只读，创建与执行关闭。
- 当前登录采用 Better Auth 邮箱密码认证；管理端、真实计费、团队成员共享与真实 Agent 使用分阶段验收。
- 引擎注册表已含 `mock` / `pi` / `dsh` 三类 adapter：默认 mock（回退实现）；pi 已完成 P1 接入骨架的实装（wrapper + adapter + 基线镜像 Dockerfile），dsh 仍为契约占位。
- SaaS/开源 SaaS 只作为通用能力参考或承接，不接管 Agent 所有权、用户隔离、权限边界、运行时隔离和部署状态。

## 本地一键启动

本机 Docker 只保留数据库容器 `bairui-postgres`，其余服务一律以 node 进程运行（见 docs/32）。

首次使用：

```powershell
npm run setup:env      # 由 .env.example 生成 .env（不进 git），会话密钥随机生成
```

一条命令启动前后端：

```powershell
npm run dev
```

前后端分离启动：

```powershell
npm run dev:api        # 平台模式只启动 api:8080
npm run dev:web        # 前端控制台 :5173
```

约定：

- 配置集中在根目录 `.env`：走脚本时由 `scripts/dev.ps1` 注入全部子进程；单独启动服务时由
  `node --env-file-if-exists=../../.env` 加载。日常不需要手动设置 `DATABASE_URL`。
- `.env` 不进 git，模板见 `.env.example`，真实密码只写本地 `.env`。
- 是否真的连库看 `http://127.0.0.1:8080/healthz` 的 `database` 字段：平台模式必须为 `postgres`；缺少 PostgreSQL 配置会启动失败，不回退 MemoryStore。
- Ctrl+C 停止；脚本按进程树清理，不留残留 node / vite。
- `scripts/*.ps1` 必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会错误解析中文。

## 目录结构

- `apps/platform-api/`：平台后端 API、开发登录、Agent 生命周期、会话、资源库、用量、Worker、引擎注册表（mock/pi/dsh）与 Runtime 实现。
- `apps/platform-api/src/runtime/pi/`：pi 实例 wrapper（镜像/本地子进程，`pi --mode rpc` 常驻 + 信封校验）。
- `apps/platform-api/docker/pi/`：bairui-agent-pi 基线镜像 Dockerfile 与验收说明。
- `apps/console-mvp/`：客户端控制台（保留历史目录名），React + Vite，未登录显示真实注册/登录入口。
- `apps/admin-console/`：独立只读管理端；不得将跨用户接口接入客户端控制台。
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
- 本地启动（均自动加载根目录 `.env`）：以下 Worker/Runtime 命令仅适用于非生产 legacy 回归，平台模式会拒绝它们。

```powershell
npm start --prefix apps/platform-api             # api :8080
npm run start:worker --prefix apps/platform-api   # Outbox 消费者
npm run start:runtime --prefix apps/platform-api  # 模拟 Runtime :8090
npm run start:boundary --prefix apps/platform-api # Runtime Boundary :8091
```

- 日常开发直接用根目录 `npm run dev`，不必逐个启动，也不必手动设置 `DATABASE_URL`。
- 平台模式未设置 `DATABASE_URL` 时拒绝启动；MemoryStore 仅用于显式测试注入或非生产 legacy 回归。
- 设置 `DATABASE_URL` 后使用 PostgreSQL，API 和 Worker 必须使用同一个数据库连接串。
- Agent 引擎选择落在 `agents.engine`（`mock`/`pi`/`dsh`，默认 `mock`）；创建 API 与 Worker 均按 agent.engine 解析运行时。
- 真实 pi 引擎接入需要二选一：`BAIRUI_ENGINE_PI_IMAGE`（docker 形态）或 `BAIRUI_PI_LOCAL=1`（local 形态，需 `pi` CLI）；真实 provider key 只认 `DEEPSEEK_API_KEY` 等官方 env，不存在 `PI_API_KEY`。
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
packages/db/migrations/030_agent_engine_mock_default.sql
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
- 本地启动（根目录 `npm run dev` 已包含前端，无需单独执行）：

```powershell
npm run dev --prefix apps/console-mvp
```

- 构建：

```powershell
npm run build --prefix apps/console-mvp
```

- 控制台是客户端 MVP，不要把管理端能力塞入当前 UI。
- 修改 UI 时优先保持现有 TDesign 风格、紧凑业务控制台布局、8px 以内圆角和现有 CSS 变量。
- 使用现有 Better Auth 注册/登录页；不得恢复共享开发账号或自动开发登录。
- 使用 lucide-react 图标，避免手写图标。
- 不要做营销落地页；用户要的是可操作的业务控制台。

## 常用验证命令

平台能力与双 API 认证数据库验收（一次性测试库，不读取业务 .env）：

```powershell
npm run test:platform
```

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

1. 平台级真实账号、个人空间与数据记录；禁止共享开发账号回流。
2. PostgreSQL 持久化、受限账号、RLS、Store 双实现及隔离测试。
3. 统一平台能力开关，保留客户端导航和资源库，不误开放 Agent 执行。
4. 模拟调度和独立 Swarm 验收，保留可信代理与共享认证限流回归。
5. 真实 Agent、本体资源配额、常驻部署及运维能力需后续单独确认，不把现有 pi 实验性闭环当作平台已上线。

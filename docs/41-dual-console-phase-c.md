# 双端平台 C 批：服务器资源与 Swarm 调度观测

日期：2026-09-20。

本批目标是平台基础设施只读观测，不接模型、外部模型 API 或真实 Agent，不开放平台模式下的 Agent 创建、启动、关闭和对话执行。

## 1. 交付范围

管理端同源入口 `/admin/` 新增“服务器资源”：

| 数据 | 来源与含义 |
| --- | --- |
| 主机 CPU 使用率 | 采集进程所在操作系统的 CPU 累计时间差；逻辑 CPU 数不等于物理核心数 |
| 主机内存 | 操作系统总内存与空闲内存之差，不等同于某个容器的内存工作集 |
| Swarm 节点容量 | Docker manager 返回的节点 CPU / 内存容量 |
| 节点任务预留 | 节点上非终态任务的 Resources.Reservations 合计，含尚未结束的旧任务 |
| 节点任务限制 | 已配置 Limits 合计，另列未设置上限的任务数量；不是实测使用量 |
| 服务调度 | 运行任务、期望副本、启动等待、未分配节点任务，以及每任务预留/限制 |

Windows 原生采集与 Docker Desktop Linux VM 是两个资源域。本批不采集 VM/远程节点实时 CPU、内存使用量，也不采集独立容器用量。Swarm 节点实测字段保持 null。独立 Docker 容器、其他进程不属于 Swarm 预留统计，但会影响主机实测内存和 CPU。

“未预留”只是容量减去任务预留，不是实际空闲量，也不保证任务一定能调度成功；节点可用性、放置约束等另有影响。未限制任务可能使用超出预留的资源，限制合计也允许超过物理容量。采集过程不是 Docker 全局原子事务，短暂滚动变更可能使副本数高于期望值。

## 2. 架构与 SaaS 复用

```text
独立本机采集进程（Node OS + 只读 Docker CLI）
  -> 专用 PostgreSQL 登录角色
  -> platform_infrastructure_report(jsonb)
  -> 强制 RLS 的最新快照表
  -> 平台角色授权的管理 API
  -> 独立管理端 /admin/
```

- 复用当前开源 Better Auth 认证与会话、既有 SaaS 双端分离方式，不引入第二套登录、Wasp 或 ORM。
- 复用显式平台角色：viewer / operator / admin 本批均只读。个人空间管理员不是平台管理员。
- 保留 Prometheus / Grafana / Alertmanager 作为后续历史曲线和告警方案。本批只保存每个源最后一个快照，不另造时序数据库，也不代表 docs/38 的监控栈部署已完成。
- 平台 API 不访问 Docker，不挂载 docker.sock；浏览器刷新只读取入库快照，不触发采集。客户端页面和 API 不增加跨用户资源入口。

## 3. 数据与权限

新增迁移 `packages/db/migrations/035_platform_infrastructure.sql`。依赖既有基础表与 034，不依赖模拟调度 033；不要编辑已经执行过的 034。

- `platform_infrastructure_sources`：DBA 登记源 ID、显示名称和唯一数据库登录角色。
- `platform_infrastructure_snapshots`：每源一行，采样时间、接收时间、最新 payload。两表启用 FORCE RLS，无应用/采集账号直读策略。
- 上报函数根据数据库 `session_user` 绑定源，不信任 payload 内的 sourceId。未登记、停用的采集角色拒绝上报。
- 单快照上限 256 KiB；采样时间仅接受采集器生成的 `YYYY-MM-DDTHH:mm:ss.sssZ` UTC 绝对时间，不接受 `now` 等相对时间或无时区字符串。拒绝未来超过 10 秒、早于 60 秒的采样，旧时间戳和相同时间戳不能覆盖新快照。主机与数据库需保持时间同步。
- SQL 校验上报结构、大小和时间，API 对存储内容再次执行字段白名单与数值校验，不原样转发 JSON；不合法采样显示异常。
- `platform_infrastructure_read(actor)` 每次复核显式平台角色并记录访问审计。它信任服务端 actor；并非数据库应用凭据泄漏后的独立认证层。
- API `GET /api/admin/infrastructure` 不接受任何查询参数，只读、no-store，数据库语句限时 3 秒。每次最多显示 20 个采集源，超出明确提示。
- 未收到数据为等待；采样/接收任一超过 90 秒为过期，旧值带过期提示；无效样本清空数值。没有源时显示未配置，不生成演示数据。
- `/api/admin/me` 在现有平台角色授权后由应用补充 `infrastructure:read` 能力。035 或 EXECUTE 未配置时，仅资源请求返回通用 503，不绕过授权、不回退 MemoryStore。

采集命令只使用固定只读 CLI 操作、白名单字段、有限输出和超时。单次 Docker 采集最多 20 秒，单命令最多 5 秒；最多 32 节点、128 服务、2048 条任务记录，包含 Docker 保留的历史记录。超过边界或中途失败会整体标为不可用，不展示部分合计。多节点大规模容量需后续调整采集方案。

注意：拥有 Docker CLI/socket 访问权限的操作系统账号本身通常有很高的 Docker 权限。本批的“只读”是采集代码操作范围，不是 Docker daemon 的权限沙箱。专用数据库账号只隔离数据库权限；生产部署采集器仍需单独评审其主机权限，不能直接把应用容器加入 Docker 管理组。

## 4. 在业务数据库启用（人工确认后操作）

以下是其他环境的接入步骤。本机 `bairui` 已在用户确认后完成接入，见第 7 节；不要在本机重复创建账号或重置采集密码。常驻预发没有修改。不要向聊天发送密码或连接串。

### 4.1 备份、迁移、应用授权

先备份 `bairui`。在 Navicat 中选中正确数据库，以有权执行迁移的 DBA 连接运行 035。已有 031、032、034 不需要重建；035 不是完整初始化脚本。

以 DBA 执行以下授权（仅当实际应用角色名是 `bairui_app`；否则替换成实际角色名）：

```sql
GRANT EXECUTE ON FUNCTION public.platform_infrastructure_read(text) TO bairui_app;
REVOKE ALL ON TABLE public.platform_infrastructure_sources,
  public.platform_infrastructure_snapshots FROM bairui_app;
```

不要给应用账号授予 BYPASSRLS、上报函数或采集源表写权限。

### 4.2 配置独立采集账号

首次创建时以 DBA 执行；如果同名角色已经存在，先检查归属与权限，不直接覆盖它：

```sql
CREATE ROLE bairui_infra_collector LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE bairui TO bairui_infra_collector;
GRANT USAGE ON SCHEMA public TO bairui_infra_collector;
GRANT EXECUTE ON FUNCTION public.platform_infrastructure_report(jsonb) TO bairui_infra_collector;

INSERT INTO public.platform_infrastructure_sources(source_id,label,login_role)
VALUES ('development-host','本机开发服务器','bairui_infra_collector');
```

该角色创建后没有密码。在 Navicat 的角色管理中为它设置独立随机密码；也可在已连接正确数据库的 DBA `psql` 终端使用 `\password bairui_infra_collector` 交互设置。不复用 postgres、bairui_app 或管理员登录密码。采集账号不需要任何业务表权限。

### 4.3 配置、试运行、持续采集

在项目目录将 `.env.infrastructure.example` 复制为 `.env.infrastructure`，它已被 Git 忽略。只在本机填写：

```dotenv
BAIRUI_INFRA_DATABASE_URL=postgresql://bairui_infra_collector:经过URL编码的独立密码@数据库主机:数据库端口/bairui
BAIRUI_INFRA_SWARM=1
BAIRUI_INFRA_DOCKER_CONTEXT=desktop-linux
```

主机和端口沿用你实际数据库连接，不能照抄占位符。密码中的特殊字符需要 URL 编码。远程数据库应按实际部署配置 TLS。不要使用应用账号连接串，不要把业务 `.env` 复制成采集配置。

```powershell
conda activate cloud
Set-Location E:\cloud-agent
docker context show
npm run infra:check
npm run infra:once
npm run infra:collect
```

- `infra:check`：只读检查并输出白名单采样，不连接数据库，不执行部署或扩容。
- `infra:once`：尝试上报一次，然后退出；失败返回非零退出码。
- `infra:collect`：持续上报，每次结束后等待 15 秒，不并发堆叠；Ctrl+C 停止。上报失败日志不输出连接串、SQL 或原始 Docker 错误。
- 仅接受本机 npipe/unix Docker context；远程 ssh/tcp context 或继承的 DOCKER_HOST 会被拒绝。不是 manager、Docker 停止或权限不足时，主机指标仍可采集，但 Swarm 标为不可用。
- 不自动加入 `npm run dev`，不自动注册 Windows 服务，也不自动获取 Docker 管理权限。

迁移与应用授权完成后，重启开发 API；沿用已有 `npm run dev` 和同源入口，在 `/admin/` 用原管理员账号登录，点击“服务器资源”。不要另开一套同端口开发服务。

### 4.4 撤销与停止

Ctrl+C 停止采集后，页面会在 90 秒阈值后标为过期。停用某个源并拒绝其后续上报：

```sql
UPDATE public.platform_infrastructure_sources
SET enabled=false WHERE source_id='development-host';
REVOKE EXECUTE ON FUNCTION public.platform_infrastructure_report(jsonb) FROM bairui_infra_collector;
```

重新启用需要 DBA 恢复源和明确授权，不会自动删除历史快照或生成替代凭据。

## 5. 预发和验证

新建独立预发时，bootstrap 包含 035，应用账号仅获读取函数权限，新增敏感表不获直读权限；不会自动创建采集账号。现有预发数据库不自动迁移，须另行备份并确认维护窗口。不要为了展示数据重建预发卷或改用业务库。

```powershell
npm run test:infrastructure
npm run test:admin
npm run test:admin:web
npm run build:admin
npm run test:preprod:config
```

专项测试自动创建/清理一次性 PostgreSQL 容器，不读取业务 `.env`，覆盖两份 API、受限应用/采集身份、RLS、撤权、时间重放、畸形与超大采样，以及无 033 的迁移路径。

可选真实浏览器验收：设置 `BAIRUI_PLAYWRIGHT_MODULE` 为本机已安装 Playwright 的 `index.mjs` 绝对路径；可用 `BAIRUI_BROWSER_EXECUTABLE` 指定已安装浏览器，然后运行 `npm run test:infrastructure:web`。它要求本机 Swarm manager，使用真实只读采样、临时数据库和临时账号。截图存于 `output/playwright/admin-phase-c/`，退出时清理自己的服务与测试容器。

本批不等于自动资源分配策略、弹性扩缩容、治理暂停/封禁、节点实时用量、Prometheus 告警部署或真实 Agent 已完成。下一批仍按双端计划进入 D 治理执行闭环，真实 Agent 留在 E 批。

## 6. 本次验证记录

2026-09-20，在 Conda `cloud` 中完成：

| 验证项 | 结果 |
| --- | --- |
| 资源采集与 PostgreSQL 专项 `test:infrastructure` | 8 项通过，含独立采集登录身份、双 API、RLS、时间重放和撤权 |
| 管理端数据库 `test:admin` / 前端 `test:admin:web` | 分别 4 项、11 项通过 |
| 平台模式 `test:platform` | 24 项通过，Agent 写入和执行限制保持关闭 |
| 客户端本人监控 `test:client-monitoring` / 客户端前端 | 分别 7 项、18 项通过 |
| 后端通用回归 | 168 项通过、5 项专用数据库用例在通用入口跳过；相应独立专项另行执行 |
| 预发配置 `test:preprod:config` | 54 项通过，未执行常驻预发重启或故障试验 |
| 管理端构建 `build:admin` | TypeScript 与 Vite 通过 |
| 浏览器 `test:infrastructure:web` | 真实本机采样经受限测试数据库、Better Auth、管理 API 到页面的闭环通过 |

浏览器覆盖桌面 1440px、手机 390px/320px、无页面级横向溢出、采样过期、Swarm 不可用、等待采集、无采集源、角色撤销和普通用户拒绝；已人工核对截图。测试使用独立账号和数据库，结束后临时服务与数据库容器已清理。

本机系统在采样时报告 8 个逻辑 CPU、约 15.8 GiB 内存；Docker Desktop 节点容量约 7.6 GiB 内存。它们是本次机器观测，不是生产容量承诺，验收时负载也不是日常基线。

上表记录初次独立验收结果；后续业务环境接入记录如下。Linux 服务模板加入后，`test:infrastructure` 增加 1 项静态配置约束测试，不等于 Linux 实机部署验收。

## 7. 本机业务环境接入记录

2026-09-20，用户确认后完成：

- 核实业务连接目标为本机 `bairui`、应用账号为 `bairui_app`，不是独立预发数据库。
- 迁移前生成 `output/infrastructure-provisioning/20260920/bairui-before-035.dump`，校验归档目录、文件大小及 SHA-256；这不是异机恢复演练。备份含业务数据，只保留本地，不提交 Git。
- 执行 035，应用账号只授权资源读取函数，并撤销两张资源表的直接权限。
- 创建独立 `bairui_infra_collector` 登录角色，绑定 `development-host` / “本机开发服务器”。随机密码只保存于 `.env.infrastructure`，未输出到日志、聊天或命令参数；配置及备份目录限制为当前 Windows 用户和 SYSTEM 访问。
- `infra:check`、`infra:once` 成功；真实数据库中的快照经应用层白名单投影后为 fresh，Swarm 为 ok。当前读到 1 个节点、2 个服务。采集只查询已有 Swarm，没有部署、扩容或重启这些服务。
- 使用真实受限连接验证：显式管理员可以读取，4 个普通用户被拒绝；采集账号无法查询用户、Agent 或资源表，应用账号不能上报快照。
- 本地开发服务已重启，独立采集进程已在 `cloud` 环境启动；进程记录及脱敏日志位于同一个本地接入目录。Windows PowerShell 采用隐藏窗口的原生 `Start-Process` 启动，避开 Node detached 启动后未执行脚本即退出的问题。没有注册 Windows 开机服务，不代表关机后会自动重启。
- 接入后复验：`test:infrastructure` 9 项、`test:admin:web` 11 项及 `build:admin` 通过；独立数据库浏览器完整闭环再次通过。真实开发入口健康检查显示 postgres，管理页返回 200，匿名资源 API 返回 401；真实管理页在干净浏览器会话展示登录表单且无页面异常。

访问 `http://127.0.0.1:5173/admin/`，沿用原管理员账号及密码，进入“服务器资源”，点击刷新查看新快照。没有重置管理员密码或代建登录会话；真实账号浏览器验收由用户在自己的会话完成。

以后关闭/重启电脑后，在两个 `cloud` 终端分别运行 `npm run dev` 和 `npm run infra:collect`。当前后台实例运行期间不要重复启动同端口服务或第二份相同源的采集器。采集日志在 `collector.stdout.log` / `collector.stderr.log`，开发服务日志在 `dev-native.stdout.log` / `dev-native.stderr.log`；有效进程记录为 `collector-process.json` / `dev-native-process.json`。此前 `dev-process.json`、`dev-retry-process.json` 为失败启动记录，不是有效服务。核对实际命令后才能使用记录中的 PID，不能按陈旧 PID 直接停止进程。

## 8. 后续部署到 Linux 服务器

管理端页面和 API 不需要写死服务器地址。关键是把采集器放到目标服务器上，并让它将快照上报到该平台使用的数据库；只部署 Web/API 不会自动产生服务器指标。

### 8.1 部署位置和多节点

- 单服务器：主机原生运行一个采集器；若该机为 Swarm manager，可同时采集主机用量与集群节点、服务、任务分配。
- 多节点：在选定的一个 manager 上开启 `BAIRUI_INFRA_SWARM=1`，读取全局节点容量和调度。每台需要展示真实 CPU/内存的主机另外运行自己的采集进程；非 manager 设 `BAIRUI_INFRA_SWARM=0`。
- 每台主机使用独立数据库登录角色、唯一 `source_id` 和明确的服务器名称，例如 `server-manager-01`。重复第 4.2 节并替换角色和源，分别设置随机密码；不要让多台主机共用 `development-host` 或同一采集身份，否则会覆盖同一份最新快照。
- 本批按采集源分别展示主机实测值；不会自动把主机源和 Swarm 节点做关联。Swarm 节点表中的“实测未采集”不因另有主机源而改为已采集；节点容量、预留、限制、任务状态已能展示。
- 必须在宿主机原生运行，不能直接将此采集进程塞进平台容器后宣称得到了宿主机用量。API 和前端仍不需要 Docker socket。

### 8.2 配置和权限准备

服务器操作系统、部署目录、Node 路径、数据库内网地址、TLS/CA 和是否已有 Swarm，需部署时依据实际环境确认。本节提供模板，不会自动初始化 Swarm、打开数据库公网端口或授予主机权限。

1. 将本项目及锁文件对应的后端依赖部署到 `/opt/bairui/cloud-agent`，或统一调整以下模板中的路径。使用与项目验收一致的 Node 24，确认 `node --version`、`command -v node`；本机开发仍使用 Conda `cloud`。服务器服务账户需能读取代码和依赖，不能写入它们。
2. 对目标数据库先备份、迁移 035、授予应用读取权限，再创建该服务器的独立采集角色及源。不要复制本地 `.env`、管理员密码或本地采集身份作为生产配置。
3. 只允许采集主机经受控内网/防火墙访问数据库。跨主机连接按实际 CA 配置验证服务器身份的 TLS，例如连接串使用 `sslmode=verify-full` 和 `sslrootcert`；不要通过关闭证书验证来解决连接问题。CA 文件需允许采集账户只读访问。
4. 在 Linux 本机检查 `docker context show`；通常使用本地 `default` context，而不是 Windows 的 `desktop-linux`。不能配置远程 tcp/ssh context 或继承 `DOCKER_HOST` 来代采远端主机。
5. 将该节点的独立配置存放于 `/etc/bairui/infrastructure.env`，仅 root 可读写，配置键如下。密码仅通过受控编辑/凭据配置写入，不放到 shell 历史中。

```dotenv
BAIRUI_INFRA_DATABASE_URL=postgresql://该节点采集角色:URL编码的独立密码@数据库内网主机:端口/平台数据库
BAIRUI_INFRA_SWARM=1
BAIRUI_INFRA_DOCKER_CONTEXT=default
```

有 Docker socket 访问权的账号具备高权限；Docker 官方也明确提醒 `docker` 组具有 root 级权限。下面的 manager 模板显式申请 `SupplementaryGroups=docker`，只有确认信任该采集器后才启用。只采主机用量的 worker 应删除该行并设置 `BAIRUI_INFRA_SWARM=0`，不需要 Docker 权限。只读采集代码不是 daemon 权限隔离机制。

### 8.3 systemd 常驻模板

仓库模板：`infra/systemd/bairui-infrastructure.service`。它不运行 API、Agent 或部署命令，使用专用系统账号；通过 `LoadCredential` 将配置以服务凭据文件交给 Node，不把数据库连接串写在 unit 中。要求服务器 systemd 支持 `LoadCredential`，Node 支持 `--env-file`。当前 Windows 本机没有安装或执行此 Linux 服务，落地时必须进行实机验收。

由服务器运维管理员先创建 `bairui-infra` 系统用户及同名组，准备 root 拥有、服务账户只读的代码和依赖、root 0600 的凭据文件，以及 `/etc/bairui/docker` 只读配置目录；确认本地 Docker context/socket 权限。随后审阅模板中的用户、路径、Docker 组权限，再执行：

```bash
sudo install -m 0644 infra/systemd/bairui-infrastructure.service /etc/systemd/system/bairui-infrastructure.service
sudo systemd-analyze verify /etc/systemd/system/bairui-infrastructure.service
sudo systemctl daemon-reload
sudo systemctl enable --now bairui-infrastructure.service
sudo systemctl status bairui-infrastructure.service --no-pager
sudo journalctl -u bairui-infrastructure.service -n 30 --no-pager
```

不要在准备凭据时用 `install /dev/null` 覆盖已有配置，不要把 `.env.infrastructure` 提交到仓库。服务文件中的 `/usr/bin/node` 需改为服务器实际 Node 路径；不要指向无法被专用用户读取的个人目录。采集失败会继续重试并输出脱敏日志；systemd 进程存活不等于快照新鲜，验收以管理页面采样时间为准。

### 8.4 服务器验收

1. 原管理员正常登录同源 `/admin/`，服务器资源中出现正确的服务器名称、CPU/内存以及采样时间，刷新后采样时间持续推进。
2. 在 manager 上比对 `docker node ls`、`docker service ls` 与页面节点和服务状态。确认预留不是实测用量，worker 的主机指标不会被误标为集群采集。
3. 使用普通账号确认管理端拒绝访问；采集数据库账号仍无法直读业务表。
4. 在确认的维护窗口停止该采集服务，90 秒阈值后页面显示过期；恢复采集后刷新恢复正常。不停止数据库、API 或其他 Swarm 服务来做此项测试。

历史曲线、阈值告警与主机故障的外部通知仍属于后续 Prometheus/Grafana/Alertmanager 运维部署，不在本次接入中冒充完成。

参考官方资料：Docker 的 Manage nodes / Linux post-installation steps、systemd.exec 的 LoadCredential、node-postgres 的 SSL 配置。服务器实装前按目标发行版核对支持情况。

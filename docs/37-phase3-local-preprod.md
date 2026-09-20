# 第三阶段 3.1：本机常驻预发环境

## 本批目标与边界

本批把第二阶段的一次性验收扩展成可重复启动、保留账号和资源的预发环境。继续使用开源 Better Auth、PostgreSQL、Docker Swarm、Caddy，不新增身份系统或调度框架。

**这不是公网正式上线，也不是第三阶段全部完成。** 单节点、单数据库、单网关仍存在单点故障；监控告警、持续压测、备份恢复和真实 Agent 接入尚未交付。

平台模式始终开启：允许真实注册登录、个人空间和资源库；禁止 Agent 创建/启停/执行、模拟充值、模拟调度入口。本环境不运行任何 Agent Worker、Runtime 或模拟 Worker。

## 与原环境的区别

| 项目 | 日常开发 | 本机预发 |
| --- | --- | --- |
| 入口 | `npm run dev`，控制台端口 5173 | `npm run preprod:up`，`https://localhost:8443` |
| 控制台 | Vite 开发服务 | 镜像中的构建后静态文件 |
| API | 本机 Node 进程 | Swarm 两份 API 副本，非 root 用户 |
| 数据库 | 现有 `bairui`，由业务 `.env` 配置 | 新的独立 `bairui_preprod`，不读取业务 `.env` |
| 凭据 | 本地 `.env` | 独立随机密码/会话密钥，通过 Docker Secret 挂载 |
| 账号 | 已有业务账号 | 需要重新注册，不复制旧账号和业务数据 |

`bairui-postgres`、原数据库、业务 `.env`、5173/8080 服务均不由预发命令操作。无需在 Navicat 给本环境导入 SQL，也不需要把数据库密码发给任何人。

## 架构和资源预算

```text
浏览器 -> 127.0.0.1:8443 -> Caddy HTTPS / 静态控制台
                              |
                         edge overlay
                              |
                        API x 2 (8080 私网)
                              |
                         data overlay
                              |
                     PostgreSQL (5432 私网)
```

- API 与数据库是 Swarm 服务；Caddy 是常驻容器，以便明确只绑定宿主机 `127.0.0.1`。不使用对外发布的 Swarm ingress 端口。
- 数据库固定在首次安装的单一 manager 节点，使用命名数据卷。切换 Docker 节点/上下文时脚本拒绝操作。
- Caddy 从 `tasks.bairui-preprod_api` 发现 API，API 仅信任 Caddy 的确切 overlay IP `/32`。不信任整个 overlay；网关重建时先停 API，再按新 IP 部署。
- API 每份上限 `0.75 CPU / 384M`，数据库 `1 CPU / 1G`，网关 `0.25 CPU / 128M`。这是 4 核/16GB 本机的初始预算，不是已证明的承载人数。
- API 每份连接池上限 10，连接超时 2 秒、查询超时 5 秒。滚动更新期间可能临时多一份 API。
- 只新增属于本环境的专用网络、卷、Secret、Config 和镜像；先核对安装标记再复用/停止。不能接管同名且不属于本安装的资源。
- 已有镜像必须包含本安装的归属标签；标签缺失或不符时拒绝复用，不以镜像名称相同作为可信依据。
- 数据库应用角色 `bairui_preprod_app` 无超级用户、绕过 RLS、建库或建角色权限。业务查询仍使用 Principal 范围与 RLS。
- Docker 日志设置轮转；没有挂载 `docker.sock`，没有把凭据写入服务环境变量清单、构建上下文或验收报告。

## 启动

要求 Docker Desktop 使用 Linux 容器，本机 Swarm 已初始化且只有一个 manager 节点；沿用已通过第二阶段验收的本机配置。若条件不满足，脚本停止，不自动初始化或退出 Swarm。

```powershell
Set-Location E:\cloud-agent
npm run test:preprod:config
npm run preprod:up
npm run preprod:status
```

首次启动会构建镜像、创建独立 Secret、在空数据卷执行现有迁移及受限角色授权。迁移初始化完成后才报告数据库就绪。不要中途删除 `output/preprod/state.json`、数据卷或 Secret。

再次执行 `preprod:up` 不生成新密码、不清空数据库。源文件内容生成本地镜像版本；源代码变化时重新构建。数据库迁移文件的指纹变化时**拒绝自动更新旧库**，需要另行确认备份与迁移方案。

只访问 `https://localhost:8443`，不要改用 `127.0.0.1`、HTTP 或 5173；证书和 Better Auth 的同源地址固定为前者。

## 本地证书：由你确认信任

Caddy 生成本环境独立的本地 CA。脚本只导出公开证书 `output/preprod/root.crt`，**不自动导入 Windows 信任，也不会要求关闭系统的 TLS 校验**。首次打开时出现证书不受信任提示是预期情况。

先确认文件来自刚刚启动的本项目环境。可查看证书 SHA-256 指纹，并与 `output/preprod/state.json` 的 `certificateFingerprint` 比较：

```powershell
node -e "const fs=require('node:fs');const {X509Certificate}=require('node:crypto');console.log(new X509Certificate(fs.readFileSync('output/preprod/root.crt')).fingerprint256)"
```

信任根 CA 会让当前 Windows 用户信任其签发的证书，仅对确认属于自己的本机环境执行。确认后，由你在 PowerShell 运行：

```powershell
Import-Certificate -FilePath E:\cloud-agent\output\preprod\root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

随后关闭并重新打开浏览器，再访问预发地址。部分浏览器/内嵌浏览器可能使用独立信任库，应遵循其证书管理方式，不要通过关闭全局安全校验解决。

CA 私钥保存在专用 Caddy 数据卷中，不会导出。不要分享此卷内容。`preprod:stop` 不删除证书，也不改变 Windows 的证书信任。

## 日常操作

```powershell
npm run preprod:status   # 运行/健康副本数、网关和就绪检查
npm run preprod:stop     # 停本环境，保留账号、资源、Secret 和所有数据卷
npm run preprod:up       # 恢复本环境
```

Docker Desktop 启动后，期望副本数非零的 Swarm 服务由 Swarm 恢复；网关配置为 `unless-stopped`。执行过 `preprod:stop` 的环境需再次 `preprod:up`。主机/Docker Desktop 整机重启恢复尚未作为本批实测结论。

两个 API 支持逐份滚动替换，失败策略为回滚；数据库更新采用先停后起，避免同一数据卷同时被两个实例写入。单网关更新会短暂中断入口，不能承诺零停机部署。

本批没有自动删除环境或自动轮换密钥命令。Secret 缺失时拒绝继续，避免新密码与已初始化数据库不一致。部署失败会保留现场，不清库。

已经完成安装的环境若缺少 PostgreSQL 数据卷或 Caddy 证书卷，`preprod:up` 会在构建镜像或启动资源前停止，不能把数据丢失当作首次安装。只有仍处于首次初始化的环境允许补建尚未创建的卷，不重置已存在的卷。

## 健康检查与停机

| 接口 | 含义 | 数据库故障时 |
| --- | --- | --- |
| `GET /livez` | HTTP 进程存活，不调用认证和数据库 | API 内部仍为 200 |
| `GET /readyz` | 当前可用，检查数据库 | API 内部为 503 |
| `GET /healthz` | 兼容原健康接口 | API 内部为 503 |

探针不需要登录，禁止缓存，不返回数据库错误详情。就绪检查最多等待 2 秒，共用一个未完成的数据库检查，避免探针累积占用连接池。数据库短暂故障不触发基于 `/livez` 的连续重建。

退出先拒绝新工作，等待 HTTP 请求结束，再关闭数据库连接池；超时强制结束连接，进程退出有总时间上限。数据库重启导致空闲连接失效时，记录不含连接信息的错误标记，而不是让进程崩溃。

事务出错后，只有确认 `ROLLBACK` 成功的连接才能回到连接池；回滚失败或超时就销毁连接，保留原请求错误。该规则同时覆盖身份建档、用户范围、Outbox 和模拟调度事务，避免不确定的旧事务被下一个请求复用。回归测试含真实 `pg` 驱动的查询及排队回滚双超时，不连接业务数据库。

Caddy 可能在无可用上游时返回 502/503；内部就绪/存活语义应直接针对 API 检查，不能将网关可达等同于数据库可用。

## 自动验收

```powershell
npm run test:preprod
```

**此命令会短暂重启该预发环境的 API、数据库和网关。不要在有人正在操作预发时执行。** 不操作业务环境。使用两名新测试用户，不使用真实邮箱密码；测试账号和资源会保留，报告不保存密码或会话 Cookie。

覆盖范围：

1. 使用导出的 CA 验证 HTTPS，静态页面/JS 可加载，丢失的静态资源返回 404。
2. 注册、退出、重新登录；安全 Cookie；同一会话在两份 API 有效。
3. 资源属于当前 Principal；伪造 owner/org 无效；跨用户查询、修改、删除返回 404。
4. 受限数据库角色与无 scope 的 RLS；伪造转发头不控制实际认证来源地址。
5. Agent 写操作与模拟充值返回 403，生产环境模拟入口不可用。
6. 两份 API 滚动重建后保留会话与资源。
7. 数据库停止时内部探针为存活 200、就绪 503；数据库容器重建后数据恢复，API 进程不崩溃。
8. 完整 `stop/up` 后 Secret 身份不变，会话、资源和跨用户隔离仍有效。

报告位于 `output/preprod/acceptance-*.json`，只有 `success: true` 才代表本轮完整通过。这不是持续压测或跨节点高可用验收。

## 本批实测记录（2026-09-18）

本机完整验收已通过，复核修复后的记录为 `output/preprod/acceptance-2026-09-18T12-13-56-801Z-dd9676.json`，镜像版本为 `bdd48079cfefc429`。该轮覆盖上述 8 类检查，包括 API 滚动替换、数据库停机及容器重建、完整停止后恢复。最终状态为双 API 健康、单数据库健康、Caddy 运行、就绪接口 200。业务容器 `bairui-postgres` 未被本批重启或修改。

| 验证 | 结果 |
| --- | --- |
| `npm run test:preprod:config` | 45 项通过，含镜像归属、缺卷保护及事务超时回收 |
| `npm test --prefix apps/platform-api` | 112 项通过；2 项数据库集成用例在独立专项执行，不以跳过代表通过 |
| `npm run test:platform` | 22 项通过，包含双 API 认证与 PostgreSQL 隔离 |
| `npm run test:scheduler` | 10 项通过，包含 PostgreSQL 调度验收 |
| `npm test --prefix apps/console-mvp` | 13 项通过 |
| `npm run build --prefix apps/console-mvp` | 构建成功 |
| 浏览器实际操作 | 桌面 1440x900、手机 390x844 检查通过 |

浏览器通过页面实际完成注册、登录、新建知识库、读取正文、分类切换及刷新后读取；空表单和错误密码被拒绝；退出后个人信息与资源接口返回 401，刷新仍停留在登录页。原 Agent 导航保留，创建与模板使用按钮禁用。检查到的登录、注册和资源库页面没有运行时异常或横向溢出。

完整浏览器记录为 `output/preprod/browser-acceptance.json`；最终镜像的补充复检为 `output/preprod/browser-recheck.json`，确认更新前的账号、资源正文与刷新会话仍然有效，并再次验证禁用能力、错误密码和退出后 401。截图为同目录 `browser-*.png`。为检查未被系统信任的本地证书，只有隔离的测试浏览器上下文忽略证书错误；完整 HTTPS 验收仍使用导出的 CA 严格校验，没有改变系统信任设置。

本批留下自动验收用户及资源，均仅在独立预发数据库中，报告不保存密码或 Cookie。你在预发页面应自行注册账号，不使用自动验收账号，也不把原 `bairui` 账号的存在视作已经迁移。

## 故障排查

```powershell
npm run preprod:status
docker service ps bairui-preprod_api --no-trunc
docker service ps bairui-preprod_db --no-trunc
docker logs --tail 60 bairui-preprod-gateway
```

镜像构建日志位于 `output/preprod/build-api.log` 与 `build-web.log`。不要把数据库/认证日志、完整请求头、`.env` 或 Secret 内容公开分享。

- **8443 占用**：确认占用者，不由脚本停止其他程序。
- **同名资源归属不匹配**：核对原安装记录；不要删除卷或自行认领。
- **持久卷缺失**：停止部署，检查 Docker 上下文与原有卷，先确认备份恢复方案；不要删除状态文件来绕过保护。
- **数据库初始化失败**：保留现场检查迁移日志。已有卷不会自动重跑全部 SQL，不能靠重启覆盖错误。
- **Secret 不完整或安装记录丢失**：停止进一步部署，先确认现有卷和 Secret 的恢复方案。
- **存在 operation.lock**：先检查是否仍有预发命令运行。不要并行执行 up/stop/验收。无效锁或无法判断的锁不会被自动忽略。

## 后续批次

先在本常驻环境上增加可观测性与告警，再做持续负载测试和容量测量、数据库备份恢复演练，最后单独确认真实 Agent 的接入与资源隔离。当前双 API 和重启恢复不等于已具备公网生产服务能力。

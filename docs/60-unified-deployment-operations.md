# 常驻预发：单副本与统一运维入口

本批复用用户明确选择的**现有常驻预发**。继续使用原单节点 Swarm，保留 `bairui-preprod` 安装身份、`bairui_preprod` 数据库、卷、Secret、证书和同源管理端，不迁移到 Compose、不合并业务 `bairui` 数据库。代码批验收见第 6 节；2026-11-22 用户另行授权本机恢复部署，记录见第 7 节，云服务器未操作。

## 1. 数量与默认行为

默认一个 API、一个 PostgreSQL、一个包含客户端及管理端静态网页的 Caddy：共 **3 个常驻容器**。监控仍保留 Prometheus、Grafana、Alertmanager 和接收器：启用后共 **7 个**；启用 M1 的 exporter/sampler/bridge 后共 **10 个**。已安装的预发 E3 Controller/编排器另加两个。公告发布器原独立 systemd/进程继续按其专用部署说明管理，本批没有新增或自动启动公告容器。

副本减少不代表镜像删除：多个组件仍可复用 API 镜像，历史镜像留作恢复，不执行 prune。未启用的监控、主机采集、Runtime 不会被统一命令自动安装。已启用模块继续沿用原 stop/up 联动和配置，不静默撤销已有监控或 Runtime。

`state.apiReplicas` 允许整数 1 或 2。旧状态未记录时默认 1；明确设置 2 后，后续 up、update 和 monitor:up 保留这个目标。双副本用于专项验收，不等于单服务器具备跨节点高可用。

## 2. 日常命令

服务器项目目录 `/home/ubuntu/cloud-agent`，开发环境 Conda `cloud`：

```bash
conda activate cloud
cd /home/ubuntu/cloud-agent

npm run deploy -- --help
npm run deploy -- status
npm run deploy -- check
```

`check` 只读核验本地单节点 Docker、安装归属、已登记资源、迁移基线及冷备份前置条件；不会启动、迁移或修复服务。首次未安装时只核验 Docker。`status` 展示实际服务副本、健康与容器状态及保留的模块开关。状态文件是安装记录，不以其 `running` 字段代替真实容器检查。Docker 断连、异属资源、持久卷丢失会拒绝操作；不将权限错误视作“没有安装”。

显式使用一份 API：

```bash
npm run deploy -- up --replicas 1
```

以后直接 `npm run deploy -- up` 即复用已保存副本数和现有模块。首次安装沿用既有预发初始化流程；已有安装不会自动迁移数据库。安装身份、原卷、Secret 缺失时按原规则拒绝重建。命令只作用于执行机器的本地 Docker，不通过本地命令远控云服务器。

查看某个组件的日志：

```bash
npm run deploy -- logs api --tail 100
npm run deploy -- logs gateway --tail 100
npm run deploy -- logs grafana --tail 100
```

只接受固定组件名及 1–1000 行，默认 api / 100 行。使用核验归属后的完整服务或容器 ID，无跟随输出，无任意 Docker 参数，无配置或 Secret 导出。每个 Swarm 任务最多返回指定行数，多副本可能多于这一总行数；底层命令另有正文大小和超时限制。日志仅供受信任服务器运维账号查看。

停止整个选中安装：

```bash
npm run deploy -- stop
```

保留所有卷、Secret 和原模块开关，不删除其他项目资源；业务 `bairui` 不受此命令管理。旧 preprod/monitor/runtime 命令保留兼容，日常优先使用统一入口，避免绕过统一前置检查。

## 3. 更新：先检查、停服、冷备，再部署当前源码

同步代码完成后：

```bash
npm run deploy -- update --replicas 1
```

顺序为：

1. 核对迁移基线、目标副本、域名、Docker 节点、安装归属、已启用监控与 Runtime 的资源、原 API 镜像、Secret 元数据及待备份配置文件。
2. 停止本安装，等待服务与数据卷使用者退出。
3. 冷备原卷及显式配置，校验压缩归档和 SHA-256，最后才发布 `complete: true`。
4. 调用原预发 up 构建并部署当前工作区源码，等待实际目标数量的 API、数据库及已启用模块就绪。

该操作有停机窗口，包含镜像构建时间。不会执行 git pull、数据库迁移或启用真实 Agent。数据库迁移文件与原安装基线不一致时，在停机前拒绝；须单独安排备份、迁移验收和基线更新。调用前应核对当前源码版本和工作区变更，不会忽略未提交文件。

冷备失败后保持停止，保留不完整备份及诊断，不自动启动或继续更新。部署失败也不自动删卷、换密码或回退数据库；排除构建/配置问题后可以重试。恢复旧代码需使用与原数据库兼容的提交，保留旧镜像和配置；本入口没有自动回滚或跨版本数据库降级功能。

## 4. 单独冷备份

```bash
npm run deploy -- stop
npm run deploy -- backup
# 完成后需要恢复服务时，再明确启动
npm run deploy -- up
```

备份要求记录状态为 stopped、已登记服务期望副本为 0、独立容器未运行，并检查所有目标卷没有实际运行中的挂载者。它不会为备份自动启动数据库，也不会停止未知容器。

备份位置：`output/deployment/backups/<时间>-<随机操作号>/`，目录限制访问，配置文件与压缩归档为私有文件。使用已存在且归属正确的 API 镜像创建短时 helper，源卷只读、无网络、无 Docker socket，不拉取镜像或创建替代卷。归档 helper 使用受限读取权限处理 PostgreSQL 的私有 UID 数据；产物归还当前宿主运维用户。

包含：

- 原 PostgreSQL 物理数据卷（包含同一 PostgreSQL 实例内的预发 ledger 数据库）。
- Caddy 证书卷。
- 已安装监控的全部持久卷，包括即使暂时禁用仍需保留的历史；已安装 M1 缓存卷。
- 预发 state、Caddyfile、stack、monitoring-stack、公开 CA（存在时），以及已登记预发 Runtime 的私有配置。
- 安装身份、源码构建版本、原 Swarm Secret 名称与 ID、文件摘要、每卷归档摘要与大小。

不复制业务 `.env`，不跟随配置目录的符号链接。**Swarm Secret 明文仍在原节点，本备份没有导出它们，也没有导出 Docker 镜像，不是可直接搬到空服务器的灾难恢复包。** 不包含另一套业务库、业务监控和 business Runtime。

只有 `manifest.json` 中 `complete: true` 才表示本次归档全部完成。每个归档经过 tar 可读性与摘要校验，不等于完整数据库恢复演练。物理 PostgreSQL 数据须使用匹配的版本和权限恢复；先在独立临时卷验证，不能直接覆盖仍在使用的卷。本批不提供自动恢复命令。

客户端命令超时后会按随机操作标签和完整 ID 清理自己的 helper。进程被强杀或 Docker 断连导致 helper 残留时，统一 up/update/check 会拒绝继续；status 显示残留数量。先核对该容器的安装与操作标签再精确清理，不执行前缀批量删除。原安装保持停止，未完成归档不能用作成功备份。

## 5. 停用重复业务监控

确认日常使用的是选中的常驻预发管理端，且独立业务 API 不再依赖其监控入口后，明确执行：

```bash
npm run deploy -- consolidate business-monitoring
```

只停止已登记且同节点、归属正确的独立业务 Prometheus/Grafana/bridge。保留全部卷、配置和凭据，不迁移旧监控历史，不合并两套数据库，不停止业务 PostgreSQL、business Runtime 或用户 Agent。未使用这条命令时，启动、更新、状态和检查都不会自行停另一套环境。

本批没有整体退役业务环境：业务数据库与 Runtime 是否退役需要依据真实数据和任务另行安排，不能仅凭容器名字认定它们重复。以后再次显式运行原 `monitor:business:up` 仍可恢复该独立安装。

## 6. 监控与验收

API 显式发布无身份标签的 `bairui_api_expected_replicas` 聚合配置指标，值为 1 或 2；没有该配置时不生成指标，旧 API 镜像保留两份基线。副本不足规则比较实际可采集数量与配置目标，无发现目标仍触发，不用“关闭告警”适配单副本。看板首项改为“API 可采集副本”，版本从 2 升至 3，UID、固定文件夹和数据卷不变。

完整 `test:preprod` / `test:monitoring` 仍是会修改服务的**双 API 故障验收**。它们在创建测试身份或注入故障前检查实际两副本，不对单副本降低断言。仅在专门验收窗口执行：

```bash
npm run deploy -- up --replicas 2
# 按原专项说明运行双 API 故障验收
# 验收完成后恢复日常目标
npm run deploy -- up --replicas 1
```

代码回归：`npm run test:deployment`，以及原 preprod/monitoring/business-monitoring/Runtime/CLI/telemetry 配置专项。`scripts/deployment-live-acceptance.mjs` 需要显式 `BAIRUI_DEPLOYMENT_LIVE_TEST=1`，只用本地既有镜像和随机临时卷，验证真实 tar 权限与逐字节读取、异常 helper 清理和官方 promtool 场景。报告位于 `output/deployment/acceptance/`，不读取或挂载原数据卷，不冒充服务器完整 stop/backup/update/up 或数据库恢复验收。

2026-11-22 本机记录：运维专项 26/26；最终关联回归 202/202，零失败、零跳过（`output/deployment/regression-final.tap`）。实际临时资源报告为 `output/deployment/acceptance/2026-11-22T06-47-02-667Z-9428cdcb55eae7e947974b25/report.json`，涵盖真实受限文件归档、客户端结果丢失后清理存活 helper、官方 promtool 9 场景，以及旧容器 ID/全部卷清单不变。12 个已有 M1 文件摘要保持不变；独立代码复核通过。

## 7. 2026-11-22 本机常驻恢复

用户明确要求恢复本地容器和 Swarm。仅操作 Docker Desktop 的本地单节点 `desktop-linux`，没有连接云服务器，也没有启动另一套业务数据库或业务监控。

- 首先以统一 `deploy backup` 冷备六个原卷及预发 Runtime 配置，完成清单位于 `output/deployment/backups/2026-11-22T06-56-58-522Z-646d895c384e/manifest.json`。原安装、Swarm Secret 与证书保留。
- 确认原数据库与源码基线精确对应至 040。使用无网络、无发布端口的临时维护 PostgreSQL 挂载原预发卷，逐项执行缺失 041–047，添加公告/通知固定函数与邮箱挑战表最小授权；没有倒序重跑旧迁移或合并业务账号。校验完成后记录新基线，维护容器已正常停止删除。
- 原 27 个业务用户、23 个认证用户、2 个 Agent、10 个资源、3 条历史运行与 1 个平台管理员数量保持一致。应用角色无 superuser/BYPASSRLS，公告和模型私有表不获直接读取，邮箱挑战只获 SELECT/INSERT/UPDATE，不获 DELETE。
- `npm run deploy -- up --replicas 1` 成功重建：6 个 Swarm 服务均 1/1，项目共 9 个运行容器（API、数据库、四个监控服务、网关、预发 Controller 和编排器）。镜像源码构建版本 `c3a534d530bb3f53`。这里只恢复旧 E3 基座，真实 Agent 创建/执行仍关闭。
- 保留原预发 Runtime opt-in；监控仅采集实际恢复的 preprod Controller，停止采集未恢复的 business Controller，原双环境配置仍可在冷备中查阅。Grafana、Prometheus、Alertmanager、接收器、API/数据库、Controller/编排器均健康；五个 Prometheus 采集目标全为 up，实际及预期 API 副本指标均为 1。
- 客户端 `https://localhost:8443/`，管理端及同源 Grafana `https://localhost:8443/admin/`。原根证书已在 CurrentUser Root 中受信任，无需重新导入。实际 Edge 无忽略证书参数可加载页面；匿名身份及 Grafana 返回 401，公开 metrics 返回 404。邮箱模式保持 off。
- 验证报告 `output/deployment/local-smoke-20261122.json`，迁移与原数量校验记录 `output/deployment/local-restore-f41b9caf371f49a91c39c223/report.json`。医疗存储等其他项目容器未重启；没有开放独立 Grafana 端口。

## 8. 同日本地停止与清理

用户随后明确要求停止，再清除本地部署的全部容器和运行实例。先通过统一 stop 将六个服务降至 0/0；清理时按原安装标签核验全部归属，先删除六个服务防止重建，再按完整 ID 删除 22 个本项目容器（其中 19 个是已停止的 Swarm 历史任务，另外三个是网关和预发 Controller/编排器）。最终本项目容器、服务、stack 均无残留。

清理前后核对全部 219 个 Docker 卷、8 个 Secret、41 个镜像 ID 均保留，其他四个项目容器的完整 ID、状态与启动时间未变。没有执行卷删除、镜像 prune、Swarm leave 或云端操作。原安装状态、配置和冷备继续保留，可在用户明确要求时重建；第 7 节为历史恢复与验收记录，不表示当前存在运行实例。

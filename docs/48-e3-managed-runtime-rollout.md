# E3：业务库与常驻预发部署

2026-10-10，用户明确授权后接入业务库和常驻预发。这里部署的是控制与回收底座，真实模型、用户 Agent 创建/执行、旧 Worker/Runtime/Boundary 仍关闭。

## 1. 部署结构

| 环境 | 平台数据库 | 独立机器 ledger | 常驻进程 |
| --- | --- | --- | --- |
| business | 既有 `bairui` / `bairui-postgres` | `bairui_runtime_ledger_business` | `bairui-runtime-business-controller`、`bairui-runtime-business-orchestrator` |
| preprod | 既有 `bairui_preprod` / Swarm PostgreSQL | `bairui_runtime_ledger_preprod` | `bairui-runtime-preprod-controller`、`bairui-runtime-preprod-orchestrator` |

两个环境分别持有安装身份、HMAC、指标 Token、TLS、自有 internal 控制/运行网络。Controller 使用 `bairui_runtime_controller` 登录对应平台库，仅获 CONNECT、schema USAGE 和 E3 的九个函数；不授表读写、认证或用户启停函数。编排器使用 `bairui_runtime_ledger`，仅连接独立 ledger，保留永久停止标记及 nonce。两个同名角色位于不同 PostgreSQL 实例，不共享密码。

Controller 非 root、只读根、无 Docker socket。编排器使用独立 Docker CLI 镜像，持有本机 Docker 权限；API 镜像和权限不增加 Docker。两个进程的私有配置分别挂载，Controller 看不到 ledger 密码或 TLS 私钥。没有宿主发布端口，指标只从现有 internal 监控网络采集。进程使用 `unless-stopped` 自动恢复；仍依赖本机 Docker Desktop 正常运行，不代表 Windows 系统服务或跨节点高可用。

managed 模式显式绑定 business/preprod、对应库名、固定机器角色、安装身份、精确数据库主机/5432；连接参数拒绝 host/user/database 覆盖。私有 JSON 只接受有界 BAIRUI 字符串，入口不读业务 `.env`，CA 在 Node 启动时加载。不放宽 isolation 配置。运行地址使用自有运行网络实际 IPv4，并由 Controller CIDR 白名单复核；既有 isolation 保留主机名行为。

实际工作负载仍只有固定 `isolation-probe-v1` 无模型进程；pi 是协议槽位，不接 pi/dsh/Provider。业务库未插入演示 Agent 或改动账号。

## 2. 备份、迁移与保留

迁移前各自生成 custom-format 数据库 dump、角色备份和资源/状态清单，通过 PostgreSQL `pg_restore --list` 校验。目录及凭据均在已忽略、限制为当前 Windows 用户和 SYSTEM 的 `output/runtime/`，不提交 Git。

- 业务备份：`output/runtime/backups/business-2026-10-10T04-55-43-338Z/`；dump 174201 字节，SHA256 `0c470675596c5643258c1038ab5fa9c4eb25dfb89fa4d4418c98db2931ecc09d`。
- 预发备份：`output/runtime/backups/preprod-2026-10-10T04-56-12-872Z/`；dump 182443 字节，SHA256 `6d12952a55882398de38cb61bd62b80245b4f0de492774fc0ee8a4b3121c3659`。

两个平台库只追加事务迁移 039、040；已有 036/037 保留，业务库不导入模拟调度 033/038。业务默认权限会给应用账号新增表权限，本轮显式撤销 `bairui_app` 对两个 Runtime 控制表的权限；预发同样撤销应用角色表权限。应用不能执行用户 start/stop，Controller 不能直接操作控制表。

预发在确认 040 实际存在后才增加 bootstrap schema hash 并更新状态，保留旧 hash 历史。不删除数据库卷、Caddy 证书卷、监控历史卷或原平台 Secret。Caddy 根证书指纹与更新前一致，未改 Windows 信任。

预发 API/网关版本为 `984167c866f5c602`；独立编排器镜像为 `bairui/runtime-orchestrator:af542fe7243cff14`。机器 ledger 与配置只在首次显式 provision 建立；缺少已安装持久资源时拒绝生成替代身份。运行状态用临时文件+原子 rename 保存。

业务迁移前后均为 6 个用户、6 个 Agent、4 条资源，engine run 与 Runtime control 为 0。原有 6 条历史路由不据此启动或改写。日常本地开发 API 当时未响应，本次不擅自启动它；常驻运行的是新 Controller/编排器及已有预发。

## 3. 操作入口与维护

```powershell
conda run -n cloud --no-capture-output npm run runtime:deploy -- status business
conda run -n cloud --no-capture-output npm run runtime:deploy -- status preprod
conda run -n cloud --no-capture-output npm run runtime:deploy -- stop business
conda run -n cloud --no-capture-output npm run runtime:deploy -- up business
```

`backup`、`provision` 为明确的数据库准备动作，不是普通 up 的隐式迁移；up 保留原配置。代码升级先备份/核对迁移，再 `preprod:up`，并显式升级 business Runtime；普通预发操作不替业务环境升级或停止进程。

`preprod:stop` 先停预发 Controller/编排器再停监控、API 和数据库；`preprod:up` 校验持久配置后恢复预发 Runtime 和监控。只操作预发，业务 Controller 保持运行；共享监控停止期间不采集业务指标。停止编排器不会删除 ledger 或执行未知容器清理；已确认停止和永久围栏沿用 E2。编排器离线期间不承诺 TTL 回收时限。

私有 JSON、凭据、TLS、状态文件和 ledger 都需要保留。丢失后应使用备份和资源归属记录恢复，不能删状态后新造角色/Secret。TLS 当前有效期为一年，需到期前计划更新对应 CA 与进程，不关闭证书验证。

## 4. 监控与验收

常驻 Prometheus 显式启用两个固定目标，各用独立指标 Secret；target job 重标记为固定 `bairui-runtime-controller`，复用五类 Runtime 告警。规则聚合不带实例或身份，原有七条平台规则保留，共 12 条。默认未启用 Runtime 的监控配置不变。接收器使用新版白名单；统一控制台沿用告警读取能力，不开放用户生命周期操作。

配置与回归：managed/deployment 10 项、部署/监控配置 29 项（其中监控 25 项）、预发配置 63 项、E3 隔离 23 项、平台 25 项全通过；后端 272 通过、9 项需专用数据库/容器环境的测试跳过、0 失败。官方 promtool/amtool 确认合并配置与 12 条规则有效；常驻监控验收按实际安装的 Runtime 开关检查资产，不只检查默认七条平台规则。

常驻端到端入口：

```powershell
conda run -n cloud --no-capture-output npm run test:runtime-deployment:live
```

该命令只在预发新建明确标记的无凭据测试身份及探针 Agent，使用 DBA 调用内部控制函数，不给应用或 Controller 新增用户启停权限。检查实际内核限制、完整容器归属、Controller 崩溃后 Docker 自动恢复且 run 不变、实际 TTL 删除及回流、真实治理暂停停止/解除不重启、真实 Prometheus→Alertmanager→接收器 firing/resolved；结束撤销测试管理员授权，保留无凭据测试记录和历史。报告成功只在全部断言及清理通过后记录。

首轮故障注入未杀死 namespace PID 1，Controller 重启计数仍为 0，报告正确为失败；测试资源已受控停止及撤权，没有将它算作恢复成功。常驻容器增加 Docker `--init`，验收改为杀死唯一 Node Controller 子进程并独立核对重启计数、相同容器和相同 run；依据 [Docker init 说明](https://docs.docker.com/reference/cli/docker/container/run/) 与 [Linux PID namespace 信号规则](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)。

完整重跑通过，报告为 `output/runtime/acceptance-2026-10-10T05-28-12-590Z.json`：实际容器限制、Controller 自动重启保留原 run、真实 TTL 删除与恢复审计、真实账号治理停止及解除不重启、两套 Controller 采集、预发 Controller 停机告警与恢复通知均成功；故障期间平台 API 仍就绪。测试只验证 Controller 进程崩溃，不将其扩大为编排器崩溃或整机重启证明。两次验收留下 3 条已终止的预发 ledger 历史，测试管理员授权已撤销，没有活跃探针或测试路由。

完整预发验收报告 `output/preprod/acceptance-2026-10-10T05-29-31-790Z-ed9899.json` 成功：双 API 滚动重建、真实数据库停机/恢复、完整 stop/up、用户隔离及 Grafana Viewer 均通过。额外前后比对见 `output/runtime/stop-up-preservation-2026-10-10.json`：两个 Runtime 安装身份、网络 ID、指标 Secret ID、私有配置哈希、ledger 数据库 OID/历史及 Caddy CA 完全未变；预发原 Controller/编排器容器实际重新健康启动，业务两个容器 ID 与启动时间完全未变，未发生连带停止。最终业务仍为 6 用户、6 Agent、4 资源、6 历史路由，0 engine run/0 Runtime control；应用启停函数、应用/Controller 控制表直读均拒绝。

最终监控验收 `output/preprod/monitoring-acceptance-2026-10-10T09-08-39-985Z-e47976.json` 成功：按已安装开关校验合并 12 条规则，真实 API 2→1→2 触发及恢复通知，四组件重建后指标历史、告警持久记录、Grafana 登录与原 Secret 保留；平台能力仍关闭。前一轮默认规则校验的监控验收同样成功，但以本次覆盖完整资产的报告作为最终证据。

## 5. 未开放范围

没有接真实模型、用户资源挂载、全局容量准入、自动扩缩容、公网生产、跨节点 HA、外部通知或付费执行。当前监控仍与本机共享故障域；两套 Controller 的活跃数合计只用于各自库的诊断，不当作用户执行能力已上线。

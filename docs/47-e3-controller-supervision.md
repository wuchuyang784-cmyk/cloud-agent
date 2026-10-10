# E3：常驻 Controller、运行状态回流与告警闭环

2026-10-10。本批实现常驻协调程序并完成本机隔离验收；本文记录隔离阶段，后续用户授权的业务库与常驻预发部署见 [E3 常驻部署记录](48-e3-managed-runtime-rollout.md)。

## 1. 实现目的和运行边界

E1 提供带代次的启停命令，E2 在专用机器 ledger 中操作实际 Docker 容器。E3 持续处理 E1 命令，再查询 E2，把 TTL 回收、异常退出和治理停止结果写回平台，最后通过聚合指标发现控制程序失效、停止迟迟未确认和观察失败。

入口为 `npm run controller:isolation`，代码位于 `apps/platform-api/src/runtime/supervision/`。它不加载业务 `.env`，不进入 API/dev 启动链，不持有 Docker 权限，不安装系统服务。运行必须显式设置 `BAIRUI_RUNTIME_CONTROLLER_MODE=isolation`，使用专用受限控制连接、HTTPS 编排器、Runtime 地址白名单和独立指标凭据。

实际容器仍是 E2 固定 `isolation-probe-v1` 无模型进程。pi 只是协议槽位；用户 Agent 写入/执行、旧 Worker/Runtime/Boundary、Provider 和公开生命周期接口继续关闭。这里的“常驻”是程序支持持续运行，不表示本次已在后台长期部署。

## 2. 周期执行与状态回流

每轮先运行 E1 治理协调及有界命令处理，再领取观察租约、查询编排器、提交结果，最后读取聚合诊断。默认每批一条，轮次完成后等待 1 秒；轮次之间不重叠。单次远端调用和数据库事务沿用 E1 的有界超时。周期异常保留最后已知指标，后续轮次继续；退出停止新领取，等待已领取的操作结束。

观察租约为 60 秒，正常观察间隔 10 秒。提交必须匹配 worker、随机 token、未过期租约、Agent、run、run generation 和 control generation。控制代次改变时可立即替换旧观察租约，旧回执失效；Controller 重启使用新的随机 worker。租约本身没有执行用户代码的权限。

签名 `stopped/absent` 才能原子撤销对应路由、停止 run/control/Agent 并清空 active run；写入随机请求 UUID 的系统 `recovery_stop` 审计。原 desired running 时 control generation 增加，避免旧启动结果重新发布；不会自动重启。HTTP 404、超时、签名错误只记观察失败，不能视为容器已释放。

`running` 只刷新已经存在且代次、地址、容器身份匹配的路由，不创建缺失路由；账号状态和治理版本也必须匹配。观察状态不替代 E1 的启动确认。平台回流时间和新鲜度使用本地接收时间，避免远端时钟改变告警判断。编排器原始错误、地址和身份不写入指标或周期日志。

## 3. 数据库迁移与最小权限

新增 `040_runtime_supervision.sql`，在既有 `agent_runtime_controls` 中增加观察租约、最近状态和成功时间字段。依赖 039 及其前置迁移，不依赖模拟调度 033/038；保留 FORCE RLS。三个新函数默认撤销 PUBLIC EXECUTE，不给 Controller 表读写权限。

状态提交与 D1/E1 使用同键治理共享事务锁，锁序为 Agent → control → run，持锁至事务提交。被拒绝的回执和中途写入失败整笔回滚。Memory 和 PostgreSQL 提供相同的观察与诊断接口。

未来启用环境先备份并核对前置迁移，再由迁移所有者执行 040。给专用非超级用户、非 BYPASSRLS 的 Controller 角色授予 schema USAGE 和下列函数 EXECUTE；不要授予表权限、认证函数、用户启停函数或 Docker 权限：

```sql
GRANT EXECUTE ON FUNCTION
  runtime_control_claim(text,integer),
  runtime_control_prepare(text,uuid,integer),
  runtime_control_complete(text,uuid,text,text,integer),
  runtime_control_commit_started(text,uuid,text,text,bigint,text,text,integer),
  runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz,integer),
  runtime_control_reconcile_governance(text,integer),
  runtime_supervision_claim(text),
  runtime_supervision_record(text,uuid,text,text,bigint,bigint,text,timestamptz,text,text),
  runtime_supervision_snapshot()
TO controller_role;
```

SECURITY DEFINER 函数信任机器角色的回执，不是对已泄漏机器凭据的独立认证边界。启动会拒绝超级用户、BYPASSRLS 和 control 表直接权限；实际最小授权仍需按以上清单配置。当前 isolation 配置仅允许回环 PostgreSQL，并拒绝 `bairui`、`bairui_preprod`、`postgres` 和同值业务 `DATABASE_URL`。连接串查询参数仅允许一项固定格式的 `options=-c search_path=schema,public`（或省略 public），拒绝主机、数据库、角色和凭据覆盖；这不代替 DBA 核对目标实例、数据库和角色。

## 4. 配置与指标

| 配置 | 含义 |
| --- | --- |
| `BAIRUI_RUNTIME_CONTROLLER_MODE` | 必须为 `isolation` |
| `BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL` | 专用受限 PostgreSQL 控制连接；需要已迁移 schema 的 search_path |
| `BAIRUI_RUNTIME_ORCHESTRATOR_URL` | E2 HTTPS 地址 |
| `BAIRUI_RUNTIME_CONTROL_KEY_ID/SECRET` | E1 双向 HMAC 机器凭据 |
| `BAIRUI_RUNTIME_ALLOWED_HOSTS/CIDRS` | 实际 Runtime 地址的精确白名单；二者至少一个 |
| `BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE` | 随机独立 Bearer 凭据文件；不复用账号密码 |
| `BAIRUI_RUNTIME_CONTROLLER_METRICS_PORT` | 默认 9495，固定监听 127.0.0.1 |
| `BAIRUI_RUNTIME_CONTROLLER_INTERVAL_MS` | 默认 1000，允许 100–10000 |
| `BAIRUI_RUNTIME_CONTROLLER_BATCH_SIZE` | 默认 1，允许 1–10 |
| `BAIRUI_RUNTIME_CONTROLLER_MAX_ATTEMPTS` | 默认 8，允许 1–100 |

自签名测试证书只通过专用测试进程的 `NODE_EXTRA_CA_CERTS` 信任；没有关闭 TLS 验证或自动导入操作系统 CA。以上真实凭据只放受限本地配置，不能提交 Git。

指标端口只接受鉴权的 `GET /metrics`，拒绝缺失、错误和重复 Authorization，专用 registry 不输出默认进程指标或身份标签。固定输出 `bairui_runtime_` 前缀的 `controller_cycle_ok`、`controller_last_success_timestamp_seconds`、`active`、`stopping`、`stop_overdue`、`dead_pending`、`observation_errors`、`observation_stale`。首次完整成功前不输出诊断值和成功时间；周期失败保留上一份诊断并置 cycle_ok=0。

停止超过 60 秒为 overdue，当前 run 超过 60 秒无成功观察为 stale。dead_pending 只统计仍占用 active run 的死命令；实际停止后告警解除，历史 dead/audit 保留。指标表达资源仍占用或状态不确定，不承诺故障下的释放时限。观察调用失败但错误状态成功入库属于已完成诊断轮次，由 observation 告警表示。

## 5. 告警规则与接收

`scripts/runtime-monitoring-config.mjs` 提供独立 `runtimeRules()`，没有自动修改默认预发配置。五类规则为 Controller 不可用/成功时间陈旧、周期失败、停止超时、死命令待回收、观察失败/陈旧。默认评估 15 秒、持续 45 秒触发；Controller 和观察的新鲜度阈值 60 秒，因此告警不是立即通知。

规则聚合移除 instance/job 身份标签，现有本地接收器只扩充五个固定告警名白名单，沿用随机 Bearer、持久化和恢复通知。现有管理控制台能读取这类告警；这次没有接入常驻预发监控。

正式接入前需要为回环指标端点明确部署采集路径；不能直接从 Docker 容器访问宿主的 127.0.0.1。当前监控验收使用两个临时 Node 测试端点监听 0.0.0.0，以随机 Bearer 认证；Prometheus/Alertmanager 使用随机专属 bridge 网络，不发布容器端口、不连接业务网络，结束后清理。该测试拓扑不是部署模板。

## 6. 验收证据

```powershell
conda run -n cloud --no-capture-output npm run test:runtime-supervision
conda run -n cloud --no-capture-output npm run test:runtime-alerts
```

状态专项使用 E2 归属校验的一次性 PostgreSQL、internal 网络、本机固定 sha256 镜像和临时证书。数据库专项不导入 033/038；包含两池互斥、租约替换、身份冲突、双方向治理锁等待、提交中途故障回滚、最小权限及迁移重跑。独立 Controller 用真正的受限登录角色和 HTTPS E2，证明真实 Docker 容器启动、Controller 强杀重启、TTL 和异常退出回收、路由撤销、实际治理函数暂停及解除不复活；状态来源通过真实 metrics HTTP 读取。TTL 使用注入编排器时钟加速，观察到期时间由测试库缩短，实际容器删除和平台状态提交仍为真实操作。

告警专项包含官方 promtool 18 个场景/90 条告警断言，以及真实 Prometheus → Alertmanager → 本地接收器五类 firing/resolved、后续周期失败恢复和指标端点停启恢复。监控专项直接调用 telemetry.update 注入故障诊断；Controller → 数据库 → 指标与指标 → 告警分别验收，没有声称两段在同一个部署拓扑中端到端上线。

本机结果：E3 状态专项 23/23、E1 62/62、E2 34/34、平台模式 25/25、既有监控配置 23/23；后端全量 266 通过、9 个需独立数据库/容器环境的专项跳过、0 失败。E3 真实数据库故障验收还短暂禁用且终止本次随机 Controller 登录连接，验证 cycle_ok=0、保留 active 快照，恢复登录后下一轮成功且容器不变。超级用户和 control 表过度授权的角色启动被拒绝。

E2 在与其他 Docker/全量验收并行时首轮出现 stop 503，留下未确认停止记录，后续 reaper 多回收该记录导致连带断言失败；单独重跑 34 项全部通过。未放宽运行时超时或把不确定删除当作成功；Docker 专项建议串行执行。

临时资源按完整 ID 和随机归属标签清理；未操作业务 `bairui`、`bairui-postgres` 或常驻预发。

## 7. 后续范围

本批没有安装 Windows/systemd 服务、启用跨节点 HA、增加全局容量准入、挂载真实用户资源或接入模型。观察阈值需要在实际 run 数量和轮询耗时下做容量验收；多个 Controller 的聚合数量不能直接当作唯一实例数。本机监控与主机一同停机时没有外部通知。

下一阶段应先明确受控部署拓扑、采集路径和恢复验收，再按既有 E 分阶段方案接真实 Agent；保留 Provider、配额和用户执行入口的独立准入。

# E3 Controller Supervision Implementation Plan

> **For agentic workers:** Use executing-plans for the stateful core and subagent-driven-development for the independently scoped metrics/alert implementation, with spec then quality review. User authorized implementation, not deployment.

**Goal:** 常驻处理 E1 命令、可靠回流 E2 状态、通过现有监控通知异常与恢复。

**Architecture:** 受限 PostgreSQL 观察租约围栏 → 单轮协调器 → 独立循环入口；聚合指标 → 固定 Prometheus 规则 → Alertmanager → 本地接收器。

**Tech Stack:** Node ESM、PostgreSQL、pg、prom-client、Docker、node:test。

## 1. 状态回流

- [x] 新增 `runtime-supervision.test.mjs`：观察领取/租约、terminal 回流撤路由、不复活、错误不释放、迟到回执、诊断恢复；先运行看到失败。
- [x] 实现 `MemoryRuntimeControlStore.claimObservation(workerId)`、`recordObservation(input)`、`supervisionSnapshot()`，输入包含随机 leaseToken 和 controlGeneration。
- [x] 040 `runtime_supervision_claim(text)`、`runtime_supervision_record(text,uuid,text,text,bigint,bigint,text,timestamptz,text,text)`、`runtime_supervision_snapshot()` 与 PostgreSQL wrapper；只有新函数 EXECUTE，不给控制角色表访问。
- [x] 真 PG 验证 SQL、两池竞争、租约重领、旧 run 拒绝、治理锁、回滚与最小授权，迁移不依赖模拟调度。

## 2. 周期控制入口

- [x] `src/runtime/supervision/{coordinator,loop,config,index}.mjs`；测试先覆盖循环不重叠、异常恢复、shutdown 不再领取、默认拒绝与凭据不泄漏。
- [x] coordinator 每轮 E1 tick、单条领取/观察/提交，最后聚合 snapshot；loop 对每个任务等待完成，退出等待在途。仅固定安全日志。
- [x] 独立 npm 入口，不加入 dev/app；不自动迁移、创建 Agent 或修补账号。

## 3. 指标及告警（独立任务）

- [x] `src/runtime/supervision/telemetry.mjs`、`scripts/runtime-monitoring-config.mjs` 与测试；先写鉴权、固定指标、周期失效不补零、规则触发/解除断言。
- [x] 复用 prom-client，接口 `createRuntimeTelemetry({token,host,port}) -> {server,start,close,update}`，`update({ok,snapshot})`。snapshot字段：active,stopping,stopOverdue,deadPending,observationErrors,observationStale。更新成功时间取本机 Date.now。
- [x] 告警名：RuntimeControllerUnavailable、RuntimeControllerCycleFailed、RuntimeStopOverdue、RuntimeCommandDead、RuntimeObservationUnavailable；均聚合无身份。新增接收器白名单，不改默认预发配置。
- [x] 隔离真实 Prometheus/Alertmanager firing/resolved 验收与原接收器回归；先规格复核再代码质量复核。

## 4. 综合验收及交付

- [x] `scripts/test-runtime-supervision.mjs` 复用 E2 随机数据库/网络/证书及归属清理，连 E2 probe 做真实生命周期回流、治理关闭和恢复；真实监控专项为独立 `test:runtime-alerts`。
- [x] 验证 E3、E1/E2、平台能力、后端全量与告警回归（cloud 环境）；不调用预发部署命令。
- [x] 独立复核全部变更，修复后重跑；写 `docs/47-e3-controller-supervision.md` 与 AGENTS 状态，保存本地提交，不推送、不部署。

## 执行记录（2026-10-10）

E3 23、E1 62、E2 34、平台 25、监控配置 23 项通过；后端 266 通过/9 独立环境专项跳过/0 失败。官方 promtool 18 场景/90 断言，真实监控收据 14 条。规格及质量独立复核通过，修复 PG URL 查询参数覆盖回环主机的入口问题，并拒绝全网 CIDR/别名和控制密钥超长/控制字符。

Controller→平台/指标与测试快照→真实监控分段验收；未声明单个部署拓扑整体上线。Docker 并行高负荷 E2 首轮 stop 503 及后续连带断言失败，串行重跑全通过，未放宽运行时超时。完整边界见 docs/47。

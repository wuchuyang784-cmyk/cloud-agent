# BaiRui Cloud Agent Platform 文档索引

本目录保存 Platform、用户 BFF、BaiLongma 适配、Control Authority、Server Agent 和部署的当前技术规范。

## 跨仓权威入口

- 整体执行顺序：`BaiRui-agent/docs/AI-DEVELOPMENT-PLAN.md`
- 五层架构：`BaiRui-agent/docs/TECHNICAL_FRAMEWORK_MAP.md`
- 跨仓 Schema：`BaiRui-contracts`
- upstream registry：`BaiRui-agent/integrations/upstreams.yaml`

## 上游引擎子模块（本仓 `upstreams/`）

pi-agent 与 deepseek-harness（dsh）作为**只读 git submodule** 挂载在本仓，pin 到核对过的提交。沿用 BaiLongma 上游模式（`docs/20` §2.1）：不在子模块内提交任何 BaiRui 行为，平台只基于 pin 提交做确定性构建与兼容验收。

| 引擎 | 子模块路径 | 上游仓库 | 上游默认分支 | 当前 pin（2026-09-07） | 协议 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| pi-agent | `upstreams/pi` | `earendil-works/pi` | `main` | `c1d4c801114545f47c440921d8b3e04aeb1e565d`（v0.0.2 之后 6036 提交） | MIT | npm workspace；`packages/` 下 `agent`（pi-agent-core）、`ai`（pi-ai）、`coding-agent`（CLI）、`server`、`session-backends`、`tui` 等 |
| deepseek-harness (dsh) | `upstreams/dsh` | `deepseek-ai/deepseek-harness` | `master` | `b0a7d2ce3b4c19d7452e364b2d7acbfa87e707ed`（dsh-v0.1.3-alpha.2 之后 106 提交） | MIT | pnpm workspace，插件化 Harness；`packages/` 下 `core`、`api`、`host`、`session`、`preset`、`bundle`、`client`/`web` 等 |

维护约定：

- 新 clone 本仓后执行 `git submodule update --init --recursive`（`.gitmodules` 与 gitlink 已在提交中）。
- 升级 pin：先在上游拉取候选提交，参照 `BAILONGMA-UPSTREAM-COMPATIBILITY.md` 的兼容验收流程评估，再更新 `.gitmodules`、本表和索引（gitlink）。
- 注意 dsh 上游默认分支是 `master`（非 `main`），pi 是 `main`；一律以 commit pin 为准，不做分支跟踪。
- 引擎基线镜像（`bairui-agent-pi` / `bairui-agent-dsh`）的 Dockerfile 与平台注入侧实现以这两个 pin 为构建基线，规格见 `28-dual-engine-platform-build-specs.md` §3。
- 两引擎本体的**源码级接入核对**（真实入口、配置/凭据/数据目录、版本 pin、核对时间与待办）见 [`31-agent-engines-upstream-audit.md`](31-agent-engines-upstream-audit.md)，`28` 号 §3.1/§3.2 的环境变量契约以其为准。

## 当前规范

第一阶段账号接入见 [33-phase1-better-auth.md](33-phase1-better-auth.md)。当前平台模式、启动清单与认证代理安全以 [36-platform-mode-and-auth-proxy.md](36-platform-mode-and-auth-proxy.md) 为准。

| 范围 | 文档 |
| --- | --- |
| 第三阶段 3.1：常驻本机预发、HTTPS、双 API、独立数据库与恢复验收 | [37-phase3-local-preprod.md](37-phase3-local-preprod.md) |
| 第三阶段 3.2：监控与本地告警，真实部署验收待完成 | [38-phase3-monitoring.md](38-phase3-monitoring.md) |
| 平台能力开关、只启动平台服务、可信代理与共享认证限流 | [36-platform-mode-and-auth-proxy.md](36-platform-mode-and-auth-proxy.md) |
| 第二阶段模拟调度：配额、租约与本机验收 | [34-phase2-scheduler.md](34-phase2-scheduler.md) |
| 第二阶段 Swarm：双 API/Worker、真实登录与故障恢复验收 | [35-phase2-swarm-acceptance.md](35-phase2-swarm-acceptance.md) |
| Agent 运行本体与模板体系（pi-agent + deepseek-harness） | [`27-agent-runtime-template-strategy.md`](27-agent-runtime-template-strategy.md) |
| 双引擎平台建设设定清单（落地规格） | [`28-dual-engine-platform-build-specs.md`](28-dual-engine-platform-build-specs.md) |
| 上游引擎接入核对（pi/dsh 入口、凭据映射、pin 与待办） | [`31-agent-engines-upstream-audit.md`](31-agent-engines-upstream-audit.md) |
| 平台设计方案归档（重新设定与优化版，保留/移除决策记录） | [`29-platform-design-archive.md`](29-platform-design-archive.md) |
| 品牌命名 | [`05-brand-and-trademark-fields.md`](05-brand-and-trademark-fields.md) |
| 用户/管理员/机器权限 | [`08-security-and-access-control.md`](08-security-and-access-control.md) |
| 总控架构、协议、安全、运维 | [`10-control-plane-architecture.md`](10-control-plane-architecture.md) 至 [`13-control-plane-operations.md`](13-control-plane-operations.md) |
| 多租户 Agent 与 Fleet | [`14-multi-tenant-agent-runtime.md`](14-multi-tenant-agent-runtime.md) 至 [`17-agent-resource-telemetry.md`](17-agent-resource-telemetry.md) |
| 远程浏览器验收 | [`19-remote-browser-acceptance.md`](19-remote-browser-acceptance.md) |
| Platform/Agent 集成 | [`20-platform-agent-integration-guide.md`](20-platform-agent-integration-guide.md) |
| 路由、渠道、发布 | [`22-platform-route-boundaries.md`](22-platform-route-boundaries.md) 至 [`24-immutable-release-pipeline.md`](24-immutable-release-pipeline.md) |
| 运行时环境与请求路由 | [`25-agent-runtime-env-and-request-routing.md`](25-agent-runtime-env-and-request-routing.md) |
| 总览仪表盘实时数据计划 | [`26-overview-dashboard-live-data-plan.md`](26-overview-dashboard-live-data-plan.md) |

历史重构计划、旧 API 数量、旧技术选型和阶段性“当前状态”文档已删除。实现状态只能从 AI 开发任务注册表、当前代码、迁移、测试、CI 和线上 observation 判断。

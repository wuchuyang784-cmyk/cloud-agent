# BaiRui Cloud Agent Platform 文档索引

本目录保存 Platform、用户 BFF、BaiLongma 适配、Control Authority、Server Agent 和部署的当前技术规范。

## 跨仓权威入口

- 整体执行顺序：`BaiRui-agent/docs/AI-DEVELOPMENT-PLAN.md`
- 五层架构：`BaiRui-agent/docs/TECHNICAL_FRAMEWORK_MAP.md`
- 跨仓 Schema：`BaiRui-contracts`
- upstream registry：`BaiRui-agent/integrations/upstreams.yaml`

## 当前规范

| 范围 | 文档 |
| --- | --- |
| Agent 运行本体与模板体系（pi-agent + deepseek-harness） | [`27-agent-runtime-template-strategy.md`](27-agent-runtime-template-strategy.md) |
| 双引擎平台建设设定清单（落地规格） | [`28-dual-engine-platform-build-specs.md`](28-dual-engine-platform-build-specs.md) |
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

# 单机统一部署与运维 Implementation Plan

**Goal:** 复用用户选择的常驻预发安装，将 API 默认副本降为一份，统一检查、启动、更新、状态、日志、冷备份和明确指定的重复业务监控停用入口。

**Architecture:** 首批继续使用现有单节点 Swarm，保持原安装身份、数据库卷、Secret、证书和权限；不同时迁移编排引擎。统一 CLI 调用现有带归属检查的操作，不读取业务 `.env`，不自动启动业务环境或真实 Agent。更新先核对迁移基线，再停止、完整冷备份，备份失败保持停止。

**Tech Stack:** Node.js ESM / node:test / Docker CLI / Conda cloud。

## 执行边界

- 在当前开发分支实施，保留已有 M1 未提交改动；本轮不操作服务器、不启动本机常驻服务，不提交或推送。
- 默认一份 API；显式 `--replicas 2` 保存到原 state，完整双 API 故障验收仍要求两份，不降低其断言。
- 监控仍保留 Grafana、Prometheus 与告警闭环；预期副本从 API 固定聚合指标读取，旧镜像回退为两份。看板不再把预期 2 写死。
- 不自动合并数据库，不自动停止业务数据库、Runtime 或用户 Agent。重复业务监控仅在明确指定 consolidate business-monitoring 时停用，保留其历史卷、配置和凭据。
- 冷备份要求所有本安装数据卷无运行中的挂载者，记录所有归属卷和 SHA-256，使用已有 API 镜像临时只读挂载归档，结束自动删除临时容器。备份包含数据库物理数据、证书、监控历史、显式配置及已安装预发 Runtime 私有配置；Swarm Secret 本体保留在原 Docker，备份不冒充异机灾难恢复包。

## Task 1 — 单副本与监控

- [x] 在 preprod-config.test.mjs 新增默认一份、显式两份及非法副本拒绝断言，先运行看到失败。
- [x] preprod-config.mjs / preprod.mjs 支持 1/2 副本并持久化目标，等待与输出使用实际目标；变更前先校验参数。
- [x] telemetry.test.mjs 覆盖副本指标，monitoring-config.test.mjs / ruleTests 覆盖一份健康、两份缺失、零发现目标；实现动态阈值与通用看板标题。
- [x] 双 API 验收增加前置门禁，副本不足时在创建身份和故障注入前拒绝。

## Task 2 — 统一运维入口

- [x] 新建 deployment.test.mjs，依赖注入测试命令严格解析、归属拒绝、默认与显式副本、更新顺序、备份失败不启动、重复环境显式停用。
- [x] 新建 deployment.mjs 与 deployment-resources.mjs，复用安装锁、localDocker 与原安装资源白名单；只读操作无锁文件副作用。
- [x] 实现 check/up/update/status/logs/stop/backup/consolidate；无自动拉取 Git、迁移数据库、生成新 Secret、删除卷或 prune。
- [x] package.json 增加 deploy 与 test:deployment。帮助命令在 Docker 不可用时仍可运行。

## Task 3 — 冷备份

- [x] 新建 deployment-backup.test.mjs，覆盖运行写入者拒绝、缺失/异属卷拒绝、只读归档参数、部分归档失败、完成清单及私有文件处理。
- [x] 新建 deployment-backup.mjs，备份目录独占创建并限制访问；只复制白名单，不跟随符号链接；逐卷校验归档并计算摘要，最终才发布完成标记。
- [x] update 在兼容性检查通过后停服冷备，再运行已有 up；不混入自动数据库迁移。

## Task 4 — 验收与文档

- [x] Conda cloud 执行 test:deployment、preprod 配置、监控配置、Runtime 配置、业务监控配置、CLI 和 telemetry 回归。
- [x] 真实 CLI 子进程验证帮助和非法参数；依赖注入覆盖操作调度及冷备文件流程，随机临时容器实测归档及异常清理；绝不恢复原常驻安装。
- [x] 写入 docs/60-unified-deployment-operations.md，包含命令、数量、停机窗口、旧入口兼容与备份恢复限制。
- [x] 复查 diff、Secret/归属边界、已有 M1 文件摘要未变；独立复核后报告实际通过项和未部署边界。

## 验收结果

- 运维专项 26/26，最终 15 文件关联回归 202/202，0 失败/跳过；记录 `output/deployment/regression-final.tap`。
- 实际临时卷归档/逐字节读取、异常存活 helper 的完整 ID 清理、官方 promtool 9 场景及旧容器/卷清单保留均通过。报告 `output/deployment/acceptance/2026-11-22T06-47-02-667Z-9428cdcb55eae7e947974b25/report.json`。
- 独立复核提出的初始化重试、停机前备份前提、超时 helper 清理与 Runtime 缺失容器部分停机均已修复并加回归；最终无剩余实质问题。
- 12 个既有 M1 文件 SHA-256 未变，diff whitespace 检查通过；无本机常驻启动或云服务器/业务库操作。未验收完整服务器更新窗口、PostgreSQL 恢复或异机灾难恢复；未提交推送。

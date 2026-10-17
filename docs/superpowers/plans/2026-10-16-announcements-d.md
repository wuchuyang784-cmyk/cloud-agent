# 公告 D：定时发布与故障恢复 Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development; test-first, spec review then quality review. 本次不提交、不推送、不部署，不迁移真实库。沿用用户已批准的总方案第 7、8、11 节与当前分支。

**Goal:** 让已保存的定时公告由独立受限进程安全发布，恢复、取消、过期和治理竞态有确定结果。

**Architecture:** PostgreSQL 原子逐条发布函数以数据库时钟为准，遵循治理共享锁→责任人角色共享锁→公告行锁顺序，SKIP LOCKED/版本条件防止重复。独立有界串行循环调用，失败退避；管理端增加时间选择、阻塞/延迟状态，指标使用专用受保护入口和 opt-in 规则。

**Tech Stack:** Node ESM、PostgreSQL 17、React/TypeScript、Prometheus。

## Task 1: 持久化调度底座

Files: `packages/db/migrations/045_announcement_publisher.sql`, `apps/platform-api/src/announcements/publisher-store.mjs`, publisher Memory/PG tests, `scripts/test-announcements.mjs`。

- [x] 写失败契约：未到期不发布、到期仅一次、延迟补发、有效期已过只过期、治理变更阻塞且解除不复活、取消后可重新确认。
- [x] 实现 `publisherTick(store,{limit:50})`，返回固定聚合计数，不泄露正文/用户。Memory 可注入时钟，PG 使用数据库时间。
- [x] 045 增加阻塞/尝试/下次重试/安全错误码、系统执行者审计元数据；固定函数只授权独立发布器，应用无调用权。单条事务/异常子事务保证审计失败回滚且安全退避不饿死后续记录。
- [x] 真库验证双池抢占、两方向取消/治理/撤权锁等待、审计失败回滚、重试、迁移重跑保留 OID/ACL/数据、最小权限。角色竞争已改非阻塞跳过，不要求发布器等待撤权事务。

## Task 2: 独立进程与监控

Files: `apps/platform-api/src/announcements/publisher-config.mjs`, `publisher.mjs`, `publisher-entry.mjs`, process/config/metrics tests, `package.json`, opt-in monitoring assets。

- [x] RED: 配置缺失/错误拒绝启动、专用数据库配置不读取业务 .env、5 秒串行轮询、失败恢复/退避、停止等待在途、指标鉴权/低基数。
- [x] GREEN: 显式 enable + 独立 DB URL + 指标 token；`announcements:publisher --check/--once` 与常驻入口；无 dev/API 自动启动、无旧 Worker、无 Docker 权限。
- [x] 聚合心跳、到期待处理、最大延迟、阻塞与失败数。监控配置及告警资产 opt-in，不自动修改常驻环境。
- [x] 一次性 PG + 真实独立子进程停启恢复；故障后保留上次采集快照，恢复可继续。

## Task 3: 管理端定时操作

Files: `apps/admin-console/src/announcements.ts`, `AnnouncementEditor.tsx`, `AnnouncementsView.tsx`, tests。

- [x] RED: 明确 Asia/Shanghai 的未来时间选择和二次确认，定时/取消的版本 UUID 重试保持，状态不假称已发布。
- [x] GREEN: 使用既有 publish mode schedule 与 cancel-schedule 路由；阻塞任务取消后重新确认，实际和计划时间/延迟区分；系统审计显示来源。
- [x] 保留会话围栏、未知写结果恢复、原导航与只读权限。修正 A/B 历史文案，不隐式保证发布器已部署。

## Task 4: 交付验收

- [x] 定向测试、公告真库全回归、后端全量、双端测试/构建。
- [x] 独立规格与质量复核，修复重要问题后再验。
- [x] `docs/55-platform-announcements-d.md` 记录权限启用/运行停止/监控接入与边界，更新总方案状态。
- [x] 确认临时资源精确清理，原服务仍停止；Git 不提交推送，真实库不操作。

测试统一使用 `D:/conda/Scripts/conda.exe run -n cloud --no-capture-output`。例如 `node --test apps/platform-api/test/announcement-publisher*.test.mjs`、`npm run test:announcements:db`、`npm test --prefix apps/admin-console`、`npm run build:admin`。先看到新增断言因缺失功能失败，再实现并运行同一命令验证通过。

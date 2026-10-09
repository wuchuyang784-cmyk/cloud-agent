# E2 Isolated Orchestrator Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. User has authorized local implementation; no deployment or external project creation.

**Goal:** 实际 Docker 生命周期、持久停止围栏、资源强制限制与隔离回收验收。

**Architecture:** E1 签名协议 → 独立 HTTP 编排服务 → 专用 ledger → Docker CLI。先记录意图再产生外部副作用，未知创建不冒充 absent。

**Tech Stack:** Node.js ESM、pg、Docker Engine、node:test。

---

### 1. Ledger 与生命周期

文件：`apps/platform-api/src/runtime/orchestrator/{ledger,service}.mjs`、`schema.sql`；测试 `apps/platform-api/test/orchestrator.test.mjs`。

- [x] 先写启动幂等、stop-before-start、create 未知、删除失败、TTL 和重启恢复断言；执行 `conda run -n cloud --no-capture-output node --test apps/platform-api/test/orchestrator.test.mjs` 观察缺实现失败。
- [x] 实现 `withRun(runId, fn)`、`read/write/list/consume`；PG session advisory lock，参数化 JSON ledger，Memory 同契约。
- [x] `start/stop/inspect/reap` 只接受 E1 DTO，先持久化 `creating/terminal` 再调用 driver；`creating + absent` 返回未知，禁止二次 create。
- [x] 重跑测试并核对 stop 失败不返回 stopped、重试不延长 TTL。

### 2. 固定 Docker driver

文件：`apps/platform-api/src/runtime/orchestrator/docker.mjs`；测试 `apps/platform-api/test/orchestrator-docker.test.mjs`。

- [x] 先断言参数白名单、完整归属与配置检查、Docker 查询失败非 absent。
- [x] 实现固定 probe 命令，pin image ID，internal 网络归属，create/start/read/remove；全部 CLI 无 shell、windowsHide、有超时及输出上限。
- [x] create 后确认资源、安全配置与运行健康；remove 前身份校验，以完整 ID 删除，再成功查询确认不存在。

### 3. HTTP 与入口

文件：`apps/platform-api/src/runtime/orchestrator/{http,index}.mjs`、`control-envelope.mjs`；测试 `apps/platform-api/test/orchestrator-http.test.mjs`。

- [x] 为异步原子 nonce 验证先加失败测试，再实现异步 verifier，保留同步调用兼容。
- [x] 实现固定路由、签名错误 DTO、有界 body/concurrency、HTTPS 入口、显式隔离开关，不读取业务 `.env`。
- [x] 入口循环 reaper，不加平台 Controller、用户 API 或业务迁移。

### 4. 真实隔离验收与交付

文件：`scripts/test-orchestrator.mjs`、`apps/platform-api/test/orchestrator-integration.test.mjs`、`package.json`、`docs/46-e2-isolated-orchestrator.md`、`AGENTS.md`。

- [x] 先写真实 PG/Docker 验收：启动容器、cgroup 读值、只读/nonroot、重复请求、服务重建、持久 stop 与 nonce、真实删除、TTL 到期清理。
- [x] runner 仅创建/删除随机标签的测试资源，不读业务配置、不拉取或替换预发镜像；异常路径也精确核对所有权后清理。
- [x] 执行 `npm run test:orchestrator`、`npm run test:runtime-control`、后端全量与平台回归（均 cloud 环境）。
- [x] 按 requesting-code-review 进行独立复核、处理问题、重跑测试；记录实际证据及未覆盖边界，不将隔离 probe 写成真实 Agent 上线。

## 验收记录

E2 34、E1 62、平台 25 全部通过；后端 251 通过、8 数据库专项跳过、0 失败。真实 HTTPS 进程强杀重启、受限 PostgreSQL 连接终止、Docker 改名/删除结果丢失等故障已覆盖。复核问题均先补失败用例再修复。详细边界与复现命令见 `docs/46-e2-isolated-orchestrator.md`；不推送、不部署，保留现有开发分支。

# 管理端单入口监控实施计划

> **For agentic workers:** 使用 test-driven-development 实施；每项完成后进行规格与质量核对。用户选择当前开发分支，不新建 worktree，不自动提交或部署。

**Goal:** 业务与预发监控均从管理端同源访问，Grafana 无独立发布入口，配置兼容云端 HTTPS 域名。

**Architecture:** 复用现有受限 Grafana API proxy；业务使用原机器桥接，预发使用未发布的 session forward_auth 桥接。网关仅发布平台 HTTPS 入口，Grafana 保留内部运行和历史卷。

**Tech Stack:** Node.js、React、Vite、Caddy、Grafana、Docker Swarm、node:test。

## 任务 1：页面与 API 契约

- [x] 修改 `apps/admin-console/test/monitoring-target.test.mjs`：相同固定 URL 携带 business/preprod scope；旧外链/缺失 URL 返回 null。导航测试确认无独立链接。运行 `npm test --prefix apps/admin-console` 观察新断言失败。
- [x] 修改 `apps/admin-console/src/monitoring-target.ts`、`MonitoringView.tsx`：仅同源目标，所有环境都检查同源 health；删除独立链接；刷新真正重新装载面板。
- [x] 修改 `apps/platform-api/test/admin-grafana.test.mjs`：session 模式仅向固定内部上游转发 Cookie，不转发伪造身份/Authorization；不允许配置任意 session 目标。修改 API/路由及配置测试后运行，确认新增断言先失败。
- [x] 修改 `apps/platform-api/src/admin/grafana-proxy.mjs`、`routes.mjs`、`app.mjs`：显式 `BAIRUI_GRAFANA_AUTH_MODE=session`；现有 Bearer 默认不变；overview 返回固定同源 dashboardUrl 或 null，而非独立地址；scope 来自显式环境。
- [x] 修改业务 connector 校验与生成，显式支持合法 HTTPS 公网 origin，生产拒绝本地开发 connector；保留原版开发配置。对 URL 凭据、路径、query、片段、非 HTTPS 公网和控制字符逐项拒绝。
- [x] 运行 API 专项、管理端测试和构建，核对原权限/固定查询行为。

## 任务 2：预发与网关收口

- [x] 在 `scripts/monitoring-config.test.mjs`、`preprod-config.test.mjs` 新增配置断言：无 9443；Grafana root_url 同源子路径；内部 9494 不发布；Cookie 仅用于 forward_auth；无应急 Grafana 登录入口。运行测试观察失败。
- [x] 修改 `scripts/preprod-config.mjs`：网关新增内部 session 鉴权桥接；API 配置固定内部目标、public origin、preprod scope；Grafana 使用子路径，关闭登录和 Live。
- [x] 修改 `scripts/preprod.mjs`、`monitoring.mjs`：去除旧端口检查和映射；就绪检查改为同源匿名拒绝而非独立登录成功；停止/up 保留资源。显式 public origin 经过校验并持久保存，云端域名设置用于网关、API 和采样面板。
- [x] 修改旧兼容性/验收脚本，移除对应独立登录假设，不通过删减断言隐藏故障。
- [x] 运行上述 npm scripts 对应的完整 node:test 文件组合（167 项通过），未执行常驻故障注入。

## 任务 3：真实验证与交付

- [x] 临时 Docker 专项验证官方 Caddy 配置可加载、Grafana 同源子路径 Viewer、匿名与伪造头拒绝、失效 fixture 会话拒绝、固定查询和资源回收。没有启动已停止常驻环境。
- [x] API 全量、客户端回归、管理端构建、`git diff --check`；依据实际结果记录通过、跳过和限制。
- [x] 文档写明云端域名配置与更新方法、仅一个浏览器端口、内部端口非用户入口；更新 AGENTS 当前边界；独立规格复核后质量复核均通过。
- [x] 验证本地原项目端口仍关闭；不自动推送、部署或迁移。

## 验证结果

- 后端全量：338 通过、9 个数据库专项跳过、0 失败；管理端与客户端各 19 通过；管理端构建通过。
- 配置/CLI/监控/Runtime/事务回归组合：167 通过、0 失败。
- 最终实际 Linux + Caddy/Grafana/Prometheus + 浏览器报告：`output/monitoring-single-origin/2026-10-15T14-10-58-034Z/report.json`，7 组检查通过；真实 12 面板请求无意外错误，1440/390/320px、刷新、单页签及鉴权拒绝通过。
- 认证使用隔离 MemoryStore fixture；真实 Better Auth + 业务库、公网 DNS/证书和已有 Grafana 卷升级不在本次部署验收内。
- 独立复核发现的 folderUid、首次 origin 校验、同镜像端口更新、测试角色清理和 Linux 路径问题已修复；各新增回归观察过失败后通过。
- 临时容器/网络已按归属回收；原项目端口全部保持停止。工作保留于当前开发分支，未提交/推送或部署。

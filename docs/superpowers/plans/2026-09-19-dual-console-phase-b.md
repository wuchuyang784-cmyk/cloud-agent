# 双端平台 B 批：本人 Agent 监控实施计划

> 执行工作流：executing-plans、test-driven-development、verification-before-completion。按步骤记录实际验证结果。

**目标：** 在客户端“开发与部署 / 可观测”交付本人 Agent 的只读监控入口，不增加平台管理能力，不开放 Agent 执行。

**架构：** 继续复用 Better Auth Principal、PostgreSQL RLS 和现有 React 控制台。按 SaaS 推荐的认证与业务授权分离原则，用户不直连 Grafana/Prometheus。读取现有 agents、runtime_routes、usage_events；不建立虚假的实时采样或第二套认证系统。

**技术栈：** Node HTTP、pg、PostgreSQL、React/Vite、Lucide、node:test、Playwright。所有命令在 Conda cloud 中执行。

## 范围与数据语义

- GET `/api/user/monitoring/agents`：limit 1..50、after 游标、q 搜索；服务端身份决定组织与用户，固定字段，不返回内部路由。
- GET `/api/user/monitoring/agents/:id?range=today|7d|30d`：先核对 Agent 所有权，越权和不存在均 404。统计现有已记录用量，按 Asia/Shanghai 自然日聚合；无样本指标为 null。
- 路由表 last_seen_at 是生命周期记录时间，不是持续心跳。记录超过 5 分钟显示陈旧；即使刚更新，也不能声称实时健康。实时采样时间、CPU、内存均为 null。
- 现有 legacy 用量写入不覆盖所有失败，历史可能来自 mock；不生成整体成功率、不把缺失天当成零调用、不推算费用。
- PostgreSQL 每次查询在本人 scope 事务内执行，语句限时 3 秒、固定 30 天窗口、有界列表。MemoryStore 保持相同投影与统计行为。
- 前端本次只改可观测入口，保留资源库和原导航；搜索、分页、Agent 详情、时间筛选、刷新、空态、错误态、过期会话与乱序响应保护。
- 不迁移业务库、不重建预发；真实管理员名称为 admin，但登录邮箱待用户提供，业务库缺少 034，须先备份和完成权限迁移。

## 执行步骤

- [x] 1. 添加 API 隔离、分页、字段白名单、用量窗口和缺失数据测试；运行并确认因未实现而失败（3 项：缺少 no-store / 404 而非 200）。
  文件：`apps/platform-api/test/client-monitoring.test.mjs`。
  命令：`conda run -n cloud --no-capture-output node --test apps/platform-api/test/client-monitoring.test.mjs`。
- [x] 2. 实现 `src/monitoring/client-store.mjs`、`client-routes.mjs`，接入 app 和 route labels；MemoryStore 记录结构化用量和历史路由，保留既有 getUsage 契约。
- [x] 3. 在一次性 PostgreSQL 中验证受限角色、同组织不同用户、同用户不同组织、池复用、聚合窗口和双 API。入口为 `npm run test:client-monitoring`；不读取 `.env`。
- [x] 4. 添加前端请求状态测试，确认后实现 `ClientMonitoring.tsx`、`monitoring-state.ts`、`monitoring.css` 和 API 类型；App 只替换可观测占位入口。
- [x] 5. 运行前后端回归和构建，使用独立数据库、真实 Better Auth 及 Playwright 检查桌面和移动端、错误/空态、筛选与退出；不注入业务样例。
- [x] 6. 更新中文接入文档和 AGENTS，记录实际通过项、监控数据局限及管理员创建前置条件。没有完成的实际部署不得标为验收通过。

## 实际验证记录

- 新增故障日志及超时测试先失败后通过。监控专项 7 项、客户端回归 18 项、后端常规 167 项通过（4 项数据库专项另行覆盖）。
- 平台专项 22 项、管理专项 4 项、调度专项 10 项通过；客户端生产构建通过。
- 监控 PostgreSQL 专项只应用至 033 的迁移，明确确认没有平台角色表仍可工作；覆盖受限角色、双 API、20 次交错请求和连接池 scope 清理。
- 独立浏览器验收通过三账号真实登录、本人数据、分页与搜索、时间窗口、无样本、错误重试、404、退出、空账号与会话失效；1440×960、390×844 页面无脚本错误、无整页横向溢出。
- 只读代码审查未发现可触发的安全或行为修复项；未读取 `.env` 或执行业务库写操作。
- B 批代码已交付，管理员尚未创建、业务库和常驻预发未部署。管理员邮箱与 034 备份迁移仍是实际接入前置条件，不在本次已完成项内。

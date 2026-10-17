# 平台公告 B 批 Implementation Plan

> 执行：在当前开发分支使用 executing-plans、test-driven-development 实施；独立代码复核，不自动提交或部署。已确认总体方案，本批不重开产品选型。

**Goal:** 让管理端通过真实平台会话完成公告草稿、预览、立即发布、撤回及审计。

**Architecture:** 管理路由复用 readAdmin，每次授权后进入独立公告 handler；A 的 Store 仍是变更/审计事务边界。前端使用独立 AnnouncementSession，与 AdminSession 的退出、导航、失败和权限刷新联动。042 扩展标题搜索，043 增加显式 expiryDays:30 策略重置；保留原签名/授权，不重写 041 或直接授权表。

**Tech Stack:** Node ESM/node:test、React 19/TypeScript/Vite、PostgreSQL 17、已有 Playwright/Chromium。

## 契约

- GET/POST `/api/admin/announcements`：q/status/after/limit 列表、创建草稿；POST JSON 为 title/body/severity/pinned/requestId，可选 expiresAt 或 expiryDays:30（互斥），不接受 action、id、actor。
- GET/PATCH `/api/admin/announcements/:id`：详情与完整草稿内容更新；PATCH 带 expectedVersion/requestId。
- POST `/api/admin/announcements/:id/publish`：仅立即发布，带 expectedVersion/requestId；定时模式不在 B 开放。
- POST `/api/admin/announcements/:id/withdraw`：版本、UUID、原因；GET `/:id/audit`：after/limit 审计。
- 401/403/404/409/413/415/422/429/503 使用既有 error envelope；无 Store 内部错误回显。所有读取 no-store；列表移除 body 和请求结果，详情才返回正文。
- 同源写、JSON 类型、重复/未知参数拒绝、最多 128 KiB（允许 2 万 Unicode 字符最坏 4-byte UTF-8）、每 API 最多 8 个在途写、每账号每实例每分钟 30 写（不是集群配额或共享安全边界）。限制有界缓存并淘汰旧窗口；不读原始 Cookie/正文作指标标签。
- me 增加 announcements:read、announcement-audit:read；platform_admin 再加 announcements:manage。失去管理权限或会话时清空编辑/审计和迟到响应。
- 编辑保存成功后才允许发布；已发布内容只读，修订走复制为新草稿。需要明确预览与发布确认；撤回原因必填。
- 未确认结果只允许重试原 method/path/body（含 requestId/version），不自动换 UUID；409 保留本地内容并禁止继续写，要求显式重新读取最新版本。HTTP 成功与列表/审计刷新失败分别提示。
- 所有时间标注 Asia/Shanghai；到期选项：默认 30 天、长期、指定截止。未保存编辑不因焦点轮询而消失。B 不接 C 通知，不启 D 调度。

## Task 1：后端接口 RED → GREEN

Files: create `apps/platform-api/test/announcements-api.test.mjs`, `apps/platform-api/src/announcements/admin-routes.mjs`; modify `src/admin/routes.mjs`, `src/admin/store.mjs`, `src/observability/labels.mjs`。

- [x] 写真实 HTTP Memory fixture（Better Auth Principal resolver 替身，不替代 Store），断言匿名/普通用户拒绝、viewer 只读、admin CRUD/发布/撤回/审计。
- [x] 写 strict method/query/body/origin、UUID/version、payload、幂等/并发、撤权、无公开用户公告路由和固定标签断言。
- [x] Run `conda run -n cloud --no-capture-output node --test apps/platform-api/test/announcements-api.test.mjs`，预期缺少路径 404 与权限失败。
- [x] 实现独立 handler，构造服务端 action/actor；调用 A Store；固定安全错误映射；同源、容量与写请求有界保护。
- [x] 重跑原命令至 GREEN；保留原管理权限，不给 operator 写。

## Task 2：标题搜索与真库 HTTP

Files: create `packages/db/migrations/042_announcement_admin_search.sql`, `apps/platform-api/test/announcements-api-postgres.test.mjs`; modify announcements validation/memory，原 test-announcements runner 与 PostgreSQL fixture。

- [x] RED：创建匹配标题与不匹配正文；`readAnnouncements(store, admin, {q:'标题',limit:1})` 跨页只有匹配标题；非法 q/普通用户拒绝。
- [x] 042 `CREATE OR REPLACE platform_announcement_read(text,jsonb)` 固定 schema，先验证 q 类型/长度/控制符，再调用原 validate(q-'q')；列表加入 `strpos(lower(title),lower(q))`，原签名/ACL 保留。
- [x] 真 Better Auth、受限 PG、双 API HTTP 验收；只显式授 A 函数 EXECUTE，不给表权限。迁移重复执行及故障缺授权不能影响原用户管理。
- [x] Run `npm run test:announcements:db`（Conda cloud），一次性随机容器，自身完整 ID 清理。

## Task 3：公告独立状态 RED → GREEN

Files: create `apps/admin-console/src/announcements.ts`, `apps/admin-console/test/announcements.test.mjs`; modify `src/session.ts`。

- [x] RED：独立模型负责列表/筛选/游标、详情/草稿/审计、create/edit/publish/withdraw。断言 `retry.body.requestId` 经超时重试保持一致。
- [x] 检查未知结果不得变更内容/重复生成 UUID；409 不自动提交；列表或详情迟到不覆盖新的编辑页，logout/403/navigation 清空状态。
- [x] 明确确认步骤与客户端输入校验，expiresAt 转换使用固定 +08:00；保留草稿、只读角色没有写入口。
- [x] AdminSession 构造独立模型；begin/cancel/fail 使之失效；公告 view 身份刷新调用 activate，不重建编辑状态。
- [x] Run `npm test --prefix apps/admin-console`（Conda cloud）观察 RED/GREEN。

## Task 4：页面与浏览器

Files: create `apps/admin-console/src/{AnnouncementsView,AnnouncementEditor}.tsx`; modify App/styles/navigation tests；create `scripts/test-announcements-browser.mjs`。

- [x] 增加第六导航与独立列表，标题搜索/状态/分页/创建/详情；编辑、纯文本预览、确认、只读发布详情、复制新稿、审计分页。
- [x] 保留原导航及监控；窄屏 390/320px 局部表格滚动，页面无横向溢出；dialog 采用 showModal 的焦点/ESC机制与语义标签。
- [x] `npm run build:admin` 验证类型与构建。
- [x] 临时受限 PG+真实 Better Auth+临时 Vite/API；浏览器登录管理员创建保存预览发布、撤回、审计、viewer 只读、普通用户拒绝、XSS纯文本、撤权与退出清理；截图与报告仅 output/playwright/announcements-b。

## Task 5：收尾

Files: create `docs/53-platform-announcements-b.md`；更新计划/进度。

- [x] 公告单元/真库/浏览器、后端全量、管理端与客户端回归、admin 构建；如原有失败先定位原因，不降低断言。
- [x] requesting-code-review 独立复核并补 RED 回归；无未解决重要问题后交付。
- [x] git diff --check、新文件空白检查；最终浏览器复跑8组通过且临时容器/端口已核对清理，原常驻服务保持停止；不迁移真实库、不提交/推送。

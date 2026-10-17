# 平台公告 A 批实施计划

> 执行：使用 executing-plans 在当前开发分支逐项执行；采用 test-driven-development，每阶段记录 RED/GREEN。主线程实现，按 requesting-code-review 独立复核；不自动提交或部署。

**Goal:** 交付可独立验收的公告数据库、授权、生命周期、幂等与审计底座。

**Architecture:** 新建独立 announcements 领域模块，以现有 MemoryStore/PostgresStore 为依赖。PostgreSQL 用固定受限函数原子完成公告/幂等/审计；用户可见投影与个人回执同样走固定函数，不改变已有通知接口。A 批只保存定时意图，不执行到期发布。

**Tech Stack:** Node ESM/node:test、PostgreSQL 17、现有 pg、一次性 Docker PostgreSQL。

## 契约与不变量

- `changeAnnouncement(store, actor, command, { now })`：command 为 create/edit/publish/schedule/cancel/withdraw；UUID requestId、expectedVersion；create 不传 id，服务端生成 UUID。返回 `{ announcement, requestId, replayed }` 或 `{ error }`。
- `readAnnouncements(store, actor, { id, after, limit, status, audit })`：仅有效平台角色读取；按 UUID 升序列表与 bigint 降序审计游标，有界 limit 1..100。
- `readUserAnnouncements(store, scope, { id, after, limit, history })`：真实成员、个人空间、非 banned；有效 published 才计未读；expired 历史只向显式 history 投影；不暴露操作者/内部调度信息。
- `markAnnouncementRead(store, scope, id)`：本人、active、当前有效已发布公告；幂等返回服务端 unreadCount。
- 标题/正文按 Unicode 码点计数，trim，拒绝控制符（正文允许 LF/TAB）、未知字段、非法 UUID/时间/版本；数据库重复校验，不能仅信任 JS。
- 过期默认按实际立即发布或计划发布时间 +30天；`expiresAt:null` 长期有效；草稿只保存到期选项。未来 schedule 保存责任人治理版本；D 批再实现到期执行，不提供 publish-due 权限。
- 主状态 draft/scheduled/published/withdrawn/expired；A 不做归档/系统 expire 操作。过期可见性仍按数据库时钟计算。
- 已发布内容不可编辑；scheduled 须取消后编辑；撤回仅实际已发布且尚有效，原因必填；旧请求回放返回原结果，权限仍需当次复核。
- 幂等保存在独立 request 表（不能依赖未来系统审计也必有人工请求 UUID）；actor+request 唯一、参数 JSONB 保存，审计只记录摘要/hash，不复制造成日志泄露。请求结果与状态/审计同事务。
- 锁序：治理共享锁 → actor 角色行 FOR SHARE → actor+request advisory lock → 公告 FOR UPDATE；Read Committed，锁后取时钟与治理快照。不能跨网络/异步等待持锁。
- 不为迁移授予 PUBLIC/应用直接表权限；函数参数是受信任 API actor，不是泄漏 DB 凭据后的身份保护。

## Task 1：RED 共享契约

Files: create `apps/platform-api/test/announcements.test.mjs`, `apps/platform-api/test/helpers/announcements-contract.mjs`。

- [x] 写 fixture：两名平台管理员、viewer/operator、普通个人空间账号和未知用户；固定时钟。
- [x] 调用 `changeAnnouncement(store, admin, { action:'create', requestId:randomUUID(), title:'平台维护', body:'维护说明' })`，断言 draft/version=1 与 created 审计。
- [x] 补状态、权限、不可见、回执隔离、幂等冲突、并发旧版本、默认/长期有效测试。
- [x] `conda run -n cloud --no-capture-output node --test apps/platform-api/test/announcements.test.mjs`：预期缺失模块失败；继续实现后逐项观察行为断言 GREEN。

## Task 2：GREEN 内存领域与校验

Files: create `apps/platform-api/src/announcements/{validation,memory,store}.mjs`。

- [x] 规范命令与查询；统一安全 error code；使用现有 governanceQueue 协调内存治理，整个变更串行且无中途 await；提交前构造状态与审计，不产生部分写入。
- [x] 内存实现独立 maps，保存原幂等结果；所有返回 deep clone。
- [x] 重跑 Task1 命令，断言全部通过；任何发现的缺陷先补 RED。

## Task 3：RED 数据库与最小权限

Files: create `apps/platform-api/test/announcements-postgres.test.mjs`, `scripts/test-announcements.mjs`；modify root `package.json`。

- [x] 独立随机容器/随机 schema、受限 NOLOGIN 角色，明确只应用 001/022..032/034/036/037/041，不触碰业务 .env。
- [x] 共用契约 + 直读/直写/审计篡改/PUBLIC函数拒绝、重复迁移保留历史和 grants、两池请求/版本并发。
- [x] 故障注入 audit CHECK 拒绝 published，断言公告与幂等均回滚；治理双方向等待与角色撤权锁等待。
- [x] `conda run -n cloud --no-capture-output node scripts/test-announcements.mjs`：预期迁移尚不存在失败，再实现 SQL。

## Task 4：GREEN 数据库与 PG adapter

Files: create `packages/db/migrations/041_platform_announcements.sql`, `apps/platform-api/src/announcements/postgres.mjs`；modify module store routing。

- [x] 四张 FORCE RLS 表：公告、回执、审计、幂等请求；固定函数校验、权限、锁、事务、内容 hash、时间和投影。固定 schema 不受 search_path 临时表影响；所有函数默认 PUBLIC revoke。
- [x] PG adapter 参数化 SQL、READ COMMITTED、3 秒语句/2 秒锁超时、rollbackForRelease；单连接池无嵌套借连接。
- [x] 一次性库跑全测试，关闭并精确清理仅自建资源；输出不含随机密码/连接串。

## Task 5：回归与交付

Files: create `docs/52-platform-announcements-a.md`；更新本计划、任务进度、方案确认状态。

- [x] `conda run -n cloud --no-capture-output npm run test:announcements` 与 `npm run test:announcements:db` 全通过。
- [x] 后端 `npm test --prefix apps/platform-api`、管理端/客户端现有静态测试；报告实际跳过数，不把未运行 DB 测试称为通过。
- [x] 自审：状态/权限/请求重放/时间边界/锁序/投影不含私有字段；`git diff --check`；记录旧服务仍停止。
- [x] 交付仅 A 底座完成与下一批 B；不创建公告、不执行业务迁移、不提交/推送。

结果：公告专项 35/35、后端 354 通过/10 专项跳过、双端 38/38、原管理真库 12/12、原治理真库 15/15；独立复核无 Critical/Important。详见 `docs/52-platform-announcements-a.md`。

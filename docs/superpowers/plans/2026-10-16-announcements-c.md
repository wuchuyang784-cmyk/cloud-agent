# 平台公告 C Implementation Plan

> 使用 subagent-driven-development 分拆后端任务并逐阶段规格/质量复核，主任务完成前端与集成；TDD，当前分支，不自动提交/部署。

**Goal:** 所有真实个人账号在原铃铛/通知中心读取有效公告及个人通知，以权威未读数和幂等个人回执闭环。

**Architecture:** 新独立 user-routes/notifications Store 层复用 A 公告数据。044 提供有界合并查询、个人写和全部已读去重函数，不扩大原通知RLS。前端独立 NotificationSession 持有列表/详情/计数/请求围栏，App仅绑定用户生命周期与原铃铛；轮询不重载平台能力。

**Tech Stack:** Node ESM/node:test、PostgreSQL17、React/TypeScript/Vite、已安装Playwright。全部Conda cloud。

## 固定接口与投影

- GET `/api/user/notifications`：`{notifications,unreadCount,nextCursor}`，兼容旧notifications字段。参数 source=all|announcement|notification、read=all|unread|read、history=true|false、after、limit=1..100；默认all/all/false/25。unreadCount为全局有效未读，不受分页/筛选影响。
- 行 `{id,source,referenceId,type,title,body,isRead,readAt,createdAt,pinned,severity,status,expiresAt}`：公告id=`announcement:<uuid>`，referenceId原UUID、type=announcement，body为最多240码点摘要；普通通知id不变、source=notification，保留原type/body，其他公告选项为固定默认。不得返回org/user/actor/调度内部字段。
- 固定排序：有效置顶公告优先，再createdAt降序、source和referenceId确定排序；不置顶已结束历史。cursor有界严格校验，保留PG时间精度；服务器筛选不只过滤当前页。
- 已结束公告不计未读；history=true也不将其纳入read=unread，只保留历史all/read。
- GET `/api/user/announcements`：同一投影但固定source=announcement，返回`{items,unreadCount,nextCursor}`。
- GET `/api/user/announcements/:id?history=true`：`{announcement,unreadCount}`，announcement沿用A用户DTO（UUID、完整body、status/publishedAt/expiresAt/severity/pinned/isRead）。草稿、未来scheduled、撤回404；过期只history=true可读。
- POST `/api/user/announcements/:id/read`：空JSON或无body，幂等`{ok:true,id,isRead:true,unreadCount}`，只读治理403。
- PATCH `/api/user/notifications/:id`：原个人通知语义，接受空body或`{read:true}`，重复已读也成功、跨用户404，返回`{ok:true,updated,unreadCount}`。
- POST `/api/user/notifications/read-all`：推荐`{requestId:UUIDv4}`，兼容原无body；单次可见快照内全部有效公告和本人原通知原子已读，不受列表筛选影响；同scope/requestId重放不再次标记后来发布内容，响应`{ok:true,updated,unreadCount,replayed}`。请求记录仅固定元数据，不存正文。
- 本批所有写同源、严格字段/类型、有界正文/总时限/并发或频率保护；不接新跨域来源；legacy原有测试须保持。读取no-store；固定指标标签；body/actor等不入指标。

## Task 1：后端 / 044（委托）

Files：新 `src/announcements/{notifications,user-routes}.mjs`（可按职责拆Memory/PG模块）、`packages/db/migrations/044_user_notification_center.sql`、`test/notification-center*.test.mjs`；最小修改 app.mjs委派并删除旧三路通知分支、observability labels、公告测试runner（不改root package脚本，主任务负责）。

- [x] 写共享Store契约及HTTP RED：有效可见/未读、原通知保留、两用户回执隔离、分页/筛选/历史、重复已读、读后再发布新公告、同UUID全部已读重放、普通/暂停/封禁、错误不泄露。
- [x] 运行 `conda run -n cloud --no-capture-output node --test apps/platform-api/test/notification-center.test.mjs` 确认缺模块/行为失败后实现。
- [x] 044固定schema/search_path、SQL二次校验、FORCE RLS请求表，清理非owner默认ACL，仅受限函数EXECUTE；治理共享锁/个人scope成员复核；快照集合原子写，重复all请求不扩展集合。
- [x] HTTP Principal严格scope、query/path/method/body/origin；仅改新合并路径，不启Agent/Worker；legacy原通知语义兼容，无公告时不造数据。
- [x] 真BetterAuth+受限PG+双API、并发同UUID all与幂等单条、回滚、迁移重跑授权/OID/记录保留、直接私有表与跨scope拒绝；使用既有随机一次性runner并按完整ID清理。“all vs 单条/撤回”的额外确定性交错测试作为复核建议记录于docs/54，不宣称已覆盖。

## Task 2：前端独立状态（主任务）

Files：新 `src/notification-state.ts`、`test/notifications.test.mjs`；api.ts暴露请求包装与通知DTO，不引入额外依赖。

- [x] RED：fetch失败 unreadCount=null 而非0；会话/账号切换/退出及乱序忽略；公告详情成功才read；suspended不read；失败原UUID重试，不乐观扣数。
- [x] 实现activate/reset/refresh/filter/next/back/open/markAll/retry，独立Abort/超时/代次、单轮去重和写串行。count取服务端，确认写后刷新列表，读取失败独立提示、不重复执行已确认写。
- [x] list/detail/mark分代，撤回404清空旧详情，权限拒绝触发身份刷新；旧list/count响应不能覆盖新mark。query变化重置cursor，未知结果仅原命令重试。
- [x] 30秒可见轮询、焦点/恢复可见/打开铃铛刷新，隐藏不请求，所有事件/定时器清理；不影响平台能力。

## Task 3：页面与现有客户端接入（主任务）

Files：新 `NotificationCenter.tsx`、`notifications.css`；修改App原铃铛/notice弹层/完整panel；仅删除原通知加载与mark的乐观状态路径，不重构其他业务。

- [x] 原铃铛保留，未知计数明确提示；弹层最近12条及查看全部。完整列表支持source/read/history、分页、独立加载错误/上次更新时间、显式快照全部已读。
- [x] 公告详情纯文本、发布/到期时间/已结束提示，旧通知仍可看；只读账号隐藏/禁用已读操作并解释。
- [x] 登出发起即清空通知，用户/空间变化立即隔离并忽略旧响应。原导航、资源库、Agent能力开关不变。
- [x] `npm test --prefix apps/console-mvp`与`npm run build --prefix apps/console-mvp`通过；320/390px无页面横向溢出。

## Task 4：独立复核与真实浏览器

- [x] 先规格复核、再质量复核，修复重要问题并回归；不由实现者自评代替复核。
- [x] 新 `scripts/test-notification-center-browser.mjs` 使用自有随机PG/临时双前端API真实BetterAuth：管理端发布后两个业务账户都能看，个人已读隔离；已结束/撤回、全部已读后新公告未读、失败不造0、暂停只读、退出清空、桌面/窄屏及纯文本。
- [x] 原公告50专项、原管理端32、客户端全量、API全量、治理/平台专项、前后端构建；实际跳过单独记录，不写成通过。
- [x] docs/54记录真实结果与044最小授权/未部署边界，git diff --check；临时资源清理，原常驻服务保持停止；不提交/推送。下一批D。

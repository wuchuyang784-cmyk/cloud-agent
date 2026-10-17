# 平台公告 A：数据库与领域底座

日期：2026-10-16。用户已确认公告方案并授权 A 批。本批仅开发独立底座，不是公告功能已经上线。

## 1. 本批交付与边界

- 独立 `apps/platform-api/src/announcements/` 模块，Memory/PostgreSQL 双实现；不改现有 app、通知 HTTP、客户端页面、管理端导航或启动链。
- 迁移 `041_platform_announcements.sql`，新增公告、个人回执、审计和幂等请求四张私有表。
- 草稿创建/编辑、立即发布、保存定时意图、取消定时和撤回的状态机；版本校验、请求 UUID 幂等、原子审计。
- 受限管理员查询、个人公告投影和个人已读函数，作为 B/C 批接口的内部依赖；目前没有公开公告 API。
- 第一阶段站内纯文本、有效期默认精确 30×24 小时，也可设置绝对截止时间或 `expiresAt:null` 长期有效。新账号可查看仍有效公告，不需要逐人写通知。
- 不接自动到期发布/过期状态清理、管理页面、通知中心合并、全部已读或监控。定时意图不会因读取/登录而发布，也没有后台进程。

业务库、预发库、云服务器没有执行迁移；没有创建真实公告、启动已有常驻服务、启用 Agent、提交或推送本批代码。

## 2. 内部调用契约

从 `apps/platform-api/src/announcements/store.mjs` 导入：

```javascript
changeAnnouncement(store, actorUserId, command)
readAnnouncements(store, actorUserId, query)
readUserAnnouncements(store, { userId, organizationId }, query)
markAnnouncementRead(store, { userId, organizationId }, announcementId)
```

`store` 为现有 MemoryStore 或 PostgresStore。actor 和 scope 必须由未来 HTTP 层从已验证 Principal 提取，绝不能接受浏览器指定的操作者。数据库函数信任后端传入 actor，不是数据库应用凭据泄漏后的独立身份认证系统。

命令：

| action | 字段（均带 requestId） | 限制 |
| --- | --- | --- |
| create | title、body，可选 severity/pinned/expiresAt | 服务端生成公告 UUID，初始版本 1 |
| edit | id、expectedVersion、title、body，可选上述内容选项 | 只编辑草稿，省略的可选项保留原值 |
| publish | id、expectedVersion | 草稿立即发布 |
| schedule | id、expectedVersion、scheduledAt | 草稿，未来带时区时间，仅保存意图 |
| cancel | id、expectedVersion | 待发布退回草稿，清空原责任人与时间 |
| withdraw | id、expectedVersion、reason | 有效已发布公告，原因必填 |

`requestId` 和公告 ID 为 UUID v4；版本为正整数。相同 actor/requestId 和规范化参数重放返回原结果、`replayed:true`，不会新增审计；同键不同参数冲突。回放也要重新检查当前管理员权限。失效版本冲突不覆盖他人编辑。

标题 1–120、正文 1–20000，按 Unicode 码点计数；标题不允许控制符，正文允许 LF/TAB、不允许 CR/其他控制符。传输层可在后续编辑器把换行统一为 LF。内容只作纯文本保存/展示，不解析 HTML。时间严格检查日历与时分秒、时区偏移，以及归一化后的公元 1–9999 年。

返回 `{ announcement, requestId, replayed }` 或 `{ error }`；查询返回有界 `{items,nextCursor}`。语义错误包括 `invalid_announcement_input/query/time/state`、`platform_role_required`、`version_conflict`、`idempotency_conflict`、`not_found`、`account_read_only/banned`。数据库/连接故障抛出安全的 `announcements_unavailable`（503），不暴露 SQL、正文或连接串。

管理员查询支持 id、status、limit(1..100)、after；列表按 UUID 升序，`id + audit:true` 按审计 bigint ID 降序。用户查询支持 id、limit、after、history；常规只展示有效发布，显式 history 保留已过期发布内容；草稿、未到期定时和撤回永远不投影。置顶/级别目前只存储，C 批再明确统一通知排序。

## 3. 数据与授权

- `platform_announcements` 保存内容、版本、责任人、计划/实际时间、到期策略和撤回信息。
- `platform_announcement_receipts` 按个人空间/用户/公告唯一；只有用户显式标记时新增，成员关系外键及函数授权复核。
- `platform_announcement_audit` 保存动作、actor、执行类型、版本、字段名摘要、内容 hash、时间和原因；不复制公告正文。
- `platform_announcement_requests` 保存规范化参数及原结果，处理跨请求/跨版本重试；属于受限持久业务数据，不作公开审计或日志。

四表均 ENABLE/FORCE RLS，没有向应用开放的直接表策略，读写只通过固定函数。迁移会撤销这些私有表/序列继承的非所有者 ACL（包含绕过 RLS 的 TRUNCATE 权限），以及新函数继承的默认 EXECUTE；不修改其他对象或全局默认权限。重跑保留已有函数 OID、所有权和显式函数授权；四张私有表仍不允许直接授权。

应用账号须非所有者、非超级用户、无 BYPASSRLS，也不能继承所有者角色。函数由受信任且可跨 FORCE RLS 的迁移所有者持有，固定真实 schema 和 search_path；PUBLIC 无 EXECUTE。

有效 platform_admin 可以修改；active 的 platform_viewer/operator/admin 可以读管理记录。普通账号/个人空间 org_admin 无跨用户管理权限。用户读只允许真实个人空间成员，暂停可读但不能标记，封禁拒绝。个人投影不返回管理操作者、原始参数或内部调度字段。

## 4. 原子性、锁与时间

每个 PG 变更在一个 READ COMMITTED 短事务中完成：治理共享事务锁 → actor 角色行 FOR SHARE → actor/request advisory lock → 公告 FOR UPDATE → 写入公告、幂等结果及审计 → 提交。与现有治理独占锁和角色 UPDATE/DELETE 协调。失败回滚全部变更；不在事务内进行外部请求。连接回滚不确定时丢弃连接，避免复用脏事务。

审计摘要统一为 `SHA256(UTF8(title + LF + body))`；标题禁止 LF，编码无歧义。Memory/PG 有精确共享向量测试，字段名摘要按字典序排序。请求幂等比较规范化 JSON，不依赖不稳定 JSONB 文本编码。

数据库时钟在公告行锁取得后决定发布/定时准入；当前过期可见性不依赖发布器。未到期 scheduled 不能直接发布；必须取消后重新确认。过期/撤回不能再次激活，发布后内容不能改写。

定时意图目前记录责任管理员和治理版本。D 批仍需实现到期执行、角色撤销/恢复围栏、阻塞与重新确认、重启补发/失败退避及监控，不能把本批的 scheduled 记录解释为可自动发布。

## 5. 迁移接入（尚未执行）

前置迁移：基础业务表、031 个人空间类型、032 Better Auth、034 平台角色、036/037 治理。无须模拟调度 033/038 或 Runtime 039/040。目标环境须先备份并核对表/函数所有权、应用实际角色与默认授权；后续由明确的部署任务执行 041，不重跑历史治理迁移。

迁移后仅给受限应用角色 schema USAGE 及以下函数 EXECUTE：

```sql
-- 示例假定 schema=public、应用角色=bairui_app；部署时先核对实际名称。
GRANT USAGE ON SCHEMA public TO bairui_app;
GRANT EXECUTE ON FUNCTION
  public.platform_announcement_change(text,jsonb),
  public.platform_announcement_read(text,jsonb),
  public.platform_announcement_user_read(text,text,jsonb),
  public.platform_announcement_mark_read(text,text,uuid)
TO bairui_app;
```

不要对四表或审计序列执行 GRANT ALL，也不要把内部 document/validate 函数单独授给应用。A 没有发布器身份或相关授权。当前管理端 `/api/admin/me` 的权限集合不变，B 批接入公告路由时再显式扩展。

## 6. 验收入口与证据

必须使用 Conda cloud：

```powershell
conda run -n cloud --no-capture-output npm run test:announcements
conda run -n cloud --no-capture-output npm run test:announcements:db
conda run -n cloud --no-capture-output npm test --prefix apps/platform-api
```

第二条创建随机名称、随机凭据、随机回环端口的一次性 PostgreSQL 17 容器，使用独立测试 URL 变量；不读取业务 `.env`。测试使用受限角色、单连接池和独立第二连接池，结束只按完整容器 ID 清理自身资源。迁移按明确前置清单执行；夹具包含宽泛默认表/序列/函数授权，验证 041 主动收紧。

专项覆盖共享双 Store 契约、真实权限与 TRUNCATE 拒绝、SQL 二次校验、双池幂等/版本并发、审计失败回滚与同请求重试、迁移重跑保留、治理双方向锁等待、角色撤权等待、新账号补看、个人回执、过期即时隐藏及安全故障处理。尚不代表 HTTP/浏览器端公告、定时发布器或目标环境部署验收。

2026-10-16 最终结果：公告独立专项 35/35 通过、0 跳过；后端全量 354 通过/10 个数据库专项跳过/0 失败；管理端与客户端原测试各 19（合计 38）通过；原管理端真库专项 12/12、治理真库专项 15/15 通过。全量中的公告数据库专项因专用环境变量未设置而跳过，已通过独立 runner 真库验证，不将跳过项计为通过。

独立代码复核后补齐默认 ACL、时间规范化、审计 hash 编码和过期历史一致性；最终复核无 Critical/Important 遗留。临时数据库均已清理，原常驻服务保持停止。没有宣称公告页面或定时发布已上线。

## 官方依据

- [PostgreSQL 17 显式锁](https://www.postgresql.org/docs/17/explicit-locking.html)：事务 advisory 与行锁协调。
- [CREATE FUNCTION](https://www.postgresql.org/docs/17/sql-createfunction.html)：固定 search_path 与受限 SECURITY DEFINER。
- [行安全](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)：RLS 不能替代对象权限，TRUNCATE 等不受行策略控制。

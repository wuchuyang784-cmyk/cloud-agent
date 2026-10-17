# 平台公告 C：业务端接收与个人通知中心

日期：2026-10-16。A/B 底座与管理端之上完成 C 批代码开发和隔离验收。未提交、推送、迁移业务/预发库或部署到云服务器；原常驻本地服务保持停止。

## 1. 使用效果

业务端保留原通知铃铛，弹层展示最近 12 条并提供“查看全部”。完整通知中心支持来源、阅读状态、已结束公告、25/50/100 条游标分页。原个人系统/计费等通知继续显示，不改变资源库或 Agent 导航，不触碰平台执行能力开关。

管理员通过 B 发布后，所有个人账号（包括之后新注册的账号）都可读取仍有效的共享公告；不逐人复制内容。每人已读回执独立，A 标记已读不改变 B 的未读数。数字表示当前账号的有效未读，不表示全员已送达或理解正文。

点击公告先读取完整正文，成功后再对有效未读公告标记已读。纯文本按换行展示，不执行 HTML。详情区分发布时间、截止时间与“已结束”，明确 Asia/Shanghai。草稿、待发布与撤回内容不可读；到期立即退出常规列表和未读，不依赖发布器清理。明确勾选历史可读已结束内容；即使开启历史，未读筛选也排除过期公告。

suspended 账号可以查看，但不能标记已读；banned 账号拒绝会话。解除限制不启动 Agent、不开能力、不恢复旧会话。原个人通知保持原所有权边界，管理账号从业务端访问也不能跨用户。

## 2. 权威计数与全部已读

所有 C 接口返回的 unreadCount 都是“有效公告 + 本人原通知”的全局有效未读，不受当前列表过滤、分页或公告专用入口影响。前端不递减猜数、不乐观清零；请求失败标为“未读数未知”，可保留上次列表并提示过期风险，不伪装为空通知。

“全部已读”以一次服务端操作的可见集合为准，不受当前筛选或分页限制。PostgreSQL 在一个语句快照选择两个来源，原子写个人回执和普通通知状态，并在同一事务保存 requestId 去重记录。提交失败整笔回滚。之后新发布的公告和新个人通知仍未读。

前端为每次全部已读生成 UUID v4。结果未知时保留同一 method/path/body/requestId 重试；服务器按个人空间、用户和 UUID 去重，重放不扩展原已读集合，重新返回当前计数。重放也复核账号状态。原无正文 read-all 调用保留兼容，但没有客户端稳定 UUID，不能承诺跨请求的原操作重放语义。

单条已读幂等，重复操作成功；普通通知跨用户返回 404。已读写成功与后续列表刷新失败分别提示，刷新失败不重发已确认操作。未知已读结果可关闭详情，原命令保留在恢复入口，不把用户困在离线弹窗里。

## 3. 接口

| 接口 | 行为 |
| --- | --- |
| GET `/api/user/notifications` | 合并列表，兼容 notifications/unreadCount，新增 nextCursor |
| GET `/api/user/announcements` | 仅公告列表，返回 items/unreadCount/nextCursor |
| GET `/api/user/announcements/:id` | 公告完整正文；history=true 可读取过期历史 |
| POST `/api/user/announcements/:id/read` | 无正文或空 JSON；仅个人幂等已读 |
| PATCH `/api/user/notifications/:id` | 原个人通知；无正文或 `{read:true}`，重复成功 |
| POST `/api/user/notifications/read-all` | `{requestId:<UUIDv4>}`，两个来源快照全部已读 |

合并列表参数：source=all/announcement/notification、read=all/unread/read、history=true/false、limit=1..100、after。公告列表固定 source=announcement，不接受覆盖来源参数。列表默认 25 条。

有效置顶公告优先，其后按时间降序及确定的来源/ID 排序；已结束公告取消置顶。游标绑定来源/阅读/历史条件、长度有界、严格日期与类型校验，保留数据库六位微秒，拒绝不可能日期和公元 0000 年。

公告列表 id 为 `announcement:<uuid>`，referenceId 为原 UUID；type=announcement、正文为最多 240 码点摘要。普通通知 id/type/body 不变，增加 source/referenceId 等统一字段。详情才返回完整公告正文；不返回组织/用户归属、管理员身份、原请求参数或调度内部字段。

所有路径从已验证 Principal 提取个人范围，拒绝 owner/userId/orgId 注入；包括匿名拒绝在内均 no-store。平台 Better Auth 写入要求精确同源 Origin；仅非生产显式 legacy 保留原无 Origin 调用。拒绝未知/重复参数、错误方法、非 JSON 编码和额外正文。

正文上限 1 KiB、完整上传总时限 10 秒；每 Store/进程最多 16 个在途请求。单 actor 每进程每分钟写 120、读 240 次尝试，有界 4096 窗口缓存，429 返回 Retry-After。这是进程内保护，不是共享集群配额。PG 适配器继续使用有界语句/锁超时和安全错误投影；指标只有固定路由，不含身份、游标或正文。

## 4. 前端状态与会话

新独立 NotificationSession 分离列表、详情、写入与当前身份；统一计数代次防止旧列表、旧详情或失败覆盖较新计数。所有请求有 AbortController、总超时和迟到响应围栏。退出、账号或空间切换清空个人状态；未读请求号不存 localStorage/sessionStorage。

页面可见时每 30 秒、焦点恢复、恢复可见及打开铃铛刷新；单轮去重，隐藏时不轮询，卸载清理监听与定时器。通知刷新独立于 App 的资源/能力刷新，不能重启 Agent 或重新开放失败的能力。

退出发起即清空通知并阻止在途身份查询恢复内容。退出失败后，显式重新验证当前服务器身份；仅同一会话的成功身份结果可以重新激活通知。旧会话迟到退出不会修改新会话。刷新页面会丢弃本地未确认命令，须重新查询核对；不承诺跨浏览器刷新恢复未确认请求号。

## 5. 044 迁移与最小授权（未执行真实环境接入）

前置：已有 028 个人通知、031/032 个人空间/Better Auth、034 平台角色、036/037 治理，以及 041 → 042 → 043 公告底座。044 不依赖旧模拟调度和 Runtime。未安装的目标环境先备份并按顺序追加，不能重跑旧治理迁移或重建卷绕过迁移。

044 新增私有 `platform_notification_center_requests`，保存个人范围、请求 UUID、变更数量和时间，不存正文或认证信息；ENABLE/FORCE RLS，无直接应用策略/授权。新增固定 schema/search_path 函数，撤销 PUBLIC 和继承的默认非 owner 授权；重跑保留函数 OID、所有者、显式授权和历史。普通通知原 RLS 不放宽。

迁移由受信任所有者执行，受限应用角色只增加下列 EXECUTE（示例角色/schema 必须核对目标环境实际值）：

```sql
GRANT EXECUTE ON FUNCTION
  public.platform_notification_center_read(text,text,jsonb),
  public.platform_notification_center_mark(text,text,text),
  public.platform_notification_center_all(text,text,uuid),
  public.platform_announcement_user_read(text,text,jsonb)
TO bairui_app;
```

公告详情沿用最后一个 A 函数；若已授权则无需重复变更。不给应用辅助函数 access/rows、请求表、公告表/回执/审计或序列直接权限，不授 BYPASSRLS。数据库函数信任服务端 actor 参数，不是应用数据库凭据泄漏后的独立身份系统。

写入与现有治理共享事务锁协调；C 的个人范围锁串行化单读/全部已读，公告行锁与撤回协调。适配器保留事务失败回滚与不确定连接丢弃。未开放任意收件人、跨用户回执查询或管理端之外的发布能力。

部署批次还需显式更新业务/预发应用授权、全部 API 副本和客户端镜像；本批没有改预发 bootstrap/启动链，不能把本机临时库验收当作真实环境升级。定时发布器、定时操作入口、开机常驻部署仍属 D/E。

## 6. 验证与证据

全部命令在 Conda cloud；独立 runner 不读取业务 .env：

```powershell
conda run -n cloud --no-capture-output npm run test:notifications
conda run -n cloud --no-capture-output npm run test:announcements:db
conda run -n cloud --no-capture-output npm test --prefix apps/platform-api
conda run -n cloud --no-capture-output npm test --prefix apps/console-mvp
conda run -n cloud --no-capture-output npm test --prefix apps/admin-console
conda run -n cloud --no-capture-output npm run build --prefix apps/console-mvp
conda run -n cloud --no-capture-output npm run build:admin
$env:BAIRUI_PLAYWRIGHT_MODULE = '<installed-playwright>/index.mjs'
conda run -n cloud --no-capture-output npm run test:notifications:web
```

已验证：C 快速专项 16/16；A/B/C 真实 PostgreSQL 独立专项 79/79，含受限应用、双 API/连接池、全局计数、并发同 UUID、回滚、授权/OID 保留、微秒游标及双向治理锁；后端全量 380 通过/12 数据库专项跳过/0 失败，客户端 37/37，管理端 32/32，原平台真库 25/25、治理真库 15/15，两个前端构建通过。跳过项不计通过，公告相关真库由独立 runner 验证。

最终真实浏览器 **11 组通过、pageErrors 为空**，报告 `output/playwright/announcements-c/2026-10-16T12-25-00.923Z/report.json`，桌面/390/320px 截图位于同目录。验证管理端发布后双业务账户可见、原个人通知和已读隔离、纯文本全文、未知单读关闭/重试、全部已读原 UUID 重放后新公告保持未读、新注册补看、503 未知与恢复、真实暂停只读、到期历史和真实撤回、窄屏及模态居中、退出失败身份恢复、旧会话退出清空。

浏览器使用随机临时 PostgreSQL、独立非超级用户 LOGIN 角色、真实 Better Auth、临时双 Vite/API 与合成身份。503/退出失败为浏览器响应注入，到期为测试时钟数据注入；不宣称实际停库/生产故障验收。真实注册和登录不关闭限流。所有结果仅适用于本批隔离环境，不代表大规模负载、公网或所有故障交错。

规格与质量分别独立复核，计数跨通道乱序、详情失败、过期未读积压、未知已读弹窗和退出恢复均补 RED 回归后修复，当前无未解决 Critical/Important。后端复核建议后续补更细的“全部已读 vs 单条/撤回”确定性锁交错测试；本批不能将未执行的交错写成已验收。

## 官方依据

- [PostgreSQL 17 数据修改 WITH](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-MODIFYING)：同语句的数据修改共享快照；本批以 candidates CTE 选择两来源。
- [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/17/sql-createfunction.html)：固定 SECURITY DEFINER search_path 与对象授权。

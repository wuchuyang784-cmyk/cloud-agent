# 平台公告 B：管理端发布与审计

日期：2026-10-16。承接 A 的数据库/领域底座，在当前开发分支实施；本批代码未提交、未部署，真实业务库/预发库/云服务器未迁移。

## 1. 已实现范围

现有五项导航保留，增加第六项“公告管理”。active 的平台管理员可创建、编辑、预览、立即发布、填写原因撤回、复制为新草稿及查看操作审计。viewer/operator 只读，个人空间管理员不获得平台权限。原账号、Agent、Grafana 同源监控和平台能力开关保持原语义。

列表支持服务器端标题搜索、状态筛选、25/50/100 条游标分页；列表不返回正文，详情按需获取。编辑器展示版本、操作人 ID、计划/实际发布时间及截止时间，支持普通/重要、置顶、发布后精确 30 天、长期或指定截止时间。时间明确为 Asia/Shanghai，指定时间保存保留秒/毫秒，不使用浏览器本地时区推断。

正文只按纯文本和换行展示，不解析 HTML。保存草稿不等于发布；须保存后明确确认立即发布。已发布内容不可编辑，纠错须撤回后复制新稿。未保存内容禁止直接复制旧存储版本，关闭时提示丢弃确认。

本批**没有接入业务端公告接收/通知中心（C）、自动定时发布器及定时操作入口（D）**。页面明确提示这一边界。A 已有的 scheduled 记录仅供读取，不保证自动生效；用户公告路由仍未开放。不能把管理端发布成功解释为全员已收到或已读。

## 2. HTTP 契约

所有接口复用 Better Auth、当前 Principal、active 账号状态和显式平台角色，每次重新授权；返回 no-store，不接受浏览器指定 actor。公告缺迁移/授权时返回独立 503，不使用户账号管理降级为可绕过授权。

| 接口 | 行为 / 主要字段 |
| --- | --- |
| GET `/api/admin/announcements` | q（仅标题，最多 200 字符）、status、after、limit（1–100） |
| POST 同上 | title、body、可选 severity/pinned/到期策略、requestId |
| GET `/:id` | 正文与详情 |
| PATCH `/:id` | 完整标题/正文及选项、expectedVersion、requestId；仅草稿 |
| POST `/:id/publish` | expectedVersion、requestId；仅立即发布，不接受 mode/scheduledAt |
| POST `/:id/withdraw` | expectedVersion、requestId、必填 reason（最多 500 字符） |
| GET `/:id/audit` | after、limit，降序有界分页 |

路径中的 id 为 UUID v4。所有写入要求同源 Origin、application/json；拒绝未知字段、重复查询参数和额外编码。正文上限 128 KiB，以原始字节计数；完整上传总时限 15 秒，不因持续发送零星字节续期。每 Store/进程最多 8 个在途写，单 actor 每进程每分钟 30 次尝试，缓存上限 4096 actor；超限 429 + Retry-After。它是单实例有界保护，不是集群共享限额。

到期策略互斥：`expiryDays:30` 显式选择发布后 30 天；`expiresAt:null` 为长期；`expiresAt` 为带时区 ISO 截止时间。编辑时省略仍保留原策略，不能靠省略把长期改回默认，因此增加 043 与双 Store 契约测试。

创建成功 201 + Location，相同请求重放 200；不存在 404、版本/幂等/状态冲突 409、内容/时间错误 422、类型 415、超大正文 413、上传超时 408。内部故障不回显 SQL、连接串、正文或认证信息；指标仅固定路由标签。

## 3. 编辑器恢复与会话隔离

- 超时、网络中断或未知结果保留原 method/path/body/requestId，锁定编辑，只允许重试原请求；数据库原子幂等防重复审计。
- 已存在公告的版本冲突保留本地内容但禁止继续覆盖，必须显式重新读取最新版本。明确的校验拒绝解除锁定，可修正后生成新请求，不把未保存草稿锁死。
- 写入成功与审计刷新失败分别显示；审计读取失败不重新发送已确认写入。详情失败在列表显示可见错误，可重新选择。
- 独立 AnnouncementSession 使用会话、列表、详情代次和 AbortController；切换页面、退出、401/403、身份变化立即清空内容，迟到请求不能恢复旧草稿/审计。
- 身份焦点/30 秒刷新不丢弃未保存内容。未确认请求仅保存在当前内存会话，不跨浏览器刷新持久化，也不存储到 localStorage/sessionStorage；刷新后需重新查询核对。

## 4. 后续环境接入（本批未执行）

先按 A 文档核对前置基础表、031/032/034/036/037、所有者和受限应用角色，并备份目标库。未安装 A 的环境按顺序执行 041 → 042 → 043；已有 041 的环境只追加 042、043，不重跑旧治理迁移。

042/043 使用 CREATE OR REPLACE，保留原函数 OID/所有者及显式授权；PUBLIC 不获得 EXECUTE。B 管理 API 只需受限应用角色对既有两个管理函数的 EXECUTE（具体 schema/角色必须按目标环境核对）：

```sql
GRANT EXECUTE ON FUNCTION
  public.platform_announcement_change(text,jsonb),
  public.platform_announcement_read(text,jsonb)
TO bairui_app;
```

不授四张私有表、审计序列或内部 validate/document 函数访问，不扩大 BYPASSRLS。C 的个人函数授权见 A 文档，不能借公告扩张其他用户数据访问。迁移后更新所有 API 与管理端同版代码，再使用真实平台管理员验证；未迁移环境的公告 503 不是“暂无公告”。

本批未改 dev/预发启动链和部署脚本；预发自动 bootstrap 尚未增加公告函数授权，部署批次须显式处理真实库/新建库的最小权限及镜像更新，不能直接把本机临时测试认作预发验收。原常驻本地服务保持停止，未开启 Agent/旧 Worker/发布器。

## 5. 验收

全部命令在 Conda cloud 中运行，不加载业务 .env：

```powershell
conda run -n cloud --no-capture-output npm run test:announcements
conda run -n cloud --no-capture-output npm run test:announcements:db
conda run -n cloud --no-capture-output npm test --prefix apps/admin-console
conda run -n cloud --no-capture-output npm test --prefix apps/console-mvp
conda run -n cloud --no-capture-output npm test --prefix apps/platform-api
conda run -n cloud --no-capture-output npm run test:admin
conda run -n cloud --no-capture-output npm run test:governance
conda run -n cloud --no-capture-output npm run build:admin
# 使用明确已安装的 Playwright 入口；不自动下载/安装浏览器。
$env:BAIRUI_PLAYWRIGHT_MODULE = '<installed-playwright>/index.mjs'
conda run -n cloud --no-capture-output npm run test:announcements:web
```

已完成：公告快速 Memory/HTTP 24/24，独立真库专项 50/50（含真实 Better Auth、受限应用连接、双 API、双 Store、迁移重跑、原子回滚、并发发布/治理锁）、管理端 32/32、客户端 19/19、后端全量 363 通过/11 个数据库专项跳过/0 失败；原管理端真库 12/12、治理真库 15/15，管理端类型及生产构建通过。全量跳过不计通过，公告真库由独立 runner 完整验证。

最终浏览器 8 组通过，pageErrors 为空：`output/playwright/announcements-b/2026-10-16T05-38-30.301Z/report.json`。包含创建/长期改默认有效期/纯文本预览/发布审计、拒绝后的编辑恢复与详情错误外显、标题搜索/观察员只读/普通账号拒绝、双管理员409冲突不覆盖、撤回原因及持久审计、390/320px列表和详情、撤权清空、退出清空旧会话。桌面及窄屏截图已人工检查，表格仅局部滚动，页面无横向溢出。

使用随机临时 PostgreSQL、四个合成账户、真实 Better Auth 及独立临时 Vite/API/端口，不使用业务会话。注册/登录遵守真实限流，按 Retry-After 重试，不关闭限流。故障注入的 422/503 恢复检查已单独标识，不能当作真实数据库故障验收。最终临时数据库与浏览器/API/Vite 已关闭；Docker无运行容器、原常驻端口无监听；git diff --check及新文件尾部空白检查通过。

独立后端及前端复核已完成；前端发现的校验拒绝锁死、详情错误隐去、未保存复制丢失与截止时间截断，均先复现再补回归并修复，复核无未解决 Important 问题。正文保护新增未完成上传并发、abort 释放、总超时释放与 UTF-8 分片测试。

## 官方依据

- [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)：独立状态订阅与稳定快照。
- [React useEffect](https://react.dev/reference/react/useEffect)：事件/定时器及清理。
- [HTMLDialogElement.showModal](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal)：原生模态与焦点交互。

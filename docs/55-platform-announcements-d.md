# 平台公告 D：定时发布与故障恢复

日期：2026-10-16 开始，2026-10-17 继续验收。代码开发与一次性隔离验收；**未提交、推送、部署，未操作业务/预发数据库或云服务器**。A/B/C 的原改动保留。E 批负责目标环境备份、迁移、授权和常驻发布。

## 1. 本批能力

- 管理端保存草稿后可选择立即或定时发布。时间明确为 Asia/Shanghai，北京时间转换为带时区 ISO，最终由数据库时钟校验未来时间与有效期。
- 定时保存只表示 scheduled，不表示已发布。列表与详情区分待发布、已到计划时间仍待发布、发布阻塞、实际已发布；详情显示计划/实际时间与系统审计。
- 待发布可二次确认取消，退回草稿再编辑、改时间或重新确认。操作携带版本及 UUID；未知结果保留原方法、路径、内容和 UUID 重试，409 不覆盖他人修改。
- 独立发布器默认约 5 秒串行一轮，最多 50 条；不在用户登录/GET 请求、API 启动或 dev 中暗中执行，也不复用旧 Agent Worker。
- 停止期间错过但仍有效的计划可以补发，记录真实发布时间；有效期已经结束的未发布公告只记录 expired，不曾对用户发布。已经发布的历史与个人回执保留。
- 默认 30 天：立即发布从实际发布时间计算，定时计划从计划时刻计算，不因延迟补发自动延长；指定截止时间或长期策略保留原语义。
- 每次状态收敛与系统审计在同一事务中提交。审计含原定时责任人、原治理版本、系统执行类型和真实数据库 session_user；没有给所有账户复制通知。

## 2. 数据、并发与恢复

追加迁移 `045_announcement_publisher.sql`，前置为既有基础/认证/管理/治理及公告 041→042→043→044。不要在已有 D 环境倒序重跑旧公告迁移；它们是历史定义。

045 增加 `publish_blocked`、固定安全错误码、尝试次数、下次尝试时间、角色代次及系统审计字段。既有公告函数用同签名替换，保留 OID 和显式 EXECUTE；新机器函数剥离 PUBLIC 与继承的默认授权。

机器端只有两个固定入口：

```text
platform_announcement_publisher_tick(integer)  -- 1..50；写入固定生命周期与审计
platform_announcement_publisher_status()       -- 只读聚合
```

返回固定数值 `{processed,published,expired,blocked,failed,pending,maxDelaySeconds,blockedTotal}`，没有正文、账号、任意 SQL/actor 或目标 URL 参数。进程使用 READ COMMITTED、连接 2 秒、语句 10 秒、查询 12 秒及有界锁等待。

发布遵循治理共享锁→责任人角色共享锁→公告行锁，并在锁后复核代次/版本/状态。角色共享锁使用 LATERAL/SKIP LOCKED 在批量 LIMIT 前筛选；最早责任人角色被锁住时跳过该候选，后续其他管理员仍可发布，即使每批限制为一条。缺少角色绑定不是“暂时锁住”，会进入明确阻塞判定。多副本只有一次有效发布和对应审计；取消先赢则不发布，发布先赢则旧版本取消返回冲突。短暂锁竞争不能被当成发布成功。

单条审计/处理失败回滚该条状态与审计，持久安全码 `publisher_item_failed`，按 5、10、20 秒递增、最长 300 秒退避，后续任务可继续。整轮数据库连接失败使用进程退避，成功后恢复正常周期；处理中的 Client 也有错误监听，断连后丢弃连接，不能仅依赖 idle Pool 错误监听。停止等待在途操作。不能保证数据库故障下的发布时限。

### 授权变化不复活旧计划

责任人非 active、非平台管理员、被撤权，或治理/角色代次变化，旧计划都阻塞；解除限制不会自动恢复。角色代次来自该责任人 `platform_admin_audit` 的不可变 `role_changed` 事件计数，在角色共享锁下读取，并有部分索引。因此角色审计必须保留、只追加，不能独立裁剪或改写这类历史。没有新增角色管理入口或放宽原账号权限。

若检测到授权变化但阻塞审计失败，仍保留阻塞围栏，下次只重试阻塞审计，不能因权限恢复改为发布。D 前已存在的计划没有角色代次，迁移后采取相同的保守阻塞，需要有效管理员取消并重新确认。

## 3. 专用进程配置

不读取仓库 `.env`，不回退 `DATABASE_URL`。由服务管理器或显式专用环境文件提供：

| 配置 | 规则 |
| --- | --- |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_ENABLED` | 必须显式 `1` |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL` | 独立受限 LOGIN；拒绝 postgres、业务连接复用与 URL 参数覆盖 |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_TLS` | 回环可为 `0`，非回环必须 `1` 并验证证书 |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_CA_FILE` | TLS 可选 CA 文件；不能用关闭证书验证替代 |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_TOKEN_FILE` | 必须；32–256 字符随机强 token，文件有界读取 |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_INTERVAL_MS` | 默认 5000，100–60000 |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_BATCH_SIZE` | 默认 50，1–50 |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_HOST` | 默认 127.0.0.1；容器采集时显式配置 IP 并限制网络 |
| `BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_PORT` | 默认 9496，1024–65535 |

数据库 URL 只允许固定格式 search_path options，不接受 sslmode/host/role 等查询覆盖。TLS 在代码 ssl 对象中设置，避免 URL 参数覆盖 CA/验证配置，依据 [node-postgres SSL 文档](https://node-postgres.com/features/ssl)。

入口（以下是部署人员在 E 授权后执行的操作，本批没有运行真实常驻服务）：

```text
npm run announcements:publisher -- --check   # 检查配置/最小权限/只读状态，无发布、无监听
npm run announcements:publisher -- --once    # 显式执行一轮，不常驻
npm run announcements:publisher             # 常驻，SIGTERM/SIGINT 等待在途退出
```

Linux 模板：`infra/systemd/bairui-announcement-publisher.service`。使用独立 OS 用户、只读系统、无 capabilities、无 Docker/socket。节点必须实际具备 Node 24；核实 `/usr/bin/node` 和 `/opt/cloud-agent` 后再安装，模板未在云服务器执行。

E 批准备完成后，服务管理可使用 `systemctl start/stop/status bairui-announcement-publisher`。停止不删除公告、审计、请求幂等记录或回执，重启从 PostgreSQL 继续，不在本机新装后台系统服务。

## 4. E 批最小授权清单

先备份并核对迁移、函数所有者的 FORCE RLS 能力、原业务数据，再由 DBA 创建专用角色。以下以 public 为示例，数据库名/角色与应用账号必须明确对应目标环境；本批未执行这些 SQL：

```sql
CREATE ROLE bairui_announcement_publisher LOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
-- 密码通过受限凭据渠道配置，不写入仓库/终端日志。
GRANT USAGE ON SCHEMA public TO bairui_announcement_publisher;
GRANT EXECUTE ON FUNCTION public.platform_announcement_publisher_tick(integer),
  public.platform_announcement_publisher_status() TO bairui_announcement_publisher;
```

按目标库策略授予 CONNECT。不授表、序列、业务公告编辑函数或任意用户查询权限，不让该角色继承其他宽权限角色；应用角色继续保留 A/B/C 的固定函数，**不能**授予这两个机器函数。

启动检查拒绝超级用户、BYPASSRLS、建库建角色/复制能力、已知业务表直接权限或公告编辑函数权限，要求两个固定机器函数均可执行。这是配置错误检查，不替代 DBA 对角色全部授权与部署网络的审核。

## 5. 同源监控接入资产

专用 `/metrics` 要求单个 Bearer，只输出低基数聚合：最近周期状态、上次成功时间、到期待发布数、最大延迟、阻塞数、失败计数与本进程确认的发布计数。没有有效快照前不创建待发布等零值；失败保留旧值并设周期失败。发布计数是进程观察值，不宣称可跨重试汇总为全局恰好一次计数。

`scripts/announcement-monitoring-config.mjs` 提供 opt-in `announcementMonitoringAssets({environment,targets})`，输出固定 scrape、五条告警和四个可追加到既有 `bairui-platform` 看板的面板。多副本共享数据库快照用 max，不按副本 sum 重复统计。

| 告警 | 条件 |
| --- | --- |
| AnnouncementPublisherUnavailable | 目标不可达/缺失、关键指标缺失或心跳陈旧 |
| AnnouncementPublisherCycleFailed | 最近一轮失败 |
| AnnouncementPublishDelayed | 未阻塞计划最大延迟超过 60 秒 |
| AnnouncementPublishBlocked | 存在需重新确认计划 |
| AnnouncementPublishFailed | 最近五分钟有失败计数增长 |

既有同源 Grafana 代理增加 business/preprod 各四条固定表达式，浏览器不能自选其他 PromQL、数据源或 URL；原独立 Grafana 入口不恢复。既有接收器允许这五个固定名称并保留 firing/resolved，记录仍是固定安全投影。

E 批需显式把 scrape/rules/panels 合并到目标环境配置、挂载独立 token Secret 并完成官方配置检查和真实链路验证。本批没有修改常驻 Prometheus/Grafana/Alertmanager，也没有假称管理端已采集真实部署的发布器。

## 6. 验收入口与记录

统一在 Conda cloud 环境：

```text
npm run test:announcements:publisher
npm run test:announcements:db
npm run test:announcements:rules
npm test --prefix apps/platform-api
npm test --prefix apps/admin-console
npm test --prefix apps/console-mvp
npm run build:admin
```

浏览器使用既有 `npm run test:announcements:web`，显式指定已安装的 `BAIRUI_PLAYWRIGHT_MODULE`，一次性数据库与真实 Better Auth/受限数据库角色，不读取业务环境。D 新场景覆盖北京时间选择、取消重确认、受限机器发布、系统审计及 1440/390/320px。

当前浏览器 9 组通过、pageErrors 为空，报告 `output/playwright/announcements-d/2026-10-16T14-47-02.461Z/report.json`；定时到期时间由验收夹具前移，实际发布仍使用数据库时钟。NOLOGIN/终止连接为真实临时数据库故障注入，不是操作真实业务账号。

官方 promtool 14 场景/70 断言通过；固定接收器已验证五类 firing/resolved。它们是规则、接收器和进程分段验收，不等于云端完整告警链路或生产容量保证。

2026-10-17 修复后的最终回归：

- 公告 A/B/C/D 一次性真库 **126/126**，零跳过，包含真实独立发布器进程重启与 NOLOGIN/连接终止恢复、21 个 PG 调度子场景、两方向治理/取消/撤权与角色锁公平性。
- 发布器定向 **46/46**；独立规格复核额外运行 Memory/进程/监控 **23/23** 并通过。
- 后端全量 **406 通过 / 14 独立库专项跳过 / 0 失败**；公告真库专项已单独执行，不把全量跳过视为真库证明。
- 管理端 **34/34**、客户端 **37/37**，双端构建成功。
- 既有业务监控 **36/36**、预发监控配置 **26/26**；官方公告规则 **14 场景 / 70 断言**。

独立规格复核与质量复核均通过；质量复核者独立运行定向测试 23/23，没有剩余 Critical/Important 问题。临时数据库与浏览器服务已清理，原本停止的项目及发布器端口无监听，HEAD 仍为 `f95632b`。始终不开放真实 Agent、模拟 Worker、对话执行或支付能力，不迁移真实库，不提交或推送代码。

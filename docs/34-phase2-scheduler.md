# 第二阶段：本机模拟调度

日期：2026-09-17。

## 已确认设计

- 10 个测试用户，每用户运行上限 5、排队上限 20；全局运行上限 10、排队上限 200。
- 两个 API、两个 Worker，每个 Worker 运行上限 5。
- 模拟任务持续 2 至 5 秒，不调用模型，不申请真实 CPU/内存。
- Better Auth 负责身份，平台负责归属和调度。使用独立测试库，不修改用户业务库。

## 实施清单

- [x] 迁移与双 Store。
- [x] 原子配额、轮转、租约、重试上限及版本校验。
- [x] 默认关闭的测试 API 与独立 Worker。
- [x] 单元测试与 PostgreSQL 双连接池调度验收。
- [x] 中文操作与边界说明。

第一批串行化短暂的调度事务，执行任务不持锁；这是本机正确性基线，不是高吞吐最终方案。
单节点不能验证跨主机高可用。现有 Agent API 本批不变更。

## 当前可直接执行的验收

在仓库根目录运行：

```powershell
npm run test:scheduler
```

要求本机 Docker 正常运行，后端依赖已安装。脚本创建随机名称、随机密码、随机本地端口的临时 PostgreSQL 容器，执行后清理。
脚本不读取项目 .env，不连接 bairui 业务库。首次缺少指定镜像时 Docker 会下载镜像。
测试账号仅为临时 schema 的用户与个人空间数据，不会向真实邮箱发信。

启动等待使用本机映射端口建立 PostgreSQL 连接并执行 SELECT 1，不以容器内部 pg_isready 的结果作为就绪依据，避免初始化临时数据库造成误判。连接或查询暂时失败时会有限重试，但不会重试已经开始的整套集成测试。若之前遇到 Connection terminated unexpectedly，可更新脚本后重新执行同一命令，不需要修改业务库或重新导入迁移。

已验证：

- 10 用户各提交 5 个任务，共 50 个；两套连接池/Store 竞争领取，分五批全部完成。
- 每批全局运行 10 个，每个 Worker 标识最多 5 个，每个用户不超过 5 个。
- 活跃个人空间按最后领取次序轮转；单个用户独占队列时仍只能领取 5 个。
- 普通数据库角色无超级用户、无 BYPASSRLS；未设置租户范围看不到任务，跨用户查询和取消返回不存在。
- 幂等重放不重复创建任务；同键不同输入冲突；队列达到用户/全局准入上限后拒绝新任务。
- 成功、模拟失败、取消；租约过期重新领取，旧执行结果被拒绝，三次租约耗尽后失败。
- 默认关闭、白名单、Origin 校验，以及禁止请求体传入所有者等额外字段。
- 原 Better Auth 真实 PostgreSQL 双 API 身份隔离测试通过。

测试中的 Worker 故障通过将租约置为过期来注入，尚不是实际杀进程或断网实验。

## 手动测试环境配置

以下仅用于独立测试数据库，不要求立即操作用户现有数据库。

1. 先备份目标测试库，按顺序完成已有迁移，再执行 033_simulation_tasks.sql。
2. 管理员为实际应用角色授权（角色名不同时需替换）：

```sql
GRANT SELECT,INSERT,UPDATE,DELETE
ON simulation_tasks,simulation_tenants TO bairui_app;
```

3. 在测试环境显式配置以下变量，并保留已有 Better Auth 地址、密钥及数据库连接：

```dotenv
BAIRUI_SIMULATION_ENABLED=1
BAIRUI_SIMULATION_USERS=你的测试账号邮箱,另一个测试账号邮箱
```

生产模式强制关闭模拟 API 和 Worker；白名单为空时无人可调用。白名单只是测试准入，不授予跨租户权限。
重启测试 API，另外启动两个独立终端，各自执行：

```powershell
npm run start:simulation-worker --prefix apps/platform-api
```

不要为此运行旧 Agent Worker 或真实 Runtime。根目录 npm run dev 的历史启动行为本批未改动。
独立 Worker 每次启动生成唯一身份；中断未完成任务后不伪造成功，等待租约回收。

## API 契约

所有接口需要有效登录身份和测试账号白名单。写请求还要求 Origin 与 BETTER_AUTH_URL 完全一致。

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | /api/simulation/tasks | 提交模拟任务；必须提供 Idempotency-Key 请求头 |
| GET | /api/simulation/tasks | 当前用户最近 100 个任务 |
| GET | /api/simulation/tasks/{id} | 当前用户的指定任务 |
| POST | /api/simulation/tasks/{id}/cancel | 取消排队或运行中的任务 |

提交正文仅接受 durationMs（2000 至 5000 的整数）与 outcome（success 或 failure）。
不接受命令、URL、模型参数、userId、organizationId；不创建真实 Agent。
错误：校验失败 422，幂等冲突 409，队列满 429，其他用户的任务与不存在任务统一 404。

## 数据与可靠性

- simulation_tasks 保存归属、幂等键、输入、状态、执行次数、Worker 标识、租约和时间。
- simulation_tenants 保存调度轮转次序。
- 运行中任务本身作为并发槽位预留；完成、取消或租约失效会释放槽位，不另设可漂移的内存计数器。
- PostgreSQL 使用数据库时间。租约 15 秒，模拟执行每秒心跳，最多领取 3 次。版本以 attempt 校验。
- 排队上限约束新提交；故障恢复会把已接纳运行任务放回队列，因此恢复期间排队数可短暂超过准入上限，但不再接纳新任务。
- 会重试的任务按至少一次执行设计。以后接入真实副作用时，必须继续实现业务幂等，不能直接照搬等待型模拟器。
- 按现有项目习惯，调度事务设置服务端 worker scope；它不是抵御数据库凭据泄露的独立权限边界，浏览器不得持有数据库凭据。

## 尚未完成

以下为第一批结束时的边界。第二批现已提供独立 Swarm 多进程与真实注册登录验收，执行 npm run test:scheduler:swarm；实测与剩余限制见 [35-phase2-swarm-acceptance.md](35-phase2-swarm-acceptance.md)。第一批双 Store 测试本身仍不代表 Swarm 验收。

- Swarm 双 API、双 Worker 的实际部署、杀进程、断网与连接池耗尽验收。
- 调度负载通过真实账号注册登录贯通的端到端验收（当前身份回归与调度负载分开验证）。
- 实际 CPU/内存预留与容器限制、调度分片、高吞吐优化、排队等待时间与吞吐报告。
- 任务状态历史审计、监控指标、过载重试指引及历史任务清理策略。
- 测试控制界面；当前控制台未新增模拟任务入口。

因此本篇记录第二阶段第一批调度内核，不代表整个第二阶段或生产上线验收完成。

# 平台模式与认证代理安全

日期：2026-09-17。承接第一阶段账号体系与第二阶段 Swarm 验收。

## 本批范围

只落地两项：统一关闭平台侧的 Agent 写操作和模拟充值；验证可信代理后的认证限流。
继续使用开源 Better Auth 1.7.5 管理凭据、会话和数据库限流，使用 Caddy 与 Docker Swarm 验收多进程场景。
没有另写一套认证或限流器，不接入真实 Agent、支付、监控或常驻部署。

本批没有新增数据库迁移。不读取或修改业务 .env，不连接 bairui，不变更现有账号、密钥或数据库容器。
下文配置操作由使用者在自己的环境执行。

## 平台模式

BAIRUI_PLATFORM_MODE 默认是 platform，另一个合法值是 legacy。

| 行为 | platform（默认） | legacy（仅非生产显式开启） |
| --- | --- | --- |
| 认证和存储 | 必须 Better Auth + PostgreSQL | 保留历史配置及回归路径 |
| Agent 创建、修改、删除、启动、关闭 | 拒绝写入 | 沿用旧实现，未实现的路由仍返回 404 |
| Agent 会话创建、对话执行 | 拒绝写入 | 沿用旧实现 |
| 模拟充值 | 拒绝写入 | 沿用旧实现，不是真实支付 |
| 历史 Agent 查询、账户流水查询 | 保留当前用户范围内查询 | 保留 |
| 资源库、收藏、通知、个人设置、备案记录 | 保留当前用户范围内操作 | 保留 |
| npm run dev | API + 控制台 | 额外启动旧 Agent Worker、mock-runtime、boundary |

非法模式直接启动失败。生产环境禁止 legacy。平台模式缺少数据库或使用 local/dev 认证时直接报错，不悄悄回退内存库。
只有显式注入测试依赖且 NODE_ENV=test 的单元/浏览器测试允许内存实现。

API 先确认登录身份，再统一拒绝受限写入，返回 HTTP 403、错误码 capability_disabled；拒绝发生在解析请求体和写入业务数据之前。
前端禁用只是交互反馈，不能替代后端授权。查询历史资源仍遵守 Principal、个人空间与 RLS；跨用户查询仍返回 404。

GET /api/auth/config 返回 capabilities，并禁止缓存。前端默认关闭能力；配置失败、退出、会话失效均保持关闭。
请求序号与会话序号共同保证旧响应不会覆盖新请求或新账号的状态。
模板与原有 Agent 子导航保留，但模板不能创建实例；历史 Agent 标为历史记录。资源库仍位于平台状态区域。
部分导航仍为占位页面，保留入口不等于该业务已实现。

旧 Agent Worker、mock-runtime、boundary 的独立启动入口也检查模式。
这不会自动终止更新前已运行的旧进程，也不会清空历史 Outbox；切换时必须先停止旧服务。
模拟调度 Worker 属于独立验收链路，不是旧 Agent 生命周期 Worker，不受这次启动清单移除影响。
模拟接口仍默认关闭、要求账号白名单，且生产环境禁用。

## 已有环境怎么启动

已完成 031、032 并能正常注册登录的环境，不需要重复导入 SQL，不要删除认证表或重建账号。

1. 在旧服务所在的 PowerShell 窗口按 Ctrl+C，确认旧服务停止。
2. 在项目根目录安装更新后的后端依赖：

~~~powershell
Set-Location E:\cloud-agent
npm ci --prefix apps/platform-api
~~~

3. 在已有 .env 中确认以下三行。不要覆盖整份配置，不要修改原 DATABASE_URL、BETTER_AUTH_URL 或现有密钥：

~~~dotenv
BAIRUI_PLATFORM_MODE=platform
BAIRUI_AUTH_MODE=better-auth
BAIRUI_TRUSTED_PROXIES=
~~~

BAIRUI_TRUSTED_PROXIES 留空适用于当前本机开发。无需把密钥发到聊天中，也无需再次运行 setup:env 覆盖原配置。
新的 setup:env 只用于首次准备环境，自动生成独立的会话和认证密钥。

4. 启动：

~~~powershell
npm run dev
~~~

默认启动 platform-api 与 console-mvp，不再启动旧 Agent Worker 和 Runtime。
只启动后端可以执行 npm run dev:api，只启动前端使用 npm run dev:web。
浏览器使用原 BETTER_AUTH_URL 对应的地址；localhost 与 127.0.0.1 不要混用。

前端默认固定监听 `127.0.0.1:5173`，与启动脚本提示保持一致；5173 已被占用时直接报错，不自动换端口。
如果旧版本显示启动成功，但访问 `127.0.0.1:5173` 出现 `ERR_CONNECTION_REFUSED`，可能是前端只监听了 IPv6 的 `::1`。
更新后重新启动即可应用固定监听地址，不需要修改数据库、账号或认证密钥，也不要为此开放局域网监听。

5. 验证（API 使用默认 8080 时）：

~~~powershell
Invoke-RestMethod http://127.0.0.1:8080/healthz
Invoke-RestMethod http://127.0.0.1:8080/api/auth/config
~~~

healthz 应包含 database=postgres；认证配置应为 provider=better-auth，capabilities.mode=platform，三个能力布尔值均为 false。
登录后应能查看、编辑自己的资源和个人记录；Agent 创建与对话、模拟充值不可用。
用第二个账号登录，不应看到第一个账号的私有资源。

## 可信代理与限流

配置 BAIRUI_TRUSTED_PROXIES 为逗号分隔的真实代理 IP 或非零 CIDR，默认不信任任何转发头。
禁止星号、trust-all、0.0.0.0/0、::/0、localhost 等宽泛或非 IP 写法。

只有实际 TCP 对端命中白名单时，才解析 X-Forwarded-For；从右向左寻找第一个不可信跳点。
可信链最多 16 个地址、总长度 2048 字符，每项必须是合法 IP；格式异常时拒绝，不使用攻击者提供的值继续认证。
非可信对端的 X-Forwarded-For、X-Real-IP 和自定义内部 IP 头不能改变限流身份。
传给 Better Auth 的 x-bairui-peer-ip 由服务器覆盖，不能由浏览器决定。

本地 Vite 代理默认仍可能让本机请求共用一个限流桶。这不是多公网用户的容量验收；遇到 429 应遵守 Retry-After，不能通过关掉限流来绕开。
要部署真实代理，必须先确认网络拓扑、API 的实际 TCP 对端以及直连入口的网络访问控制。
不要直接复制验收报告中的临时 IP，也不要把整个 overlay、宿主网段或回环地址加入信任来消除报错。
未能区分真实入口代理与不可信客户端时，保持默认不信任并先修正入口拓扑。

### PostgreSQL 时间戳兼容

限流继续由 Better Auth 原生数据库实现执行，副本共享 ba_rate_limit。
实测发现 pg 将 bigint 列 lastRequest 返回为字符串，Better Auth 1.7.5 的窗口计算会产生异常巨大的 Retry-After。
通过受支持的 Kysely 数据库入口，在 ba_rate_limit 查询结果上做局部、安全整数转换；不替换限流逻辑，不修改其他表的 bigint 解析，不靠截断等待时间掩盖问题。
该修复没有改变数据库表结构。后续升级 Better Auth 时需重新运行相关测试。

### Swarm 验收拓扑

验收脚本读取本次 Caddy 的确切 overlay IP，只信任该 IP 的 /32。
Caddy 动态解析 tasks.<API服务名>，使用 round_robin 直接连接两个 API task，避免本次 VIP 路径改变 TCP 来源。
keepalive off 用于小流量下验证双副本，不能直接当作生产性能配置。
入口、API 与数据库仍只在一次性本机验收网络中运行；没有修改常驻业务部署。
验收专用 x-check-* 响应头仅位于 scheduler-check-entrypoint，不属于正常 API 的公开契约。

## 验证结果

2026-09-17 本机执行：

| 验证 | 结果 |
| --- | --- |
| npm test --prefix apps/platform-api | 88 通过，2 个专用 PostgreSQL 集成测试跳过 |
| npm test --prefix apps/console-mvp | 9 通过，含刷新竞态与退出后旧响应回归 |
| npm run build --prefix apps/console-mvp | 通过 |
| npm run test:platform | 15 通过，含真实 PostgreSQL、受限角色、双 API 认证与限流 |
| npm run test:scheduler | 10 通过，含真实 PostgreSQL 调度 |
| npm run test:scheduler:swarm | 通过，报告 bairui-swarm-check-eef00244e1 |

两项被普通后端测试跳过的 PostgreSQL 测试，分别由 test:platform 与 test:scheduler 在一次性数据库中执行，不是未验证。

最新 Swarm 报告位于 output/scheduler-swarm/bairui-swarm-check-eef00244e1.json：

- 10 个用户注册、退出、登录；同一会话跨两份 API，个人空间独立。
- 同一客户端 16 次并发错误登录：3 次进入密码校验、13 次 429，覆盖两份 API；伪造头不能绕过。
- 另一真实 TCP 客户端不继承前一个客户端的限流桶。
- 50 个基线任务完成，两份 Worker 都执行；采样峰值为全局 10、单用户 5、单 Worker 5。
- SIGKILL 后的 10 个恢复任务完成，5 个发生重试，双 Worker 副本恢复。
- 报告 success=true、cleanup.success=true，临时资源无残留。

浏览器使用独立内存测试夹具，不加载业务 .env；验证注册、退出换号、资源正文编辑、归档恢复、收藏、原导航、禁用操作和失败/乱序响应。
检查了 1440x960 与 390x844 页面，截图保存在 output/platform-qa。数据库持久化和 RLS 结论来自 PostgreSQL 集成测试，不来自浏览器内存夹具。

## 仍未完成的范围

没有接入真实 Agent 执行和每个 Agent 的容器资源隔离，没有实现正式计费、常驻 Swarm 部署、邮件验证或密码找回。
本机双副本与模拟任务通过，不代表多主机高可用、真实模型吞吐或公网生产就绪。
下一批工作需要单独确定目标和验收项，不能把本批能力开关视为整个平台已交付。

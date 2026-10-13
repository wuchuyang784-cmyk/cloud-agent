# F1：固定源码 pi Runtime

本批不依赖 Linux 服务器规格，交付独立运行协议和镜像构建链。用户 Agent 创建/执行仍关闭，不将 F1 自动加入业务 API、dev、Controller 或 E2 的 probe。

## 1. 来源与构建

可执行代码来自 `upstreams/pi` 的固定 Git 提交 `11f99114506ad2cc759cb389663edaf7546cbe8c`，coding-agent 为 1.1.0，锁文件 SHA-256 为 `7b597edc7527a36d9fba52f7e0fc9732447065fd96e4e6abc976cdcd14676b6b`。构建前后检查 Git HEAD、索引/gitlink、版本、锁文件和工作树；脏目录或变更的 pin 被拒绝，不更新子模块。

基础 Node 镜像固定 digest。构建脚本只将已提交源码 archive、wrapper、固定构建定义及模型目录数据放入随机临时目录；不将平台 `.env`、数据库、输出目录或 Git 私有配置作为构建上下文。只允许本机 Docker endpoint。

上游没有在 Git 中提交编译必需的 provider JSON。构建仅提取 `@earendil-works/pi-ai@1.1.0` 发布包里的 43 个目录 JSON（含 manifest），不运行/安装其中 JS，固定 SHA-512 并逐文件校验 SHA-256。模型目录数据独立固定到 npm 发布包，不将其冒充主源码 Git archive 内容。上游 `check:model-data` 继续执行，不跳过检查，不每次联网生成变化中的目录。

显式执行 `npm ci --ignore-scripts`、上游 `build:offline` 与生产依赖清理；旧 npm 全局安装镜像不作为 F1 产物。镜像默认 UID/GID 1000，工作空间 `/workspace`、状态 `/agent-state`，独立入口 `/app/pi/production/index.mjs`。

```powershell
conda run -n cloud --no-capture-output npm run pi:source:check
conda run -n cloud --no-capture-output npm run pi:build
conda run -n cloud --no-capture-output npm run test:pi
conda run -n cloud --no-capture-output npm run test:pi:live
```

输出位于已忽略的 `output/pi-runtime/builds/` 与 `acceptance/`。构建报告含 archive、锁文件、模型目录、Dockerfile、wrapper 哈希及实际 image ID；不覆盖 legacy、业务或预发镜像。源码配方 pin 不等于逐字节可复现的系统包镜像，Debian 安装源仍会更新；后续部署必须使用验收的实际 image ID/digest，不依赖可变 tag。本批只验收 linux/amd64，未验收 arm64。

## 2. 可信配置与运行身份

CLI 只读取显式 `/run/config/pi.json`，不读取业务 `.env`。机器配置精确字段：

- `agentId`、`runId`（现有 ledger 的完整 `run-UUID` 或独立验收 UUID）、正整数 `runGeneration`、平台 `sessionId`（UUID）。前缀不剥离，两种 runId 不作为别名。
- 固定 `provider=bairui-gateway`、模型 ID、HTTPS `gatewayUrl`。
- `gatewayTokenFile`、`hmacSecretFile`：不同的 `/run/secrets/` 普通文件；请求 Secret 为随机 64 位十六进制。
- `listenHost`、`listenPort`；可选 `gatewayCaFile=/run/config/gateway-ca.pem` 和有上限的 `limits`。

配置不接受任意 executable、argv、env、workspace/session 路径或任务指定的模型端点；测试的进程/路径/HTTP fixture 注入只存在于程序化工厂，不进入 CLI 配置。HTTPS fixture 使用临时 CA，不关闭 TLS 验证。

模型 token 应是未来 F2 签发的运行范围短期 token，而非原始用户 API Key。F1 没有凭据保险库、签发/撤销服务、Key 过期刷新、Provider 接入或计费；验收 token 只是随机测试值。

## 3. 就绪、任务和会话

`GET /livez` 只证明 wrapper 存活，`GET /readyz` 初始化成功才返回 200。初始化通过匹配 request ID 的真实 `get_state` 检查模型、会话文件、pi 内部 UUID 和空闲状态，然后关闭自动重试与压缩；进程退出、协议错误或未确认取消会使就绪永久降为 503，需外部显式重建/重启，不自动重放。

一个 wrapper/run 固定一个平台会话 UUID 和文件 `/agent-state/sessions/<sessionId>.jsonl`。pi 内部 session UUID 由上游生成，可以不同于平台 UUID；绑定文件路径并检查内部 UUID，而非伪造 pi header。连续 prompt 保持历史，重启恢复同一文件；非法/future session 被拒绝并保留，不悄悄重建。多会话切换不在 F1。

内部协议为：

| 方法和路径 | 正文 | 结果 |
| --- | --- | --- |
| `POST /v1/tasks` | `agentId,runId,runGeneration,sessionId,taskId,prompt` | NDJSON |
| `POST /v1/tasks/<taskId>/cancel` | 相同身份和 `taskId`，无 prompt | 取消意图，不是完成确认 |

身份都绑定当前配置，`taskId` 为 UUID。HMAC-SHA256 绑定协议版本、方法、原始 path、时间戳、nonce、运行身份及精确正文；签名 helper 在 `production/envelope.mjs`。请求头为 `x-pi-timestamp`、`x-pi-nonce`、`x-pi-signature`。签名凭据只供将来的 Runtime Gateway 使用，不能交给浏览器。健康响应不返回身份、路径或模型对象。

单实例同时只接受一个任务，忙时 409，无排队。prompt 前以 exclusive 文件占位并持久化，重复 task UUID（含进程重启后的 unknown）拒绝再次执行；响应丢失后的客户端不能换 UUID 自动重试。Linux 同步文件和目录；未验收整机掉电、存储损坏、跨节点 HA 或恶意工具篡改 state 的恢复保证。

事件类型为 `task.started`、`message.delta`、`tool.started/update/completed`、`task.completed/failed/cancelled`；带 taskId 和递增序号。工具事件只给受限元数据/结果状态，不给参数、stdout、工具错误正文或内部 details。模型文本属于本人对话内容，不能把输出投影当成任意机密识别器。

usage 来自本任务 pi 的 assistant 结束事件，工具多轮分别累计。缺失、非法或全零占位报告 null；不以字符数估算、不把费用目录当实际收费、不用该值结算，F2 网关才是后续权威计量来源。

## 4. 有界执行

默认正文 64 KiB、prompt 32 KiB、RPC 单行 256 KiB、每任务原始 RPC 累计 4 MiB、单个对外事件 64 KiB、任务事件数 10,000、输出 2 MiB、客户端缓冲 128 KiB；读取、RPC、任务和取消各有有限时限。限制只能在既定上限内调整，未知字段拒绝。

取消、超时和 HTTP 断开先请求 abort，确认 settled 后才释放任务位；未确认则杀死 pi 并保持不可就绪。错误只返回固定分类，不输出 pi stderr 或 Provider 原始错误。RPC abort **不是** 已回收工具进程或容器的证明，特别是脱离进程组的 shell；F3 必须验证容器生命周期和内核隔离。

## 5. 验收方式和边界

`test:pi` 用独立 subprocess 验证协议、磁盘状态和真实 HTTP 行为，不读业务配置。`test:pi:live` 运行构建出的真实 pi，模型服务为独立 HTTPS/OpenAI SSE fixture：工具调用由 fixture 固定响应，但 read/write/bash 和会话机制是原版 pi 实际执行。它不是付费模型质量测试。

Runtime 只加入新建 internal 网络，无宿主端口。可信 fixture 另接临时 ingress bridge，在回环发布测试端口并代理固定 Runtime 地址，兼容 Docker 29 internal 网络不发布端口的行为。两卷、两网络、容器和凭据都有随机归属；清理前逐个检查完整 ID/label，创建响应丢失时按本次随机标签恢复目标，不碰已有业务/预发资源。

F1 未提供安全的多租户用户上线：pi、wrapper 和状态文件仍同 UID，工具可能访问自身状态和控制 token；生产必须先完成 F3 的控制 Secret/可信配置与工具空间隔离，不能仅靠 Docker 参数宣布沙箱完成。真实 Provider、账号→容器授权、配额准入、跨用户拒绝、Linux/gVisor、出口策略、磁盘配额、资源挂载和页面留待后续。

## 6. 首次结果（2026-10-11）

- `test:pi`：48 项通过，0 失败、0 跳过；涵盖构建来源、协议、持久状态、取消竞争、输出限制、慢客户端和夹具。测试启动使用条件等待，不用延时后初始 503 冒充握手拒绝；生产 RPC 超时未放宽。
- 慢客户端回归曾由 Windows 测试观察器反复打开目标文件触发原子 `rename` 的 `EPERM`；实际 wrapper 返回 `persistence_failed`、关闭就绪并保留 unknown，占位未误写成功。观察器改为先检查文件元数据再读取替换结果，仍在客户端暂停时断言终态已持久化，保留 800 毫秒任务、200 毫秒取消和 5 秒观察期限；不通过修改生产代码或放宽期限消除失败。
- 后端正常 `npm test --prefix apps/platform-api`：335 项，326 通过、9 个数据库专项跳过、0 失败。原 pi wrapper 与平台模式入口保护亦通过，不以专项跳过表示数据库验收完成。
- 独立规格审查与代码质量审查完成；修复占位期间取消仍派发、未来时间戳 nonce 提前失效、工具输出泄露、工作目录指令自动加载和原始 RPC 累计无限增长，并添加对应回归。兼容既有完整 `run-UUID`，不改变运行身份。
- 实际 linux/amd64 镜像：`bairui/pi-runtime-f1:a9fbc2fa0e66252fcb35`；image ID `sha256:087e4b6e39274b69938047a64bfb965c78e196202b51ef12ae4b9107f452bd6d`。构建证据：`output/pi-runtime/builds/a9fbc2fa0e66252fcb35.json`。
- 最新真实容器验收：`output/pi-runtime/acceptance/2026-10-11T15-01-34-473Z.json`，16 项检查均为 true。包括真实 pi 就绪、read/write/bash 与多轮 usage、工作目录指令不自动加载、直接 RPC 404、会话重启恢复、任务重放拒绝、取消与超时、错误脱敏且不重试、缺失 usage 不补值、完整签名身份、实际容器参数及 RPC 超限失败后不可就绪。
- 测试资源全部按本次归属回收；已有容器 ID、名称、状态和 StartedAt 保持不变。上游 HEAD/gitlink/锁文件和工作树再次核对；原预发 CA、两环境 Controller 与编排器私有配置共五个文件 SHA-256 未变。F1 不读取业务数据库，未另行查询或声称重新验收业务行数。

本批没有迁移业务库、更新常驻预发、访问 Linux 服务器、开放用户执行、提交或推送。实现遵循独立开发、测试先行和审查后验收流程；工作保留在当前分支，既有 Grafana 修改不被覆盖。

下一批 F2：用户凭据保险库与模型网关；继续复用 Better Auth/Principal/RLS 绑定本人凭据，并签发只适用于确定 Agent/run 的短期网关 token，原始 API Key 不交给 pi 容器。

## 7. 1.1.0 复验结果（2026-10-13）

- `upstreams/pi` 已在工作树和 staged gitlink 中核对为 `11f99114506ad2cc759cb389663edaf7546cbe8c`，coding-agent 为 1.1.0，锁文件 SHA-256 为 `7b597edc7527a36d9fba52f7e0fc9732447065fd96e4e6abc976cdcd14676b6b`；同版本 pi-ai 模型目录为 43 个 JSON，未带入 JS。
- `test:pi`：53 项通过、0 失败、0 跳过；覆盖 1.1.0 的 `started/queued/handled` prompt disposition、未知 disposition fail-closed、usage/context_edit session 条目、固定 CLI argv，以及既有 HMAC、会话、取消、超时、流式输出和边界测试。`npm run pi:source:check` 通过。
- 最终 `npm run pi:build` 使用普通容器网络构建成功，未使用 `network.host`；镜像为 `bairui/pi-runtime-f1:611ce4ff34317c36d8ef`，image ID 为 `sha256:e696b993afc8ccecea5e8236e8139e45f485175bec078db7bfb61ac74504a903`，报告为 `output/pi-runtime/builds/611ce4ff34317c36d8ef.json`。
- `npm run test:pi:live` 使用该最终镜像完成 16/16 检查：真实 pi RPC 就绪、read/write/bash 工具、流式与多轮 usage、持久会话重启恢复、取消/执行超时、Provider 错误脱敏且不重试、RPC 溢出 fail-closed、非 root/只读策略和临时资源清理均通过。报告为 `output/pi-runtime/acceptance/2026-10-13T02-03-27-348Z.json`。
- 本次没有迁移业务库、更新常驻预发、启动用户 Agent 或推送镜像；仍未验收 arm64、真实付费 Provider、F3 级进程树/网络/控制 Secret 隔离和生产部署。

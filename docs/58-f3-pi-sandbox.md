# F3：pi-agent 独立沙箱接入

日期：2026-10-20（Asia/Shanghai）。F3-A 协议底座已实现并完成本机组件验证，未部署；不是用户 Agent 已上线，也不是原生 Linux/runsc 的 F3-B 验收报告。

## 1. 部署模型

用户电脑只运行浏览器。服务器使用固定源码构建、验收并按实际 digest 固定的 pi 镜像。Agent 的身份与持久数据长期存在，容器只属于一次运行代次；停止或休眠后保留文件与对话，下一次启动创建新的 run/generation。

每个 Agent 对应一个独立运行单元：

- 可信控制容器：签名准入、任务去重、可信运行记录、固定模型中转；不执行用户工具、不挂载用户文件。
- pi 执行沙箱：pi 与 bash/read/write 工具，独立工作文件和会话；目标为 runsc、network=none，不持有控制 Secret、网关真实令牌或 Provider Key。

二者使用本 run 专属的 RPC/model Unix socket 通道。socket 目录只读挂载到 pi，可信控制侧监听；跨 Agent 不共享通道。pi 内部 loopback relay 及其工具均是不可信工作负载，不作为授权边界。

首批不开放工具直接联网。因此 git clone、curl、联网安装包和外部 MCP 尚不支持；模型调用只能经过固定中转与 F2。扩展工具出口要另行做按 Agent 授权，不能改成共享 bridge 全放通。

## 2. 模块边界

代码独立位于 `apps/platform-api/src/runtime/pi/sandbox/`，不替换现有 `production/` 默认实现，不放宽 E2 probe 驱动，也不加入 dev、业务 API 或常驻预发启动链。

### 2.1 Profile 与策略描述

`validateSandboxProfile(value)` 仅接收可信机器配置。严格根字段：

```text
schemaVersion=1, installationId,
identity={organizationId,ownerUserId,agentId,runId,runGeneration,sessionId},
sandboxImage, controlImage, runtime=runsc,
storageRoot, gatewayUrl, model,
resources={cpuMillis,memoryBytes,pidsLimit,tmpfsBytes,workspaceBytes,workspaceInodes}
```

镜像必须是完整 sha256 ID；身份使用固定语法，run- 前缀不剥离，不做大小写归一化。模型兼容 F2 的目录 ID；未知字段、控制字符、getter/Proxy、可变镜像标签、任意 env/命令/网络/挂载都拒绝。

`gatewayUrl` 与模型中转采用同一固定契约：只允许 HTTPS `/v1`、`/v1/`、`/v1/chat/completions` 三种路径写法；根 URL、任意路径、userinfo、百分号编码、query/hash 均拒绝。策略检查通过的网关字段必须可直接用于固定模型中转，不能各模块自行解释。

`compileSandboxPolicy(profile)` 返回不可变纯数据：

- 由安装/组织/用户/Agent 散列得到稳定持久路径，run/generation/session 再派生临时通道和 Secret 路径。
- sandbox 只获得自己的 workspace、sessions 和只读 channel，没有 `/run/secrets`、宿主 socket 或公开端口。
- control 只获得自己的 control-state、channel、只读 secrets，不获得 workspace/sessions。
- 双方均非 root、只读根、cap-drop ALL、no-new-privileges、有界 CPU/内存/PID/tmpfs/文件描述符，禁额外 swap。
- 工作目录和会话目录分别要求块/inode 硬配额。普通 local volume 不构成硬配额。
- 可信控制固定 250m CPU、128 MiB 内存、32 PID、8 MiB tmpfs；这些只是策略，不是已实测的生产容量承诺。

`trusted-gateway-only` 是待宿主驱动执行的抽象网络要求，不是 Docker 可直接使用的 NetworkMode。编译成功不表示镜像已存在、挂载归属正确、runsc 已安装、出口规则已生效或存储配额已验证。

### 2.2 可信状态库

`openSandboxState({directory, identity})` 只使用显式、受保护的可信状态目录，不访问业务数据库或工作目录。提供：

| 方法 | 语义 |
| --- | --- |
| `reserve({taskId,sessionId})` | exclusive 任务 UUID，先持久 unknown 再返回；跨进程重启/run 去重 |
| `finish(taskId,status)` | 只更新当前 run 的已有任务；终态 completed/failed/cancelled/unknown 不可覆盖 |
| `beginStop()` | 先持久 stopping，拒绝之后的 reserve |
| `confirmStopped(proof)` | 校验当前 run/generation 及两个明确的缺席断言；不自己查询 Docker |
| `snapshot()` | 只读副本，是账本快照，不是实时容器健康证明 |
| `close()` | 等待已排队写入，只释放本实例锁；可重复调用 |

账本绑定组织/用户/Agent，新 run 只允许在前 run 已确认 stopped 且 generation 增加时创建，历史 run 不复活。文件最大 4 MiB，最多 4096 任务、256 run，满后拒绝新增但不丢弃历史，现有任务终态和停止仍可提交。

单写者文件锁保护目录。持久化使用独占临时文件、文件 fsync、原子 rename、Linux 目录 fsync；失败后写者失效，不能报告假完成。目录/文件符号链接、身份漂移、账本损坏、宽松 POSIX 权限等拒绝。

Linux 首次创建可信目录时，还会在取得 writer lock 和生成账本前同步父目录项，并复核父子目录 canonical 路径与 inode；父同步失败则拒绝打开。已有目录不执行此初始化分支。单独同步新目录自身并不足以持久化它在父目录中的条目，依据见 [Linux fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html)。相关测试观察真实 fsync 调用并注入失败，不是宿主掉电验收。

只有本次真正创建的新目录可以初始化账本。已有目录丢失账本时拒绝，不能自动生成空历史。并发首开时非创建者在抢锁前核查既有账本，防止双方失败留下空目录。

崩溃遗留 writer.lock 不自动删除或接管；需要独立运维恢复，并先核对原进程、运行资产和停止围栏。本库不提供跨节点锁、分布式租约或自动崩溃恢复承诺。

`confirmStopped` 接收的是可信驱动断言，不是沙箱自行上报的证明。F3-B 的外部驱动必须先验证完整容器 ID/归属、确认沙箱与控制容器均已停止并回收，再提交断言；不能让沙箱或浏览器调用这个接口。没有确认不能归还 F4 容量占位。

### 2.3 RPC 通道

`new SandboxRpcChannel(stream, limits)` 使用已连接的 Duplex，不启动 pi、不接触 Docker、文件或 Secret。只接受五种请求：

```text
get_state {}
set_auto_retry {enabled:false}
set_auto_compaction {enabled:false}
prompt {message}
abort {}
```

单个 prompt 领取任务围栏，只能由可信消费者在后续清理核查后 `endTask()` 解除。沙箱的 agent_settled 不自动解锁；abort 永久设置 requiresRecycle，不能继续 prompt。close 仅销毁流，不代表容器已回收。

默认及最大可配置值：RPC 截止 10 秒、8 pending、256 KiB 单行、4 MiB 原始流、10000 事件、256 KiB 写缓冲；配置只能降低，prompt 最大 32 KiB。正常任务结束后由可信消费者重置计数，空闲事件同样累计有界。

内部生成请求 UUID，响应必须匹配 ID/command。严格 UTF-8、固定事件列表、命令方向、迟到/重复响应、缓冲、EOF/error/timeout 均受控；失败永久关闭且清理 pending。对端提前响应也必须等待完整写入完成，不能借提前确认取消写入截止。

RPC 返回与事件是未经可信验证的工作负载输出。通道通过不表示 pi 模型/会话已就绪，不证明任务结果、工具退出、Token 或费用。真实就绪检查、事件投影和进程树核查仍需运行单元集成。

### 2.4 固定模型中转

`createSandboxModelProxy({gatewayUrl,model,token,ca?,limits?})` 返回尚未监听的 HTTP server 和幂等 `close()`。部署驱动只能把它绑定本 run 的受保护 UDS；测试使用显式回环端口，不提供浏览器或公网入口。

只允许 `POST /v1/chat/completions`。固定 HTTPS F2 目标、绑定模型及随机运行令牌由可信控制侧持有；拒绝 Origin/Cookie，不转发沙箱传入的 Authorization、上游错误正文或任意响应头。不读取环境代理、不跟随重定向、不自动重试；默认校验 TLS，支持显式 CA。严格数据配置拒绝未知字段、getter/Proxy 和空 userinfo 写法。

复用 F2 请求校验与 SSE 流校验，单并发包含读请求体阶段；正文最多 64 KiB、单事件 256 KiB、输出 4 MiB、总时限 120 秒、请求体 10 秒，参数只能降低。已知运行令牌完整字面值跨片段脱敏；关闭/下游断开/输出背压都会中断上游并回收本实例连接。

F2 在释放终止帧前负责回执持久化，中转本身不新增用量回执、估算费用或扣款。该模块不能单独证明令牌签发正确、真实 pi 已接通或原生网络隔离已生效。

### 2.5 显式只读检查

开发命令均在 Conda `cloud` 环境中执行。机器配置由可信调用者准备，不是浏览器用户提交的部署参数，也不应含 token/Key 等额外字段。

```powershell
conda activate cloud
npm run pi:sandbox:check -- --config <机器配置JSON路径>
npm run test:pi:sandbox
```

检查命令只接受 `--config <file>`，不读取 `.env` 或环境中的配置回退，不支持 `--up`/部署。JSON 文件最多 16 KiB、严格 UTF-8、普通文件且路径不能经过符号链接；POSIX 上必须归当前用户所有并禁组/其他用户访问。Windows 验证文件身份和链接，不冒充 POSIX 权限验收。

输出只含散列名称和脱敏的策略摘要，不打印 profile/policy 原文、用户身份、目录、上游地址或密钥。成功输出仍明确：

```json
{
  "mode": "policy-only",
  "deploymentReady": false,
  "nativeChecksPerformed": false
}
```

`requiredNativeChecks` 列出 runsc、镜像、配额、归属、出口、进程回收和容量等后续门禁。CLI 不执行任何一项原生检查，也不创建目录、容器、数据库或监听端口。失败只给固定错误和非零退出码。

## 3. 当前验证与证据口径

本轮已经执行：

- `npm run test:pi:sandbox` 汇总 138 项：134 通过、4 项 Linux/POSIX 分支在 Windows 明确跳过、0 失败；相应分支另用 Linux 临时组件容器实跑通过。
- F1 `pi:source:check` 通过，`test:pi` 53 项通过。
- F2 普通专项 58 通过、2 真库专项跳过；独立真库入口另跑 5 项通过/0 跳过（两项实际 PG 集成、三项 adapter 单测），临时库已清理。
- 平台能力 guard 5 项通过，执行入口仍关闭。
- F3-A profile/policy 19 项通过，独立规格与质量复核通过；包括真实 profile→policy→模型中转 factory 的固定 URL 契约回归。
- F3-A state Windows 25 通过、3 Linux/POSIX 项明确跳过；固定缓存 Node 的 Linux 临时组件容器实际 28 项全通过。初始化并发竞态和新目录父同步缺口已用 RED→修复覆盖。
- F3-A RPC Windows 与 Linux 临时组件容器各 49 项通过，独立规格与质量复核通过；均为真实 Duplex 流协议测试，不是原版 pi 容器执行报告。测试夹具显式固定 highWaterMark，不依赖不同平台的默认缓冲大小。
- F3-A 模型中转 29 项通过，使用真实 HTTP→HTTPS/SSE 测试服务，无真实用户 Key 或付费调用。
- 只读检查 CLI Windows 12 通过、1 POSIX 权限项跳过；Linux 临时组件容器 13 项全通过，实际验证私有文件权限分支。
- 后端完整回归 601 通过、19 明确跳过、0 失败；跳过项不能充当对应真实数据库/原生环境验收。

五个任务均完成独立规格与质量复核。整批最终复核发现的两处 P2（profile/代理 URL 契约不一致、新状态目录缺少父同步）已补真实 RED 回归并修复，最终复验 PASS。已有 M1 的 12 个修改文件逐一 SHA-256 比对未变；本轮临时组件容器按归属清理完成。

Linux state/RPC 组件测试每次只挂载相应源码和测试两个文件；CLI 测试只读挂载两个脚本及四个依赖源码。均使用 nonroot/read-only/network=none/cap-drop ALL、临时 tmpfs，没有挂载仓库、业务 `.env`、Secret 或 Docker socket。它补验文件权限与跨平台流行为，但 Docker Desktop 中的 Linux 容器不等于原生 Linux/runsc 沙箱验收。

## 4. 仍未完成的接入

- 本轮 `pi:build` 仍在 Docker Hub frontend token 连接处失败；没有当前真实 pi 容器→F2 模型网关的新联调报告，不拿历史镜像或人工工具消息冒充。
- 本机没有 runsc；没有自动安装/注册、修改 Docker daemon 或重启已有服务。
- F3-B 需实现并实跑真实 pi connector/loopback relay、受保护 UDS、独立运行单元创建/回收、完整进程树/后台工具核查、quota 与网络对抗、崩溃/结果丢失恢复。
- F4 才对接可信授权签发/续期、全局容量、账号治理、真实创建/启停/休眠、状态回流与路由。
- F5 才开放本人模板/Key/部署/对话 UI。费用与每用户计量也不是本批已交付能力。

本批不部署云服务器、不迁移业务库、不启动用户已停止的常驻本机服务，不提交/推送代码。下一步环境准备必须显式执行，不由 profile 校验或 npm dev 隐式触发。

详细设计见 [F3 设计](superpowers/specs/2026-10-20-f3-pi-sandbox-design.md)，实施清单见 [F3-A 计划](superpowers/plans/2026-10-20-f3a-pi-sandbox.md)。

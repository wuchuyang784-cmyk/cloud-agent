# F3：独立 pi-agent 沙箱与可信控制边界

日期：2026-10-20（Asia/Shanghai）。状态：用户已确认“按详细设计继续 F3-A”；协议底座已实现并完成本机组件验证及独立复核。用户已认可云端独立部署、计算回收与持久数据分离，以及本文件的双容器拓扑与首批网络限制；真实 pi→F2 联调和 F3-B 原生隔离仍未验收，未部署。

## 1. 产品目标与交付边界

用户不需要在自己的电脑运行 pi。平台在服务器使用验收过的固定镜像，为每个 Agent 提供独立进程、文件、会话、模型访问授权与计算额度。同一用户的两个 Agent 也不共享可写数据、进程或运行令牌。

Agent 是长期身份，run 是一次可回收的执行代次；停止或休眠保留 Agent 身份和持久文件，重新启动使用新 run/generation。释放的是计算资源，不把原用户的数据或容器转让给其他用户。

F3 交付隔离底座与独立验收，不交付完整用户部署业务。F4 接可信签发/续期、全局容量准入、Controller/编排器和真实生命周期，F5 才开放模板、Key、创建部署与对话页面。F3 不改默认平台能力、不把 pi 替换进既有 probe、不操作业务库或常驻服务。

## 2. 代码现状与本轮前置证据

- F1 固定 `upstreams/pi` 1.1.0/`11f99114506ad2cc759cb389663edaf7546cbe8c`，固定锁与构建来源；本轮源码检查和 `test:pi` 53 项通过。
- F1 `production/rpc.mjs` 在 wrapper 内直接启动 pi，二者同 UID；`prepareRuntime` 将模型授权写入同 UID 可访问的配置目录。工作空间工具可能读取控制 Secret、修改任务状态，不能直接用于用户沙箱。
- F2 已有本人凭据保险库、独立网关、受限函数和 run 范围授权；`issueRuntimeGrant` 尚未接真实用户生命周期。原始 Provider Key 不能交给 pi 或控制容器。
- E2/E3 的驱动仍固定 `isolation-probe-v1` 且禁止挂载，没有持久用户数据；不能放宽原驱动的约束来隐式升级既有常驻安装。
- 本机 Docker Desktop/cgroup v2，runtime 列表无 runsc。2026-10-20 重跑 `pi:build` 仍在 Docker Hub frontend 匿名 token 连接处失败，尚未产生当前镜像；不能用历史镜像代替当前 pi→F2 联调。

## 3. 方案比较与选择

| 方案 | 取舍 | 决策 |
| --- | --- | --- |
| 一个容器，同 UID 运行 pi 与 wrapper | 改动最小，但工具可访问控制资产，不能满足 F1 留下的边界要求 | 不采用 |
| 每个 Agent 一个可信控制容器 + 一个 pi 沙箱 | 单独保护控制 Secret、去重状态与模型令牌，故障和归属易于按 Agent 核查；增加每 Agent 常驻开销 | 推荐 |
| 独立虚拟机/microVM 承载每个 Agent | 可选择不同的隔离边界，但引入虚拟化、镜像与存储运维；不作为当前单机首批实现 | 后续独立评估，不混入本批 |

运行单元的“独立”不等于必须恰好一个容器。两个容器共同属于同一个 Agent/run，不服务其他 Agent。F4 容量账本必须包含两者与运行时开销，不能只统计 pi 的 memory limit。

## 4. 运行拓扑与信任边界

```text
平台 Runtime Gateway（后续 F4，持有请求签名身份）
  → 每 Agent 可信控制容器（签名校验、任务占位、受限模型代理）
      ↔ 本 run 专用 Unix socket 通道 ↔ pi 执行沙箱（runsc、network=none）
      → HTTPS → F2 模型网关 → 固定 Provider
```

### 4.1 可信控制容器

- 不执行用户工具、不加载工作空间代码/扩展/Skill，不挂载用户工作目录和 pi 会话卷。
- 单独持有本 run HMAC、短期模型令牌、固定模型/F2 地址、受信 CA；不持有 Provider Key、数据库密码、issuer 凭据或 Docker socket。
- 独立可信状态卷保存 task UUID 去重、终态、运行身份与通道状态。该卷不挂载到 pi 沙箱。
- 固定非 root 用户、只读根、无 capabilities/提权、独立 CPU/内存/PID/tmpfs 限制。控制端口不发布到宿主公网。
- 仅固定请求 DTO 可以进入任务通道；沙箱上报的 RPC 不能触发新建 run、签发授权、修改资源、选择上游或操作其他 Agent。
- 模型代理是固定 `/v1/chat/completions` 的应用代理，不是 CONNECT、任意 HTTP 或任意文件访问服务。它删除沙箱 Authorization/转发头，使用自己持有的 run token；绑定模型且执行有界正文/流/并发/截止限制，F2 继续作最终授权与额度判断。

### 4.2 pi 执行沙箱

- 固定源码与镜像 digest，单独 runsc 沙箱，不与其他 Agent 共享进程/PID、IPC、网络或可写挂载。
- `network=none`，无外部网卡、DNS 出口、宿主网络、设备、Docker socket或宿主敏感目录；不能通过环境代理或修改 URL 绕过网络边界。
- pi 和它的 bash/read/write 等工具均为不可信工作负载。它们只能写自己的工作目录、pi 会话目录和有界临时目录。
- 沙箱内受限 relay 在固定 loopback 地址提供无真实凭据的模型协议，并把请求送到本 run 的专用模型 socket。此处仅容器 loopback 可以使用 HTTP；控制容器到 F2 必须 HTTPS，不放宽现有 F1/F2 的生产 URL 校验。
- loopback relay/connector 可以被同 UID 工具访问或干扰，所以不作为可信授权边界。真实 token、上游地址选择、任务占位和可信控制不依赖它们保密或不可篡改。
- 模型中转是本 run 能力：同一沙箱工具直接发起合法模型请求仍受本 run 额度约束，不承诺区分“pi 正常调用”与“同 run 工具伪造调用”。不得获得其他 run 能力。

### 4.3 Unix socket 通道

- 每 run 一个全新通道目录，只含 `rpc.sock` 和 `model.sock`；控制容器创建/监听，沙箱只读挂载该目录，不能创建/替换/删除端点。目录不是可信状态卷。
- 接受端点就是固定的 Agent/run 归属，不相信客户端正文提供的 owner、agentId 或 runId。不会共享一个允许客户端选择身份的总 socket。
- RPC socket 接收沙箱连接后双向传输固定的有界 RPC 行；请求 ID、帧种类、缓冲、并发连接、断开与超时均有严格状态机。沙箱方向只能上报响应/事件，不能进入平台任务提交入口。
- 生产专用 runsc profile 仅允许连接挂载的既有 host UDS（`host-uds=open` 语义），不开放创建任意 host socket、host 网络或额外挂载。profile 的注册名、版本、二进制 digest 与设置必须进入主机能力核查和实际连接验收。
- gVisor UDS、只读挂载、用户/GID 权限与 reconnect 行为需要原生 Linux 实测；未证明前 F3-B 不通过，不回退同网络裸 TCP 或默认 runc 冒充通过。

首批不支持 pi 工具任意联网。因此 `git clone`、`curl`、联网安装包和外部 MCP 暂不开放。需要这些能力时另做按 Agent 授权的出口代理与审批，不在 F3 默认放通。

## 5. 身份、数据与控制契约

身份由可信调用者传入并固化：`installationId / organizationId / ownerUserId / agentId / runId / runGeneration / sessionId / profileRevision`。用户正文不能覆盖 owner、镜像、命令、环境、路径或资源挂载。

F3-A 的机器配置按实施计划固定 `schemaVersion:1`，不接受额外 `profileRevision` 字段；上文的运行 profile 修订属于完整 F3-B 驱动归属契约，需在实际驱动接入时显式定义，不能由调用方自行附加或声称已校验主机 profile。

资源名称由安装身份与 Agent/run 标识散列生成；标签和持久 ledger 保存精确归属、完整容器 ID、卷/目录标识与 profile。名称不是授权依据，不能据名称前缀接管其他资源。

| 数据 | 归属与可见性 | 生命周期 |
| --- | --- | --- |
| 用户工作文件、pi 会话 | 按安装/本人/Agent 固定；只挂载给该 Agent 沙箱 | 运行停止后保留 |
| 可信 task UUID 占位与终态 | 按安装/Agent 固定；仅可信控制可写 | 跨 run 保留去重信息；F4 对接平台任务身份 |
| HMAC、模型 token、可信配置 | 按 run 固定；只进入控制容器 | run 终止后撤销/回收，不恢复旧代次 |
| socket、relay 临时目录 | 按 run 固定，不能跨 Agent 共用 | 确认停止后回收 |

持久卷已有记录但实际缺失/归属不符时拒绝启动，不创建同名空卷掩盖数据丢失。工作区内的符号链接、绝对路径或自建配置不能扩大挂载可见范围。

pi 会话与工具输出是用户工作负载数据，不是可信审计、计费或任务成功证明。沙箱能修改自己的文件；F3 不承诺会话不可篡改，损坏时拒绝恢复并保留原始数据，不静默清空。可信任务去重不能依赖会话中的记录。

内部控制入口保留 F1 的签名身份和有界 NDJSON 语义；新的沙箱模块独立实现/复用纯 helper，不替换 `production/` 默认进程模型，不改变旧 HTTP URL/配置契约。任务完成仅代表协议终态，不代表任意工具输出已被平台验证。

## 6. 存储和资源限制

- CPU 硬限制、内存硬限制（禁额外 swap）、PID 限制、文件描述符限制、只读根、有界 tmpfs。磁盘日志禁用或限额，不能任由工具 stdout 进入无限宿主日志。
- 正式持久工作区必须由受限存储后端提供块与 inode 硬配额；主机预检验证实际文件系统/挂载/配额和超限失败。普通 Docker local volume + 应用层定期统计不能当硬配额。
- 不在本轮自动改云服务器分区、fstab、quota 挂载或 Docker data-root。目标主机没有合格后端时 managed 准入拒绝，先由后续部署步骤准备存储后端；不静默以无限卷运行。
- 首批 F3-A 可用有界临时文件系统完成协议测试，但这不证明持久存储合格。F3-B 必须在显式准备的原生 Linux 限额工作区中完成块/inode 耗尽与恢复验收。
- 两个容器、gVisor 开销与持久存储均分别报告；具体规格与最大并发由实测决定，不根据服务器核数直接承诺可用 Agent 数。

## 7. 启停、取消与回收

F3 提供独立内部运行单元驱动，不接用户 API。创建前先在专用持久 ledger 写意图，随后分阶段记录可信控制、socket、工作区和沙箱的完整 ID/状态；创建响应丢失不能再次盲目创建。

启动顺序：核查主机/profile/存储与身份 → 建立可信控制与通道 → 启动沙箱 → 真实 pi RPC 就绪与模型配置匹配 → 控制端 ready。`livez` 不代表 pi/模型已就绪。任一步不确定不发布成功。

停止顺序：禁止新任务/模型请求 → 标记永久终止意图 → 请求当前任务终止 → 到期强制终止沙箱 → 确认本 run 沙箱/全部子进程及控制容器已停止并按归属删除 → 回收临时通道 → 签发 stopped/absent。持久用户数据和任务去重记录保留。

仅收到 RPC abort/settled 不能证明脱离进程组的工具已退出。首批保守策略是取消/超时/异常后终止整个沙箱并把该 run 置为不可就绪；恢复要新建 run。跨正常任务残留后台进程必须在 F3-B 检测并阻止后续任务准入，检测能力不成立则验收不通过，不能承诺已清理。

旧 run 一旦终止不复活。部分创建、删除失败、容器状态未知时保持 creating/stopping/unknown，后续按完整 ID 与标签协调；不能释放 F4 容量占位或写假 stopped。控制容器死掉时不自动重放任务，独立回收器仍须最终处理沙箱。

空闲休眠是 F4 的业务策略，不复用 E2“首次创建意图起算 TTL”冒充空闲计时。F3 不因关闭浏览器或退出登录删除容器，不实现 docker pause 休眠。休眠后恢复的是落盘上下文，不是旧 shell 进程。

## 8. 分批实施与验收

### F3-A：可移植协议与可信边界代码

独立目录建议 `apps/platform-api/src/runtime/pi/sandbox/` 与专项 `pi-sandbox-*.test.mjs`，新增显式验证入口，不加入 dev/preprod。按测试先行实现：严格配置/身份、资源策略生成、分离状态、socket RPC、固定模型中转、停止状态机与不可重放。没有 gVisor 的机器只能运行单元/协议 fixture，不能标记沙箱实跑通过。

真实 pi→F2 联调为前置验收：使用当前源码镜像、一次性受限 PostgreSQL、专用 fixture 身份与 HTTPS Provider；真实 pi 执行 read/write/bash，多轮模型调用经过 F2 真实请求占位/终态函数。不得用旧镜像或手工构造 tool 消息替代。Linux 网关私钥 mode/uid 分支一并实跑。当前构建网络失败单独记录，不阻止纯协议代码开发，但阻止该验收项通过。

### F3-B：原生 Linux/runsc/存储实机验收

显式环境配置，不自动安装或重启宿主服务。临时随机安装身份，只操作本轮资源；测试前后核对已有容器完整 ID/状态/StartedAt，异常清理按 ledger 与归属精确进行。

| 验收项 | 必须观察到的结果 |
| --- | --- |
| 同用户 A/B 与不同用户 A/C 并行 | 工作卷、会话、可信状态、socket、进程相互隔离；不能切换正文身份跨 Agent |
| 真实工具读取 Secret/控制状态 | 不存在对应挂载/进程可见性；真实 Key/token/HMAC 不出现在 sandbox env、配置、proc 或模型响应 |
| 网络尝试 | 直连其他 Agent、平台 API/DB/编排器、宿主/元数据、外网 IP/DNS/IPv6 均失败；固定模型通道成功 |
| socket 错误与攻击 | 只读目录不能替换端点；越界帧/重连/多个连接/错误 ID/背压失败受限，不能注入平台命令 |
| 配额实测 | CPU/PID/内存/tmpfs/块/inode 超限限制实际生效；B/C 继续健康且数据不变 |
| 取消/超时/后台工具 | 真实脱离进程组工具被回收，旧 run 不再 ready；无资源释放的假确认 |
| 故障注入 | 创建回执丢失、控制崩溃、沙箱 OOM、部分删除、重启/迟到请求不产生双实例或重放 |
| 数据恢复 | 旧 run 确认停止后新 run 挂载同一 Agent 文件/会话；其他 Agent 卷不变 |
| 清理 | 临时资源按归属全部回收，已有服务/配置/卷不变；需保留失败证据而不是清空历史 |

只有 F3-A 和 F3-B 的对应项实际通过，才能声称 F3 完成；Windows/Docker Desktop 与真实 Linux/runsc 报告分开。没有真实 Provider Key 的 fixture 验收不表示付费 Provider/公网生产质量验收。

## 9. 后续对接，不在 F3 偷跑

- F4：可信 issuer 的签发与短期授权刷新、账号治理回流、全局容量及存储配额账本、用户创建幂等、常驻/按需模式与空闲唤醒、真实 Runtime 路由、节点固定和故障恢复。不自动跨节点搬迁工作区。
- F5：本人模板/Key/规格页面、部署进度、本人任务/对话、启动/停止/休眠和独立数据删除确认；不暴露容器地址/机器凭据。
- 观测：后续把完整运行单元 CPU/内存、任务、Provider 最终 Token 按可信归属汇总；F3 不增加费用估算/扣款或声称 Grafana 已有每 Agent 计量。

## 10. 审阅重点与当前交付

推荐确认两个具体新增边界：每 Agent 两容器运行单元；首批只通模型网关，不开放工具任意联网。runsc 与存储后端缺失时不自动降级，原生 Linux 实机验收在明确准备的环境中执行。

用户已审阅并确认上述边界，F3-A 已按实施计划完成 TDD 与独立复核，验证结果见 [交付说明](../../58-f3-pi-sandbox.md)。F3-A 是协议与策略库，不是可供用户部署的运行单元；本设计文件不作为 F3-B 实机验收证据。不将提交/推送或部署作为隐式后续动作。

## 11. 官方依据

- [Docker/gVisor 接入](https://gvisor.dev/docs/user_guide/quick_start/docker/)：需显式安装注册 runsc，可能涉及 Docker daemon 重启，不能自动作用于现有服务。
- [gVisor 安全边界](https://gvisor.dev/docs/architecture_guide/security/)：沙箱不替代应用、网络和宿主资源控制，也不承诺绝对隔离。
- [gVisor 文件系统](https://gvisor.dev/docs/user_guide/filesystem/) 与 [runsc 配置源码](https://github.com/google/gvisor/blob/master/runsc/config/config.go)：核对 host UDS 连接策略；实施必须固定验收版本，不依赖浮动 master 作为生产 pin。
- [Docker bridge](https://docs.docker.com/engine/network/drivers/bridge/)：同桥默认互通，不能把 internal 当作逐 Agent 授权隔离。
- [Docker 资源约束](https://docs.docker.com/engine/containers/resource_constraints/)：容器硬限制不同于多实例容量预留，需另做 F4 准入。

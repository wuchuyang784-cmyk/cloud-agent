# E2：实际编排器与资源回收的隔离开发、验收

日期：2026-10-09。范围是单机 Docker Engine + 独立 PostgreSQL 的真实容器编排，不是模型或用户 Agent 上线。业务 `bairui`、常驻预发、业务迁移、平台能力开关均不在本次变更范围。

## 1. 交付结构

`apps/platform-api/src/runtime/orchestrator/` 是独立服务代码，复用现有 pg 依赖及 E1 协议模块；没有导入平台 app/dev 启动链路，平台 API 不获得 Docker 访问权限。

| 模块 | 职责 |
| --- | --- |
| `config.mjs` / `index.mjs` | 显式 isolation 模式、独立数据库、TLS 回环监听、周期 reaper、关闭流程 |
| `http.mjs` | 固定 E1 路由、严格 DTO、签名响应、正文/连接/并发限制 |
| `ledger.mjs` / `schema.sql` | 持久运行意图、完整容器 ID、永久终止标记、原子 nonce；Memory 仅用于单元测试 |
| `service.mjs` | 幂等启动、停止确认、未知结果恢复、TTL 与异常退出回收 |
| `docker.mjs` | 无 shell 的固定 Docker 命令、精确归属、资源和运行策略核查 |

固定工作负载 `isolation-probe-v1` 是真实 Node HTTP 进程，仅 `/healthz` 返回 200；没有模型调用、文件工具或对话能力。协议的 `engine=pi` 暂用于接通 E1 生命周期槽位，不代表 pi 引擎接入；dsh 拒绝。当前不会调用原 pi wrapper 或读取 Provider Key。

## 2. 持久化与停止承诺

专用 ledger 使用独立 schema `bairui_orchestrator`，不使用业务 `DATABASE_URL`，不自动迁移。安装标识在启动时核对。每个 run 以 PostgreSQL session advisory lock 串行化，同 run 并发返回可重试 `run_busy`；不同 run 独立。调用 Docker 时没有打开长数据库事务。

关键顺序：

1. 创建前持久 `creating`，创建返回完整 ID 后持久 `created`。
2. Docker start 前持久 `starting`，健康检查成功后才持久 `running`。已尝试 start 的退出容器不能以旧 run 重启。
3. stop 先持久 `terminal=true / stopping`；首次 stop 且不存在也建立永久终止标记。
4. 删除只操作验证归属的完整 ID。成功列举确认 ID/原名称下无容器后，才能持久并签发 stopped/absent。

重复 PUT 不改变资源规格或首次创建时间。PostgreSQL JSONB 字段顺序不影响幂等；agent/runGeneration 或资源规格变化会拒绝。终止 runId 永不复用，应用角色没有删除 run 终止记录的权限。

创建结果未知、ledger 已为 creating 且暂时找不到容器时，保持不确定状态：Docker daemon 可能稍后完成 create。不能重复 create，也不能把当前不存在解释为已回收。以后发现匹配容器时可检查/删除；永久不确定项需要运维核查，不能删 ledger 或手改 stopped 来消除它。

已知 ID 的容器即使被改名，仍按 ID 找到并回收。归属标签或 ID 不匹配时不删除。移除失败或结果丢失保持 stopping，后续检查再确认；Docker 查询失败不是 absent。数据库断连后旧会话不再提交；恢复通过持久阶段和相同容器 ID 继续。

## 3. 资源与 TTL

- CPU millicores → `--cpus`，内存 → `--memory` 且 memory-swap 同值，PID → `--pids-limit`。
- 固定非 root UID/GID 1000、只读根、cap-drop ALL、no-new-privileges、restart=no、log-driver=none。
- 不传任意 env/命令/镜像/挂载/端口；本机镜像 pin 到 sha256 ID，拒绝镜像声明匿名卷。网络须为同 installation 所有的 internal 网络，不发布容器端口。
- 没有持久用户卷；“资源回收”指本次容器及其进程/cgroup 删除，不涉及用户业务资料的清除。

本阶段没有业务活动入口，所以空闲从首次创建意图开始计时；健康检查、GET 和重试 PUT 不续期。reaper 默认每 5 秒触发、每轮最多 32 条，上一轮未结束不会重叠。失败也轮转检查顺序，避免前一批失败永久挡住后续过期容器。TTL 到期先建立终止意图，再做归属检查和清理；已归属的旧策略容器不会因镜像策略变化永久绕过 TTL。

轮询间隔不是资源释放时限：Docker/数据库不可用、创建不确定、批次排队都会延迟回收。Docker 命令单次上限 8 秒、输出 1 MiB；单轮时间还取决于检查数与重试。当前日志只输出聚合 checked/reclaimed/failed，没有接入平台生产告警。

限制语义参考 Docker 官方 [资源限制](https://docs.docker.com/engine/containers/resource_constraints/) 与 [运行参数](https://docs.docker.com/reference/cli/docker/container/run/)。这些是容器限制，不是全局容量预留或对持有 Docker 管理权限者的安全沙箱。

## 4. 控制协议与入口

沿用 E1 的 PUT `/v1/runs/{runId}`、POST `/v1/runs/{runId}/stop` 和 GET `/v1/runs/{runId}`。请求/响应双向 HMAC，响应绑定本次 nonce。新增异步验签接口先验证签名，再等待专用 PostgreSQL nonce 原子插入；重启、多连接池共享去重，存储失败不产生 Docker 副作用。原同步 verifier 保持兼容。

正文上限 64 KiB，正文读取总超时 5 秒，默认最多 4 个并发请求、64 个连接；已认证的业务错误返回签名的固定错误枚举，无原始 SQL、凭据、请求正文或内部错误。未认证或过载响应不能当有效回执。

独立入口：

```powershell
conda run -n cloud --no-capture-output npm run orchestrator:isolation
```

此命令默认失败，不读取项目 `.env`。需要显式注入以下独立配置（示意字段，无实际凭据）：

| 配置 | 要求 |
| --- | --- |
| `BAIRUI_ORCHESTRATOR_MODE` | 必须 isolation |
| `BAIRUI_ORCHESTRATOR_DATABASE_URL` | 专用 ledger 库受限登录；不可复用业务库 |
| `BAIRUI_ORCHESTRATOR_INSTALLATION` | 与库内及 Docker 网络归属标签一致 |
| `BAIRUI_ORCHESTRATOR_NETWORK` | 已准备的同安装 internal 网络 |
| `BAIRUI_ORCHESTRATOR_IMAGE` | 已批准本机 Node 镜像的 sha256 ID |
| `BAIRUI_RUNTIME_CONTROL_KEY_ID/SECRET` | 独立控制密钥，随机 secret 至少 32 字符 |
| `BAIRUI_ORCHESTRATOR_TLS_KEY_FILE/CERT_FILE` | 对应私钥/证书文件；客户端必须校验证书 |
| `BAIRUI_ORCHESTRATOR_PORT` | 默认 9494；监听固定 127.0.0.1 |
| `BAIRUI_ORCHESTRATOR_REAP_INTERVAL_MS` | 默认 5000，范围 1000–60000 |

没有生产 HTTP 开关。HTTP server 工厂的 allowTestHttp 仅供隔离测试调用，实际入口始终 TLS。停止编排进程保留 ledger 和容器，重启后继续协调；停止服务不等于已释放所有容器。

DBA 应在新专用数据库执行 `schema.sql`，填入安装标识，并给专用登录 schema USAGE、installation SELECT、runs SELECT/INSERT/UPDATE、nonces SELECT/INSERT/DELETE。不给 runs DELETE、不授超级用户/BYPASSRLS，不授任何业务表权限。它是可信机器控制库，不是面向客户端的业务授权层。当前未对常驻环境执行此准备。

## 5. 验证入口与覆盖范围

```powershell
conda run -n cloud --no-capture-output npm run test:orchestrator
conda run -n cloud --no-capture-output npm run test:runtime-control
conda run -n cloud --no-capture-output npm test --prefix apps/platform-api
conda run -n cloud --no-capture-output npm run test:platform
```

`test:orchestrator` 清除继承的业务连接与 BAIRUI 配置，使用随机独立 PostgreSQL 容器、非超级用户 ledger 登录、随机 internal 网络和临时自签名证书。需要本机已安装 Docker、OpenSSL，以及 node:22-alpine / pgvector/pgvector:0.8.2-pg17-bookworm 镜像；镜像先解析为 ID，禁止自动 pull。TLS 客户端仅信任本次生成的 CA，不修改系统信任、不关闭证书验证。

验收覆盖：

- E1 RemoteRuntimeDriver 签名调用真实容器创建、检查、删除；读取容器内 cgroup v2 的 cpu.max/memory.max/pids.max、UID 与只读文件系统，核对无挂载/发布端口。
- 真实 PG JSONB 幂等、受限授权、两个连接池同 run 互斥、nonce 原子去重。
- 停止终止记录、迟到 PUT 拒绝、容器改名后的完整 ID 删除。
- 真正 pg_terminate_backend 发生在 Docker create 后：未持久 ID 的记录通过同容器恢复，没有创建第二个。
- Docker rm 已执行但调用结果丢失：保持 stopping，后续真实查询确认 stopped。
- 独立 HTTPS Node 进程强制退出、重新启动，验证容器 ID、防重放和 tombstone 持久性；重启初轮 reaper 与 GET 竞争时仅对 run_busy 使用有界重试。
- TTL 测试用注入时钟推进 61 秒，然后实际删除 Docker 容器；不是等候 60 秒的墙钟精度/高负载时限测试。

完成后按本次随机安装标签查询，再逐个核对完整 ID/归属并删除本次容器、临时数据库卷和网络；临时证书目录也删除。创建/查询结果不确定时明确报失败并保留安装标识供核查，不输出“全部已清理”的保证。无 Docker prune、无共享卷清理。

2026-10-09 本机结果：E2 专项 34 项通过、0 失败、0 跳过；E1 专项 62 项全部通过；后端全量 259 项中 251 通过、8 个数据库专项按独立入口跳过、0 失败（E1/E2 数据库已经上述专项实际执行）；平台专项 25 项全部通过。独立生命周期及协议复核发现的问题均已补回归修复，包括完整 ID 回收、禁止未知 start 重启、JSONB 幂等、回收轮转和策略漂移 TTL。没有执行部署或远程推送。

## 6. 后续范围

本阶段不包含常驻平台 Controller、治理事件到真实 Runtime 的部署闭环、平台路由与 TTL 状态主动同步、生产告警、跨节点调度、集群容量配额、真实 pi/dsh/Provider、Boundary 票据或用户执行入口。

下一阶段先接受限 Controller 的常驻协调与告警，处理 TTL/异常退出的状态回流，并在独立环境验收治理停止闭环；再单独设计真实工作负载、可信活动更新和受控用户入口。不能把本次 probe 容器验收写成真实 Agent 已上线。

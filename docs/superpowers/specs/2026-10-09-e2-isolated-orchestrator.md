# E2：实际编排器与资源回收（隔离验收）

用户已授权本阶段开发。沿用 E1 协议，交付独立入口的 Docker 编排服务；API 不获得 Docker 权限，不接 Provider，不启用用户执行，不部署业务或预发。相比直接接 Swarm/Kubernetes，先用单机 Docker 验证资源与停止语义，后续集群实现须重新验收。

## 边界与组件

- 代码位于 `apps/platform-api/src/runtime/orchestrator/`，独立入口、不从 app/dev 引用；复用 pg 和 E1 纯协议模块。
- 独立 PostgreSQL ledger 保存 run、创建阶段、终止意图、nonce。不增加业务迁移。独立库专用身份，不得使用业务 DATABASE_URL。Memory ledger 仅用于单元测试。
- 固定 isolation-probe-v1 工作负载（真实 Node HTTP 进程，非 Agent/模型），只接受 pi 协议槽位，dsh 拒绝。镜像必须是本机 sha256 ID，不接受请求指定镜像、env、命令、挂载或网络。
- 外部正式控制面仅 HTTPS；隔离测试显式 localhost HTTP。HMAC 双向签名及持久原子 nonce 防重放；正文 64 KiB、超时、并发上限、错误枚举。
- Docker CLI 参数数组、无 shell；固定独立 internal 网络、精确安装归属标签、容器名哈希，删除使用完整容器 ID。检查归属不符即拒绝；不扫描删除未知资源、不 prune。
- 强制 CPU、内存（swap 等于 memory）、PID、非 root、cap-drop ALL、no-new-privileges、只读根目录、无卷/端口映射、无 restart、限制日志。探针不写持久数据。

## 并发和回收

同 run 的 DB advisory session lock 串行化意图，先持久创建标记再调用 Docker；不在长事务内运行 Docker。初次创建未知且找不到容器时**保留不确定状态**，不能再次 create 或确认 absent：daemon 可能仍有迟到 create。重启后发现同名且归属匹配容器可继续检查/删除。容器 ID 一旦已确认，后续只操作这个 ID，不重新创建。

stop 先持久终止意图；首次 absent 也保存永久 tombstone。停止成功必须 `rm -f` 完成并经 Docker 成功列举确认 ID/名称不存在；Docker 不可用不能当不存在。stop 未完成留 stopping。已终止 run 永不复活；不同 identity 或 resourceSpec 重用 runId 拒绝。终止记录不自动过期。

本阶段没有业务活动入口，所以空闲从首次创建意图计时；重试 PUT、GET/健康检查不续期。reap 单轮有界，回收 TTL 到期、停止未完成、异常退出容器；不续启旧 run。未来接业务活动时须另行设计可信活动更新，不能把健康检查当用户活动。平台侧常驻 Controller/告警/TTL 状态同步属下一阶段；E2 不对外发布真实用户路由。

## 验收

单元验证参数约束、持久化前置、失败不误报、冲突、并发、TTL。一次性 PG + 自有随机 internal 网络 + 真实容器验证签名启动/检查/停止、重启 tombstone/nonce、迟到启动、CPU/memory/PID 内核 cgroup、只读/非 root、无挂载/发布端口、TTL 删除和无残留。故障注入必须验证真实 ledger 状态，不只断言 mock 调用。保留 E1 和平台能力回归。

Docker 行为参考：[运行限制](https://docs.docker.com/engine/containers/resource_constraints/)、[create](https://docs.docker.com/reference/cli/docker/container/create/)、[运行参数](https://docs.docker.com/reference/cli/docker/container/run/)。Docker 权限属于可信基础设施权限；参数限制不是对 Docker 管理员的安全沙箱。

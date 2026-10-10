# E3：常驻 Controller、状态回流与告警闭环

用户已确认这一步开发；延续独立验收，不迁移业务库、不部署预发，不开放用户执行。使用 E1/E2 现有协议；不增加另一套账号或告警系统。

## 方案

采用定时轮询 + PostgreSQL 短租约 + 现有 Prometheus/Alertmanager 链路。相比只靠 NOTIFY，轮询能在断连重启后恢复；相比直接发送外部 webhook，现有监控可以发现 Controller 自身停止。本批不做 NOTIFY 优化和外部通知渠道。

1. 独立常驻 Controller 入口要求显式 isolation、独立受限控制连接、HTTPS 编排器、精确 Runtime allowlist 和专用指标 token；不读取业务 `.env`。命令 tick 与状态观察按有界批次串行，不重叠；异常不中止后续轮次；退出停止领取并等待当前操作结束。
2. 040 在既有 control 表增加观察租约/快照字段，用受限 SECURITY DEFINER 函数领取单条、提交观察、读取聚合诊断。复用 FORCE RLS 与治理共享锁，锁序 Agent → control → run。Memory/PostgreSQL 同契约。
3. 观察提交匹配 worker、随机 token、未过期租约、agent/run/runGeneration/controlGeneration；旧观察不能修改新 run。签名 stopped/absent 将旧路由删除、run/control/agent 更新已停止并记录系统 recovery_stop 审计；原 desired running 时 generation 增加，不自动启动。running 只刷新已存在且同代次、同地址/容器身份的路由，不发布新路由。404、超时、签名错误只记失败，不解释成资源回收。
4. 聚合诊断包含 active、stopping、stopOverdue（停止超过60秒）、deadPending（仅尚有 active run 的 dead 命令）、observationErrors、observationStale（当前 run 超过60秒未成功观察）。历史 dead 不在资源回收后持续假告警；审计记录仍保留。
5. 独立指标端口仅鉴权 GET /metrics，指标不含用户/Agent/run ID、URL、SQL或正文。Controller 周期失败保留最后诊断值，以 cycle_ok 和最后成功时间暴露失效，不能缺数据补零。
6. 独立 Runtime 告警规则覆盖 Controller down/stale、周期失败、停止超时、dead 待处理、观察失效；扩充现有接收器固定白名单。源码提供专用规则，不自动接入常驻预发监控。隔离验收实际 Prometheus → Alertmanager → 接收器 firing/resolved 写入，不只测试表达式。

## 验收与限制

先单元失败测试，后真实受限 PostgreSQL 040、两个 Controller/观察租约竞争、迟到观察、治理锁、断连与失败回滚。连接 E2 真实 Docker probe，验证周期启动/停止、TTL/异常退出回流、路由撤销、暂停恢复不复活。用临时数据库/随机网络/固定本机镜像，清理精确归属资源；不使用业务 `.env` 或预发故障验收。

常驻指的是程序能力，不是本次安装后台系统服务。未部署真实 Provider/Boundary/用户 Agent；不是跨节点 HA 或生产容量验收。故障中维持最后已知状态并告警，不承诺强停时限；监控链路本机全停需未来外部监控。

# E3 业务库与常驻预发接入

用户已授权操作业务库和常驻预发。保留真实 Agent、Provider、用户执行入口关闭。

## 设计

- 两个环境各自迁移 039/040；已存在的治理 036/037 不重跑，不给应用账号启停函数。
- 每个环境独立 Controller 登录角色（九个受限函数）、机器 ledger 数据库及编排器登录角色、HMAC、指标 Token、TLS、内部运行网络。
- Controller 非 root、无 Docker socket；编排器独立镜像和 Docker 权限，不给 API 增权。独立容器使用 Docker restart unless-stopped 持续运行，不发布端口。业务 PostgreSQL 加入本安装内部控制网络，预发使用已有数据网络。
- managed 模式显式区分 business/preprod，绑定数据库名/角色/主机及部署 installation；isolation 的原限制不变。部署配置通过只读私有 JSON 文件载入，不读 `.env`；TLS 由专用 CA 验证。
- 常驻 Prometheus 显式启用固定 Controller 目标、独立 Token 和既有五条 Runtime 规则。默认监控资产不变。告警不含身份。
- 预发正常 stop/up 协调 Controller/编排器停止恢复；不删除 ledger、密钥、网络或已有证书/业务卷。缺少持久配置或归属不符时拒绝自动补造。

## 顺序和验收

1. 已核对现存数据库和服务；业务 6 用户/6 Agent/无 engine run/无 pending outbox；旧 6 路由为历史，不据此启动。
2. TDD 补 managed 配置、私有入口和部署资产；验证 isolation 不退化、数据库覆盖参数拒绝、API/Controller 无 Docker 权限。
3. 补 opt-in 监控及预发生命周期，配置回归、E3 专项及平台回归；规格审核通过后质量审核。
4. 分别备份两库、校验 pg_restore 列表并保存状态/证书/资源清单；事务迁移并核对角色最小授权。预发 bootstrap hash 只在实际迁移后更新。
5. 构建及滚动升级预发，保留所有既有数据、Secret 和 CA；部署两个独立 Controller/编排器。业务不插入演示 Agent，不修改真实账号。
6. 验证双 API、业务库数据数量、Controller 周期及 Prometheus 目标、真实 TLS/HMAC 编排器健康、Controller 重建恢复和告警 firing/resolved；仅在预发使用专属验收身份/资源做真实容器生命周期验收。
7. 中文部署记录、AGENTS 更新，记录证据和边界。不自动推送远程。

## 完成记录

- 1–7 已完成；备份、039/040、最小授权、独立 ledger/配置及两套常驻 Runtime 已落地。
- managed/deployment 10、部署/监控配置 29、预发配置 63、E3 隔离 23、平台 25 全通过；后端 272 通过/9 专项跳过/0 失败。
- 实际端到端、完整预发和最终监控报告全部成功，详细文件名、停启保留比对及初次故障注入的修正见 `docs/48-e3-managed-runtime-rollout.md`。
- 业务记录保留、没有业务运行或真实 Agent 开放；当前分支保留，不自动推送或合并。

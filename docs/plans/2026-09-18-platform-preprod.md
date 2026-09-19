# 第三阶段第一批：本机常驻预发部署

> 按 executing-plans、test-driven-development 逐项实施；不提交或撤销既有工作。

**目标**：构建后的控制台、Caddy、双 API、独立 PostgreSQL 可重复启动且保留数据。

**架构**：保留 Better Auth、Principal、RLS。API 和数据库为本机单节点 Swarm 服务；Caddy 为只绑定回环地址的常驻容器，直连 API task，仅信任其确切 IP。网络、卷、Secret 使用专用名称及归属标签；不读取业务 `.env`，不访问 `bairui`。

**技术栈**：Node.js、PostgreSQL、Docker Swarm、Caddy、React 静态构建。

## 边界
- 固定 `https://localhost:8443`，占用则停止。使用 Caddy 内部 CA，不自动导入 Windows 信任。
- 平台模式与生产认证检查开启，不启动任何 Agent/模拟 Worker。
- stop 保留卷、密钥；不提供数据删除命令，不隐式轮换密码。
- 迁移文件变化时拒绝自动更新已有数据库，另行确认备份与迁移。
- 本机 Caddy、单库不代表高可用；监控设施、持续压测、备份恢复为后续批次。

## 实施清单
- [x] 运行入口：存活/就绪探针、合并检查、停机顺序、Secret 白名单、空闲连接故障及事务回滚失败处理已实现，24 项测试通过，含真实 pg 双超时回归。
- [x] 部署配置：双 API、受限数据库、私网、精确代理、Docker 上下文、镜像归属及已安装环境缺卷保护已实现，21 项测试通过。
- [x] 操作工具：`scripts/preprod.mjs` 和静态网关镜像已实装，首次真实启动成功；秘密只经 stdin 写入 Docker Secret。
- [x] 真实验收：复核修复后的 `scripts/test-preprod.mjs` 全部通过，含完整 stop/up；报告 `output/preprod/acceptance-2026-09-18T12-13-56-801Z-dd9676.json`，镜像版本 `bdd48079cfefc429`。
- [x] 回归：后端 112 项通过，2 项数据库用例由独立专项覆盖；前端 13 项、平台专项 22 项、调度专项 10 项通过，前端构建成功。桌面/手机注册登录、资源持久化、退出和禁用能力检查通过，记录见 `output/preprod/browser-acceptance.json`；最终版本补充复检见 `output/preprod/browser-recheck.json`。
- [x] 中文交付：已编写 docs/37，更新 AGENTS 和索引，记录实测及需要用户确认的证书操作。
- [x] 最终复核：已修复事务回滚超时后连接复用、镜像归属未校验、已安装环境缺卷被自动补建三项问题。新增测试均确认旧代码失败、修复后通过；独立复核确认事务问题已解决，本机完整验收再次通过。

# 统一管理与监控控制台：常驻预发更新记录

日期：2026-10-08。范围仅为本机独立常驻预发 `bairui_preprod`；不连接业务 `.env`，不操作业务库 `bairui` 或容器 `bairui-postgres`。

## 1. 部署结果

- Git 分支：`codex/phase2-simulation-scheduler`，部署对应源码提交 `26e0717`，已推送远程。
- 安装身份：`d30efbca7e8effb303785af8`；镜像版本：`0af022020540c78c`。
- 入口：平台 `https://localhost:8443`，管理端 `/admin/`，Grafana `https://localhost:9443`；均仅绑定本机回环。
- 最终状态：API 2/2、数据库 1/1、Prometheus/Grafana/Alertmanager/接收器各 1/1 健康。
- 原数据库卷、Caddy 证书卷和 Docker Secret 身份保留；未自动信任本地 CA。

## 2. 更新前备份

备份目录为已忽略的 `output/preprod/backups/unified-console-2026-10-07T16-08-58-814Z/`，包含预发数据库 dump、Caddy 数据归档与目录副本、状态、配置、根证书和 Secret 元数据。`bairui_preprod.dump` 大小 175391 字节，SHA-256 为 `740b55431a14287c3247d13942ff02f5fcc36cff934dcae1a21e6c4dd898e691`，恢复目录清单已验证。Secret 只记录身份元数据，不导出明文。

## 3. 部署期间修复

实际部署和验收暴露的问题均先复现后修复：

1. 预发构建输入引用了不存在的管理端 tsconfig 路径，现会验证真实输入清单。
2. 监控更新等待曾可能把旧健康任务当作新版本完成，现同时等待 Swarm 更新完成和镜像一致。
3. 预发验收 SQL 使用 `psql -c` 传变量不稳定，现通过 stdin 文件模式执行。
4. Grafana 服务 VIP 会改写网关源 IP，导致精确 Auth Proxy 白名单拒绝；网关改用 `tasks.bairui-monitor_grafana`，保留真实容器源 IP。
5. 验收仍使用旧 Basic Auth，而当前 Grafana 使用表单会话；现通过应急登录取得 `grafana_session`。
6. 320px 页面会被原始 Prometheus 浮点数撑宽；概览改为 `req/s`、`ms/s`、百分比等短格式，并增加最小宽度和断行回归约束。

## 4. 自动验收证据

| 验收 | 结果 |
| --- | --- |
| 管理端测试 | 15/15 通过 |
| 管理端 TypeScript/Vite 构建 | 通过 |
| `npm run test:preprod` | `output/preprod/acceptance-2026-10-08T04-53-01-494Z-c65638.json`，`success: true` |
| `npm run test:monitoring` | `output/preprod/monitoring-acceptance-2026-10-08T11-04-11-960Z-86a257.json`，`success: true` |

预发验收覆盖受 CA 校验的 HTTPS、双 API、用户隔离、能力关闭、滚动重建、数据库断连恢复、完整 stop/up、统一 Viewer、伪造身份拒绝、退出失效与 Grafana 应急登录。监控验收覆盖官方 promtool/amtool、两份 API 独立采集、指标认证与脱敏、真实 `2 -> 1 -> 2` 告警和恢复、本地通知持久化，以及四个监控组件重建后的历史、登录和 Secret 保留。

一次监控验收曾在恢复阶段遇到瞬时 Docker `service inspect` 失败，失败报告保留为 `monitoring-acceptance-2026-10-08T04-56-46-713Z-ebda53.json`，不能作为通过证明。确认 API 已恢复 2/2 后重跑，以上最新报告完整通过。

## 5. 浏览器验收

- `platform_admin` 和 `platform_viewer` 均可进入五项导航；观察员保持只读。
- Grafana 通过平台会话映射为 Viewer，真实面板和两份 API 数据源可加载。
- 管理员暂停测试账号后，目标已有会话刷新即失去管理端访问；解除后恢复。
- 封禁会撤销目标旧会话并返回登录页；解除不会恢复旧会话，新登录后才重新进入。
- 1440px、390px、320px 均无页面级横向溢出；截图保存在已忽略的 `output/playwright/unified-console/`。
- 测试会话最终退出并关闭，临时凭据与建号脚本已删除。测试账号只存在于独立预发库并保持 active，未接触真实业务账号。

Grafana Prometheus 插件缺少 `zh-Hans` 翻译资源时会请求 404 后回退，属于非阻塞上游本地化问题；数据源、面板和鉴权均已通过。

## 6. 仍未完成的范围

本次不是公网生产、多节点高可用、持续高并发或外部通知验收。真实 Agent/Runtime、资源回收、Agent 级配额和用户侧执行仍关闭；模拟 Worker 也未启动。后续进入 E 批前仍需先确定真实 Runtime 的强停协议、票据边界、资源模型与回滚标准。

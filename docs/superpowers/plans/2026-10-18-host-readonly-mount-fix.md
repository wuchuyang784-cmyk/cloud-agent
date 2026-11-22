# 主机采集只读挂载修复与定向部署

用户已授权修复挂载策略、专项验证、仅启动三个采集组件并核对 24 面板。

## 已复现

`/:/host:ro,rslave` 创建时全部只读，但随后启动 sampler/bridge 会传播新的可写 overlay/netns 挂载。不能忽略这些挂载或放宽只读检查。
Docker 27.5.1 拒绝包含 daemon root 的 `/` 使用 rprivate；递归只读选项又要求 rprivate。

## 设计约束

- 不改全局挂载、不增加 SYS_ADMIN、特权容器或 Docker socket。
- 使用经验证指向 `/` 的自有引用路径，只做 **非递归** 私有只读绑定，避免持有 Docker 子挂载引用。
- 用户文件系统独立非递归只读绑定，明确排除虚拟与 Docker 运行时挂载。文件系统指标只允许实际绑定的挂载点；拓扑变化需要重新执行 host up。
- 检查 `/host` 整个可见挂载树全部 ro、无共享/从属传播，同时核对 Docker NonRecursive/ReadOnly/Propagation/完整挂载清单。
- 专项真实 Linux 测试要在其他容器启动后重新检查，不能只检查 exporter 初始状态。
- 保留 API/数据库/网关容器、凭据、卷和历史；仅更新三个 host 组件。现有 Prometheus 抓取配置需要定向加入 host job。

## 执行

- [x] 添加配置与漂移/只读校验的失败回归，确认失败原因正确。
- [x] 实现非递归私有只读绑定与拓扑检查，运行专项测试。
- [x] 加强 Linux 隔离验收，真实运行，复核原容器 ID 不变及临时资源清理。
- [x] 独立复核修复，解决重要问题。
- [x] 备份并同步精确文件，启动 host 组件，定向更新 Prometheus 抓取配置。
- [x] 验证 24 条精确查询有真实数据、MemTotal 与宿主一致，Grafana 同版面板可用、原平台容器不变。
- [x] 更新运行说明与验收记录，交付结果。

验收记录见 docs/56-m1-host-monitoring.md；本机 live 报告在 output/server-start/host-fix-live-verification.json。

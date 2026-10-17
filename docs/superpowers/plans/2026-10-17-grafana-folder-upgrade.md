# Grafana 既有卷目录迁移实施计划

Goal: 按用户明确方案提升看板文件version至2，证明旧持久卷实际folderUid迁移而非仅新建安装成功。

Architecture: 保留当前dashboard UID、固定provider folderUid、数据卷和代理白名单。扩展现有compat隔离脚本为v1旧目录→仅provider变化仍旧目录→v2同卷升级，备份先于升级，浏览器确认12面板完成成功查询但允许无数据。

## 执行

- [x] 在scripts/monitoring-config.test.mjs添加version2、其他字段/UID/卷保持及字节改变断言；运行看见1!=2。
- [x] scripts/monitoring-grafana-compat.test.mjs改用随机归属namedvolume，分三阶段启动同一Grafana13.2.2，冷备数据并校验archive，保持dashboard DB ID及原目录，不删除旧目录。
- [x] 先保持version1运行实链路，验证最终目录不迁移的RED；随后monitoring-config.mjs只把dashboard version1改2，再运行相同测试GREEN。
- [x] 浏览器逐ref解析/api/ds/query响应，确认12表达式均成功、无接口错误，不把无告警/空数据当故障。隔离及云端真实会话均已完成浏览器验收。
- [x] test-monitoring.mjs常驻验收增加folderUid/12面板断言，但本次不对常驻环境运行故障脚本。
- [x] 原配置与业务配置80项回归、官方规则校验，独立复核，更新docs/51。已按明确云目标冷备、部署并验证，凭据未进入仓库/日志，临时会话及Viewer权限已清理。

所有本机命令使用Conda cloud；当前分支继续，不自动提交推送。输出位于忽略的output/monitoring-single-origin/，临时资源按随机标签和完整ID清理，原服务保持停止。

# M1 Host Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track steps below; user explicitly requested implementation.

**Goal:** 管理端同源展示真实Linux整机CPU/内存/Swap、磁盘与网络及采集状态，不涉及容器或Agent计量。

**Architecture:** 官方固定Node Exporter在host网络/PID命名空间读取只读宿主rootfs，仅监听127.0.0.1:19100。独立采样器在host网络拉取固定回环地址，原子写自有metrics卷；内网bridge只读该卷，超45秒或非法快照返回503。Prometheus仅在显式host.enabled后采集固定bairui-host-metrics:9100；Grafana新增固定bairui-host看板，同一平台鉴权和origin。

**Tech Stack:** Node24、node_exporter1.10.2、Prometheus、Grafana、现有Caddy/React/Better Auth。无新npm依赖或数据库迁移。部署CLI只读已有预发状态，不读业务.env，不自动开始常驻服务。

## Task 1 — Fixed dashboard and admin surface

Files: new `apps/platform-api/src/admin/host-dashboard.mjs`, tests `apps/platform-api/test/host-monitoring.test.mjs`; modify `grafana-proxy.mjs`, `scripts/monitoring-config.mjs`, `MonitoringView.tsx`, frontend monitoring-target and tests as necessary.

- [x] RED：固定UID=bairui-host、原平台UID/version2不变、单独主机表达式白名单、未知UID/query拒绝、授权拒绝及前端切换/重试。
- [x] Export `hostDashboardExpressions` and `hostDashboard()`; all node metrics use job=bairui-host. Expose availability, last sample time/age, uptime, CPU%, memory used/available/total, Swap used/total (no swap valid0), per-filesystem size/available/used%/inode%, per-device disk read/write Bps and net rx/tx Bps/total/errors/drops. Use fixed series selectors and legends, no browser-injected variables. Gate current values on up==1 and source timestamp<=45s so stale gauges cannot look fresh. `noValue` explicitly 未采集/不可用; never `or vector(0)` for missing resources. Clearly distinguish Linux VM from native server in descriptive text.
- [x] New file asset `dashboard-host.json` provisioned beside existing platform.json; fixed samefolder. Existing business dashboard must keep17 panels (separate original grafanaExpressions from host allowlist). Only add exact host dashboard HTML/UID/DTO/search parameter paths; preserve arbitraryquery denial/auth/limits.
- [x] Admin monitoring has two buttons 平台运行/主机资源, fixed URLs from local contract only. Identity/exit still remounts, switching cancels old probe; health retry works. Existing overview dashboardUrl contract unchanged. Test with `node --test apps/platform-api/test/admin-grafana.test.mjs apps/platform-api/test/host-monitoring.test.mjs` and `npm test --prefix apps/admin-console`, build admin. Do not auto-commit.

## Task 2 — Host collectors and managed lifecycle

Files: `scripts/host-monitoring-config.mjs`, `scripts/host-monitoring.mjs`, `apps/platform-api/src/observability/host-metrics-bridge.mjs`, associated node tests, package scripts; bounded opt-in integration into monitoring.mjs/preprod.mjs.

- [x] RED: sampler fixed URL/body/deadline, atomic snapshot; bridge rejects malformed/future/old/oversized samples, never serves previous metrics on error; resource ownership/platform Linux-native guard and no new host-published metrics ports.
- [x] Separate `sampleHostMetrics()` and `createHostMetricsBridge()` contracts. Snapshot `{version:1,sampledAt:<ms>,text:<bounded prometheus>}` max512KiB, finite samples and permitted node families only; no ENV/key/hostname metadata. Sampler serialized15s, bounded3s, clears snapshot on failure; bridge `/metrics` only, HEAD/livez fixed, read-only cache. Emit `bairui_host_metrics_sample_timestamp_seconds` for dashboard freshness. Do not proxy arbitrary URL/file path from HTTP.
- [x] Exporter official image pinned `prom/node-exporter:v1.10.2`, nonroot capdrop/read-only/no-new-privileges, host PID+network, rootfsro+rslave, only CPU/meminfo/vmstat/stat/time/filesystem/diskstats/netdev collectors and bounded virtual-device/mount exclusion. Trusted read scope only, not a tenant sandbox. Sampler nonroot hostnet no host root mount, bridge nonroot private internal overlay and readonly ownvolume. All names/labels/volume/image references validated against installation; preflight no overwrite foreign resources. New volume initialized exact root ownership; do not replace old monitor volumes orSecrets.
- [x] `npm run monitor:host -- up/status/stop`; actual managed installation nativeLinux only (reject Windows/Docker Desktop claims); explicit isolation mode may verify LinuxVM and must label it accordingly. Before up require installed running preprod monitoring, check local Docker and state installation. Preserve enabled state across ordinary monitor stop/up; serialize same installation lock. Add host argument to monitoringAssets/Revision/ConfigName consistently; old calls remain valid. Opt-in keeps old services exactly4 and old monitorImages API untouched; include host asset changing revisions safely. No automatic cloud deployment in this batch.

## Task 3 — Acceptance and handoff

- [x] Real isolated NodeExporter/sampler/bridge/Prometheus/Grafana test uses random labels/names and ownedresources only. Confirm hostCPU/memory/statfs, host namespace net counters; query every host panel incl valid empty series; sampler failure yields metrics503/up0 and no current numeric resource values; restore and verify; permission negatives and identity switching. Original local services must stay stopped.
- [x] Unit suites/config combinations/backend+frontend build; official promtool validates queries/config/rules. Extend existing compat browser coverage for host tab without weakening original12 upgrade assertion. Save reports/screenshots under ignoredoutput, cleanup only test resources.
- [x] Independent spec then quality review, fix important issues. Document native Linux setup, internal topology, resource scope, source freshness, no M2/M3/M4, enable/disable/backup/rollback and code-vs-deployment status in `docs/56-m1-host-monitoring.md` (use another number if already occupied). No automatic commit/push/deploy: user requested development, previous deployed services remain intact.

## 实施验收边界（2026-10-18）

原生 Linux 实采链与本机 Grafana 浏览器采用分层验收：前者验证 host 命名空间/只读挂载、MemTotal精确对比、24固定PromQL、exporter停/恢复、sampler真实45秒失效；后者验证新看板首次部署固定目录、同源代理、精确12+24表达式集合和三宽度UI。浏览器不接真实主机任务，认证为fixture；不声称云端新版本已常驻部署或真实BetterAuth用户新版本UI已验收。statfs/网卡计数有实际series与命名空间/挂载契约覆盖，不声称独立逐值对比。sampler过期测试后清理，恢复断言仅针对exporter。额外完成旧业务资产schema1→2兼容和managed资源漂移/停机不唤起修复。最终报告与部署说明见docs/56-m1-host-monitoring.md。

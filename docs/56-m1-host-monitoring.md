# M1：管理端原生 Linux 整机监控

## 范围与交付状态

本批新增管理端「运行监控 → 主机资源」，保留「平台运行」及原看板 UID、固定目录、历史数据。M1 是整机观测，不是用户 Agent 已运行的证明。

24 个固定面板包括：

| 分类 | 指标含义 |
| --- | --- |
| 采集状态 | Prometheus 抓取是否成功、成功样本时间、样本距今秒数 |
| 主机 | Linux 启动时长、最近 1 分钟 CPU 使用率 |
| 内存 | MemTotal、MemAvailable、两者差值；Swap 总量、已用量 |
| 文件系统 | 按挂载点显示容量、普通进程可用空间、使用比例及 inode 使用比例 |
| 磁盘 | 按设备显示最近 1 分钟平均读写字节/秒 |
| 网络 | 按网卡显示收发字节/秒、累计计数、错误及丢包/秒 |

文件系统使用比例以 `1 - avail / size` 计算，包含普通进程不可用的保留空间；不是 `du` 的目录大小。磁盘各设备不相加，避免分区/整盘重复统计。网卡累计计数可能因接口重建或计数器重置而归零，不是平台业务流量账单。

只显示实际存在的 series。未配置 Swap 时，上游明确上报的 0 有效；缺失、过期、采集失败不补 0。速率需要至少两个成功采样点，首次启用短暂没有速率属于正常预热。历史曲线可以保留过去的有效区间，不代表当前仍在线。

不包含全部容器资源（M2）、每用户 Agent 的 CPU/内存（M3）、任务量/Token/费用（M4），也未添加主机阈值告警或外部通知。本批不修改数据库，不开放 Agent 创建/执行，不更换账号系统。

这是代码与隔离验收交付；不自动升级云端常驻服务。管理端静态文件、API 白名单、Grafana provisioning 和采集任务必须同版部署后才有完整入口。

## 采集链与权限

```text
原生 Linux /proc、内核网卡、只读宿主文件系统
  → Node Exporter [host PID/network，仅 127.0.0.1:19100]
  → sampler [host network，固定回环 URL]
  → 专用缓存卷 [原子快照]
  → bridge [内网、只读缓存、9100 不发布]
  → Prometheus [原有 internal overlay]
  → Grafana → 平台 API 逐次鉴权 → /admin/
```

Node Exporter 固定为 `prom/node-exporter:v1.10.2@sha256:3ac34ce007accad95afed72149e0d2b927b7e42fd1c866149b945b84737c62c3`。只启用 cpu、meminfo、stat、time、filesystem、diskstats、netdev。排除虚拟文件系统、Docker 内部挂载、回环/bridge/veth 等虚拟接口及 loop 等设备。不是按容器限制值冒充主机内存。

采样器、桥接器复用本安装既有 API 镜像中的 Node，显式绑定本仓库 `host-metrics-bridge.mjs` 为只读文件。源代码及固定启动参数参与独立 release 哈希；同 release 也复核实际镜像、命令、UID、网络、挂载及 CPU/内存/PID/Init/restart 限制，漂移时不能直接当作就绪。

三个进程均非 root、cap-drop ALL、no-new-privileges、只读容器根目录。上限分别为 exporter 64MiB/0.20 CPU、sampler/bridge 各 96MiB/0.15 CPU，PID 64，日志 5MiB×2。缓存初始化仅在自有卷上短暂使用 CHOWN 能力；清理快照由数据所有者执行。

这三个容器是受信平台采集组件，不是租户沙箱。Exporter 可只读访问宿主文件系统和 host PID/network；不挂 Docker socket，不给平台 API、Grafana 或用户 Agent 添加 Docker 权限。Docker 管理员仍是受信主机管理员。

bridge 只接受固定 `/metrics`、`/livez`，没有 URL/文件路径代理参数；最多 4 并发、512KiB 快照、4096 样本。过滤非允许的指标和标签，不导出进程/环境变量/主机名元数据。采样每轮串行，3 秒截止，成功后原子替换；失败删除旧快照。桥接拒绝未来、非法或超过 45 秒的样本并返回 503。

Prometheus 的 `bairui-host` 任务显式 opt-in，每 15 秒抓取、5 秒超时，固定 `bairui-host-metrics:9100`，不改变既有 internal 网络隔离。全部实时资源表达式同时要求 `up==1` 和采样年龄处于 0～45 秒；采集端可达只说明采集链正常，不说明 Agent 正常运行。

## 原生 Linux 前提

- 目前只管理既有单节点 Swarm 预发安装；使用其已记录的本地 Docker endpoint、安装身份和监控网络，不读取业务 `.env`。
- 原生 Linux，Docker Linux 引擎，内核至少 5.12；宿主 `/` 为 shared 或 slave。启动前检查，绝不自动改变主机挂载传播设置。
- exporter 使用 `/ → /host:ro,rslave`；启动后读取容器实际 `/proc/self/mountinfo`，逐一检查 `/host` 及全部子挂载的 per-mount `ro`。只看 Docker 顶层 `RW=false` 不足以证明递归只读。实检失败停止本安装采集组件、保留卷，记录 failed。
- 回环 19100 必须没有其他采集器占用；不停止不属于本安装的进程。
- 固定镜像需已存在或能从官方 registry 拉取；为镜像、日志与 Prometheus 历史留足磁盘空间。

Docker Desktop 不满足本批 managed 部署条件；其 Linux VM 不等于物理 Windows 主机。不得为了测试修改宿主全局挂载设置或用普通容器网卡/根文件系统代替整机数据。

依据：[Docker bind/递归只读与传播说明](https://docs.docker.com/engine/storage/bind-mounts/)、[Node Exporter 固定版本官方部署说明](https://github.com/prometheus/node_exporter/blob/v1.10.2/README.md)。

## 后续正式升级与启用

以下命令是服务器后续部署步骤，本批开发不会自动执行。

1. 在升级窗口备份 `output/preprod/state.json`、当前提交、已有 Grafana/Prometheus 的持久卷及 provisioning；按现有备份流程校验归档可列出。保留原 Secret、安装身份、证书和数据卷，不用删除卷处理升级问题。
2. 拉取同版代码，进入 Conda `cloud`；若前后版本含其他数据库变更，先按对应批次备份/迁移，M1 本身没有新迁移。
3. 升级既有平台与监控，使 API 白名单、管理端与新看板均生效。`preprod:up` 会更新平台镜像并短暂滚动服务，应在确认窗口执行。不要重建安装身份或修改既有 origin。

```bash
cd /home/ubuntu/cloud-agent
conda activate cloud
npm run preprod:up
npm run monitor:status
npm run monitor:host -- up
npm run monitor:host -- status
```

若原安装尚未接入监控，先按文档 38/51 完成既有 `monitor:up` 流程；主机采集命令不会替你唤起已停止的监控栈。启用新增 3 个受信采集容器和 1 个缓存卷，现有 4 个监控服务保留；重发监控配置可能使相关服务短暂滚动，不开启新公网端口。

访问地址仍为既有控制台 origin 的 `/admin/`。使用 active 平台 viewer/operator/admin 账号进入「运行监控 → 主机资源」。每次请求复核平台会话、账号状态与平台权限，普通用户不能访问；同源固定 `/api/admin/grafana/`，不增加独立 Grafana 登录或端口。

当前 `monitor:host` 管理的是预发采集链。业务监控生成器也包含同一主机看板及白名单，但未为独立业务安装增加第二套主机采集/跨环境转发；没有对应任务时应显示未采集，不能承诺业务环境已经有数据。

### 启停、保留与回退

```bash
# 只停主机采集并撤下对应抓取任务，保留历史与缓存卷
npm run monitor:host -- stop

# 显式重新启用
npm run monitor:host -- up
```

普通 `monitor:stop` / `preprod:stop` 联动停止主机组件但保留 enabled 记录；后续显式 `monitor:up` / `preprod:up` 恢复。`monitor:host -- stop` 不会自动启动此前已停的监控。所有操作复用本安装锁并先核对资源归属，拒绝覆盖同名外来资源；已记录缓存卷丢失时拒绝自动替代。

回退旧版代码前，先在当前版本执行 `monitor:host -- stop`，核对组件已停，再按已有平台/监控回退流程恢复代码与配置，保留历史卷和备份。旧代码不认识 M1 enabled 状态，不应留下旧版无人管理的采集容器。不要通过清空 state、删 Secret 或卷来回退。

旧业务安装的资产 schema 未记录/为 1 时，只有新增 `dashboard-host.json` 的 ENOENT 允许进入升级；status/stop 不补写文件。显式 business up 完成暂存验证与原子发布后才标记 schema2。原有资产、凭据、连接器或持久卷缺失，以及权限错误仍拒绝；schema2 的新看板丢失也拒绝。该兼容修复不改变业务账号、机器桥接 token 或历史。

## 验收方法

```bash
npm run test:monitoring:host
npm run test:monitoring:config
npm run test:monitoring:business
npm test --prefix apps/platform-api
npm test --prefix apps/admin-console
npm test --prefix apps/console-mvp
npm run build:admin
```

真实 Linux 验收使用 `scripts/host-monitoring-native-acceptance.mjs`，随机归属的容器、网络和卷；只读读取宿主指标，不操作业务库或既有服务，finally 精确清理并核对原运行容器 ID。测试固定官方 exporter 与 24 个 PromQL、宿主 MemTotal 精确对比、exporter 停止/恢复、sampler 停止后真实等待超过 45 秒、bridge503/up0/实时资源空，最后清理。它不是常驻部署入口。

当前真实验收报告：`output/m1-native/2026-10-18T06-10-41-093Z-1de553de/report.json`，9/9 检查及清理通过；8 个原运行容器 full ID 前后完全不变。样本实际年龄 45.486 秒后拒绝，21 项资源即时查询为空；总内存精确为 3,837,116,416 字节而非容器 64MiB 限制。磁盘/网卡/文件系统已观察到实际 series，并验证 host 命名空间与挂载契约；不把查询成功表述为每项 statfs/网卡计数都已与独立宿主命令逐值比对。实际来源、固定镜像和源码 SHA 清单随报告保留。

如需在指定验收机重跑，使用已配置的 SSH 别名和该安装实际 API 镜像的 16 位 revision，所有目的地参数都必须显式提供：

```bash
node scripts/host-monitoring-native-acceptance.mjs --ssh linux-validation \
  --project-root /home/ubuntu/cloud-agent --api-revision <16hex> \
  --conda-path /home/ubuntu/miniconda3/bin/conda
```

调用者也应处于 `cloud`。未给 conda-path 时只尝试 `command -v conda` 发现已有可执行文件，不安装环境；远端执行固定 `conda run -n cloud --no-capture-output node`。脚本不从业务 `.env` 获取连接信息，也不会根据默认主机静默写远端。

浏览器兼容测试使用原生 Grafana/Caddy/Prometheus 和临时认证 fixture，验证原 12 面板及新增 24 主机面板的同源查询、两组切换/刷新、桌面/手机布局及权限拒绝。浏览器测试没有启用主机任务，空数据是预期；真实来源/数值与故障闭环由独立 Linux 验收覆盖。该分层验收不冒充云端真实 Better Auth 用户的新版本上线验收。

本批回归：后端 418 通过/14 数据库专项跳过/0 失败，管理端 36、客户端 37、配置组合 119、M1 专项 32 项通过，管理端构建通过；官方 promtool 验证含 host 的配置与原七条规则，amtool 通过。没有为使测试通过而启用旧 Worker/真实 Agent 或迁移业务库。

最终浏览器报告：`output/monitoring-single-origin/2026-10-18T06-20-35-040Z/report.json`，原平台12项及主机24条精确表达式均完成查询，HTTP/逐查询/页面错误均为0；固定目录、旧卷升级、两组切换/刷新、1440/390/320px及权限拒绝通过，临时资源清理完成。浏览器健康阶段在故障注入前关闭，不把有意停机响应混入健康报告。本机原常驻服务保持停止。

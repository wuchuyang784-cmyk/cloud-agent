# 平台设计方案归档（重新设定与优化版）

> 状态：归档（design archive）
> 来源：学习自 `LUTAO581314/BaiRui-cloud-agent-platform`（dev 分支）的设计方案，并在其平台上进行重新设定与优化
> 归档日期：2026-08-28
> 文档定位：本文是平台设计的**综合归档**，回答"平台如何设计、为什么这样设计、哪些保留、哪些移除、如何演进"。它不替代各专项文档（`10`–`28` 号），而是提供一份跨文档的**重新设定总览与决策记录**。

---

## 一、归档背景与目的

### 1.1 背景

学习开源项目 `BaiRui-cloud-agent-platform`（dev 分支）的平台设计方案。该项目定义了一套"云平台侧的控制、交付与运维系统"：平台管理 Agent 的所有权、期望状态、部署、运维与多租户边界，而 Agent 的执行本体由运行时承载。

本次归档以该项目为**设计基线**，在保留其平台层设计思路的前提下，对 Agent 本体方案进行重新设定与优化。

### 1.2 核心决策（本文的最终结论）

| 维度 | 决策 |
| --- | --- |
| **保留** | pi-agent + deepseek-harness（dsh）双引擎 Agent 本体方案、模板体系、平台控制面（多租户 / 路由 / 安全 / 发布 / 渠道 / 遥测）设计思路 |
| **移除** | Hermes Runtime Core（自研 Agent 运行时）、BaiLongma（Brain UI 上游方案）、bairui-agent 自研本体框架 三者的 **Agent 本体方案** |
| **优化** | 控制面与本体解耦：平台只依赖"引擎适配层"单一接口，不感知引擎差异；模板化一键创建成为产品主线 |

> 说明：本文"移除"指**不再作为 Agent 运行本体的实现方案**；平台侧的通用机制（控制面协议、密钥封套、Channel Worker、遥测 schema 等）仍然保留并复用，只是其"运行时目标"从 Hermes 切换为 pi/dsh。

---

## 二、平台设计核心思路（学自 BaiRui 项目）

### 2.1 平台定位：控制、交付与运维，不运行本体

平台是 Agent 生态的**控制平面**，负责：

- **所有权与账户**：accounts、organizations、Agent ownership、agent_memberships；
- **权威存储**：PostgreSQL 作为控制数据权威（期望状态、观测、命令租约、回执、审计）；
- **交付与运维**：期望状态管理、许可证、发布流水线、Server Agent 出站心跳、命令租约/回执；
- **多租户边界**：`owner_user_id` 权威所有权 + 成员关系，浏览器只能访问自己的 Agent；
- **管理面**：admin UI、审计、RBAC。

平台**不拥有**：Agent 的会话循环、模型调用、工具执行、记忆等执行细节——这些由 Agent 运行时本体负责，平台通过"运行时边界 / 引擎适配层"接入。

### 2.2 分层架构（原项目基线）

```text
浏览器 / 渠道用户
        │
        ▼
┌─────────────────────────────────────────────┐
│  Platform（平台）                              │
│  · accounts / org / Agent ownership          │
│  · PostgreSQL Authority（期望状态/观测/租约）   │
│  · 控制面协议（allow-list 操作 + 状态机）        │
│  · 管理面 / 用户面 / 内部面 路由边界             │
└─────────────────────────────────────────────┘
        │ 出站 TLS / 签名信封 / 机器身份
        ▼
┌─────────────────────────────────────────────┐
│  Server Agent（服务器侧代理）                  │
│  · 出站心跳、资源遥测                          │
│  · 命令租约/回执、容器生命周期                  │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Runtime Boundary → 引擎适配层（优化后）        │
│  · spawn / stop / health / route / validate  │
│  · 引擎差异封装在适配器内部                    │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Agent 运行本体                               │
│  · pi-agent（任务/编码型）                     │
│  · deepseek-harness（对话/多工具型）           │
└─────────────────────────────────────────────┘
```

### 2.3 关键机制（全部保留为平台设计基线）

| 机制 | 要点 | 依据文档 |
| --- | --- | --- |
| **控制面协议** | allow-list 操作（snapshot.collect / probe.run / config.stage / config.apply / backup.* / release.* / service.restart 等）；命令状态机 `queued → leased → accepted → running → completion_candidate → verifying → verified → succeeded` | `11`、`16` |
| **PostgreSQL 控制模型** | desired_states / observations / commands 权威化；canonical `/leases` 与 `/receipts` 入口；审计哈希链 | `C00-03`、`10` |
| **多租户** | `owner_user_id` 权威所有权；1 Agent = 1 容器 = 1 独立子域 `agent-{id}.bairui.app`；配置/会话/资源按域隔离 | `14`、`25` |
| **路由边界** | `/api/user/*`（用户面，所有权校验）、`/api/admin/*`（管理面）、`/api/internal/*`（机器面） | `22` |
| **安全与身份** | 非对称身份、出站 TLS、无公开管理端口、签名信封（HMAC / nonce / 时间戳 / 序列）、密钥封套、RBAC 三角色、高风险操作审批 | `08`、`12` |
| **渠道桥** | Channel Worker 独立部署；PostgreSQL inbox/outbox；SKIP LOCKED 租约；at-least-once；dead-letter | `23` |
| **不可变发布** | image@sha256、SBOM、provenance、release-manifest.json；验收通过才标记"已应用" | `24` |
| **遥测与可观测** | agent_resource_samples / telemetry_events / usage_rollups；白名单重建载荷；所有权从权威记录推导 | `17`、`26` |
| **记忆权威模型** | transcript authority；memory_projection_outbox 投影管道；平台侧权威存储 + 运行时投影 | `14`、`28` |

---

## 三、Agent 本体方案：保留与移除边界

### 3.1 保留方案：pi-agent + deepseek-harness 双引擎

**决策**：平台不再使用自研 bairui-agent（Hermes Runtime Core）作为 Agent 运行本体，改为双开源引擎并存：

| 本体 | 仓库 | 定位 | 模板化 |
| --- | --- | --- | --- |
| **pi-agent** | `earendil-works/pi` | 轻量、工具原语型运行时，适合编码 / 文件操作 / 数据脚本 / 快速任务 | extensions + 配置（中等） |
| **deepseek-harness (dsh)** | `deepseek-ai/deepseek-harness` | 插件化、可组合 Harness，适合客服 / 助手 / 知识库 / 多工具对话 | preset/profile/Bundle（高，天然模板） |

**不变基线**（本体切换不改变）：

- 对话路由模型：`用户浏览器 → agent-{id}.bairui.app → Agent 本体运行时`；
- 每用户独立实例：一个 Agent = 一个隔离容器实例 = 一个永久独立子域；
- 控制台定位 = 管理面 + 启动器 + 流量入口，不承载对话本身；
- 多租户边界、控制面协议、安全边界、PostgreSQL 控制模型全部不变。

### 3.2 模板体系（保留，作为产品主线）

模板是平台一等资源，用声明式 manifest 描述"从本体引擎拉起一个完整可用 Agent"：

- `engine` / `engineConfig`：决定运行本体的镜像与配置（第一维）；
- `model` / `tools` / `systemPrompt` / `memory`：能力与人格（第二维）；
- `channels` / `ui` / `quota`：对外使用形态与资源边界。

生命周期：`创建/导入 → 校验 → 发布（版本化）→ 一键创建实例 → 停用/归档`。

用户视角：`控制台「模板库」→ 选择模板 → 一键创建 → 返回 agent 卡片（initializing → running）→ 独立子域可用`。

### 3.3 移除方案：Hermes + BaiLongma + bairui-agent

| 移除项 | 原角色 | 移除方式 |
| --- | --- | --- |
| **Hermes Runtime Core** | 自研 Agent 运行本体（Agent 循环、模型层、工具、记忆、UI） | 不再作为运行本体；其平台侧适配位置由"引擎适配层"接管 |
| **BaiLongma（Brain UI）** | 上游 UI 参考实现 | 对话前端改由 dsh web profile / pi 托管 UI（模板 `ui.kind` 决定） |
| **bairui-agent（自研框架）** | 平台侧 Agent 框架 / 运行时边界实现 | 重构为**引擎适配层（Engine Adapter Layer）**，接口不变、实现切换 |

> 落地细节（数据模型 / 适配契约 / 编排 / 凭证 / 渠道 / 前端 / 安全 / 可观测）见 `28-dual-engine-platform-build-specs.md`，本归档不重复。

---

## 四、优化后的平台设计（重新设定要点）

### 4.1 引擎适配层（核心优化）

将原 "Bairui Runtime Boundary（围绕 Hermes 的平台适配器）" 重构为 **引擎适配层**，平台上层不感知引擎差异：

```ts
export interface EngineAdapter {
  readonly engine: EngineKind;            // 'pi' | 'dsh'
  spawn(spec: AgentInstanceSpec): Promise<SpawnResult>;
  stop(agentId: string): Promise<void>;
  health(agentId: string): Promise<HealthResult>;
  route(agentId: string): Promise<string>;
  validate(manifest: unknown): Promise<{ ok: boolean; errors: string[] }>;
}
```

平台能力映射（Hermes 旧实现 → pi/dsh 新实现）：

| 平台能力 | 旧实现（移除） | 新实现（保留） |
| --- | --- | --- |
| 实例化 / 编排 | 基于 Hermes 镜像 | 按 `engine` 选择 pi / dsh 镜像，注入 manifest 配置 |
| 对话前端 | Hermes UI | dsh web profile UI / pi 托管 UI |
| 模型调用 | Hermes 模型层 | pi `pi-ai` / dsh 模型适配器（用户自配 Key） |
| 工具执行 | Hermes 工具 | pi extensions / dsh 插件树（含 MCP） |
| 记忆 | Hermes 记忆 | dsh session-log 投影 / pi 配置化记忆 → `agent_memory_entries` |
| 可观测 | Hermes 遥测 | dsh telemetry 事件 / pi 遥测 → 同一 schema |
| 渠道 | OpenClaw 候选 | Channel Worker 复用不变 |

### 4.2 数据模型（新增/扩展）

- 新表 `agent_templates`：模板库（manifest、engine、来源、版本、fork）；
- `agents` 新增 `engine` / `template_id` / `template_version`（引擎创建后不可变）；
- 新表 `agent_template_installs`：模板派生/订阅关系；
- 新表 `agent_engine_runs`：引擎实例 spawn/stop 状态机，运维权威视图；
- 记忆改造：`hermes_*` 列标记兼容遗留，新增引擎无关 `agent_memory_entries`，投影管道复用 `memory_projection_outbox`。

### 4.3 隔离与安全（优化重点）

| 层面 | 设定 |
| --- | --- |
| 容器沙箱 | pi 无内置权限系统 → 容器层隔离（非 root、只读根文件系统、网络隔离、cgroup 限制） |
| dsh 能力 seam | `ctx.sandbox` / `ctx.fs` / `ctx.shell` / `ctx.terminals` 注入租户策略对象（路径/命令/域名白名单） |
| 密钥 | 封套机制复用；Key 只经平台解密注入运行时，不出浏览器响应 |
| 配额 | 模板 `quota`（concurrentSessions / maxTokensPerDay）由适配层校验并上报 usage_rollups |

### 4.4 演进路线（优化后）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 模板 manifest schema + `agent_templates` 落库；console 模板库 + 一键创建（真数据） | 模板可发布、创建实例落库，控制台可用 |
| P1 | 引擎适配层接口 + pi/dsh 适配器；两个基线镜像；spawn/stop/health/route 打通 | 真实拉起 1 个 dsh 对话型 + 1 个 pi 任务型实例，独立子域可访问 |
| P2 | 模板市场（fork/发布/版本化）；渠道绑定按引擎生效；`015` 遗留列停写 | 用户可 fork 模板并发布，feishu/web 渠道可用 |
| P3 | 规模化：Docker Swarm 动态 service、冷启动、配额、多节点调度 | 多租户多实例稳定运行，隔离/配额生效 |

---

## 五、归档映射（本文与专项文档的关系）

| 设计域 | 权威文档 | 本文角色 |
| --- | --- | --- |
| 控制面架构 / 协议 / 安全 / 运维 | `10`–`13` | 总览与保留基线 |
| 多租户 / 舰队 / 命令交付 / 遥测 | `14`–`17` | 总览与保留基线 |
| 远程浏览器验收 | `19` | 容器隔离基线（pi 沙箱复用） |
| Platform/Agent 集成 | `20` | 跨仓契约；本体侧切换为 pi/dsh |
| 路由 / 渠道 / 发布 | `22`–`24` | 总览与保留基线 |
| 运行时环境与请求路由 | `25` | 独立子域 / 每实例独立容器，不变 |
| 总览仪表盘 | `26` | 遥测 schema 不变 |
| **Agent 本体与模板体系** | `27` | **保留方案**（pi + dsh 双引擎） |
| **双引擎落地规格** | `28` | **保留方案**（落地细节） |
| **本文** | `29` | 综合归档、保留/移除决策记录 |
| 历史 Hermes / BaiLongma / bairui-agent 本体方案 | — | **移除**（不再作为运行本体） |

---

## 六、结论

1. **平台层设计保留并复用**：控制面协议、PostgreSQL 控制模型、多租户边界、路由边界、安全与身份、渠道桥、不可变发布、遥测 schema 全部作为平台设计基线保留。
2. **Agent 本体切换为 pi + deepseek-harness 双引擎**：通过引擎适配层统一接入，平台上层不感知引擎差异。
3. **Hermes / BaiLongma / bairui-agent 的 Agent 本体方案移除**：自研运行时不再维护，相关平台适配重构为引擎适配层。
4. **模板化一键创建成为产品主线**：模板 manifest 声明引擎/能力/形态，一键拉起隔离实例，是后续演进（P0–P3）的主路径。

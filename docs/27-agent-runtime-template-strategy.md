# Agent 运行本体与模板体系设计方案

> 状态：架构决策已确认（落地指导）
> 适用范围：平台控制台（管理面）+ 用户部署的 Agent 运行本体（数据面 / 对话面）
> 关联文档：`25-agent-runtime-env-and-request-routing.md`（路由与独立域名基线，不变）、`20-platform-agent-integration-guide.md`（跨仓契约）、`28-dual-engine-platform-build-specs.md`（本决策的落地规格：数据模型/适配契约/编排设定）、`docs/README.md`（文档索引）
> 文档定位：本文确定 **Agent 运行本体的选型（pi-agent + deepseek-harness 双引擎）、Agent 模板体系，以及"模板 → 一键创建实例"的完整设计**。它是对既有架构决策的**本体层替换**：对话路由模型、独立域名 `agent-{id}.bairui.app`、每用户独立实例、控制台 = 管理面 + 启动器 + 流量入口 等既有基线**保持不变**，仅将"Agent 本体"的实现从自研 Hermes 运行时替换为开源双引擎。

## 一、背景与决策

### 1.1 决策

平台**不再使用自研 bairui-agent（Hermes Runtime Core）作为 Agent 运行本体**，改为采用两个开源 Agent 运行本体，并通过对这两个本体扩展模板，构建更多元化的 Agent 实例供用户一键使用：

| 本体 | 仓库 | 协议 | 定位 |
| --- | --- | --- | --- |
| **pi-agent** | `earendil-works/pi` | MIT | 轻量、工具原语型 Agent 运行时，适合编码、文件操作、快速任务类 Agent |
| **deepseek-harness (dsh)** | `deepseek-ai/deepseek-harness` | MIT | 插件化、可组合的 Agent Harness，适合对话型、多工具、可定制扩展的 Agent |

### 1.2 为什么换

- **自研本体维护成本高**：Hermes 作为自研运行时，需要持续维护 Agent 循环、模型适配、工具执行、记忆等基础设施，与平台核心价值（云平台、控制面、交付、多租户编排）正交。
- **开源双引擎成熟可复用**：pi-agent 与 deepseek-harness 均已 MIT 开源、社区活跃，Agent 循环、模型适配、工具系统、记忆基础设施开箱即用，平台可聚焦在**模板编排、多租户隔离、部署交付**上。
- **模板化是一键使用的关键**：两个本体都提供配置/插件/预设机制（pi 的扩展与配置、dsh 的 preset/profile/Bundle），天然适合"定义模板 → 一键拉起实例"的产品形态。

### 1.3 不变的部分（既有基线）

以下基线**不因本体更换而改变**，继续遵循既有文档：

- 对话路由模型：`用户浏览器 → agent-{id}.bairui.app → Agent 本体运行时`（`25` 号文档 §2）；
- 每用户独立实例：一个 Agent = 一个隔离容器实例 = 一个永久独立子域（`25` 号文档 §3）；
- 控制台定位 = 管理面 + 启动器 + 流量入口，不承载对话本身（`25` 号文档 §1）；
- 多租户边界与平台主权（`14-multi-tenant-agent-runtime.md`）；
- 控制面协议、PostgreSQL 控制模型、安全边界（`10`–`17` 号文档）。

## 二、本体选型分析

### 2.1 pi-agent（`earendil-works/pi`）

核心特性：

- **设计哲学 "Primitives, not features"**：默认只提供少量核心原语工具（读、写、编辑、执行命令等），能力通过扩展按需叠加，拒绝"大而全的魔法功能"。
- **运行时可独立复用**：`pi-agent-core` 提供 Agent 运行时（tool calling + 状态管理），可脱离 TUI/CLI 以 headless 方式集成，适合平台拉起实例时注入配置直接运行。
- **工具扩展机制**：通过 extensions 扩展工具与能力，可挂载 MCP 工具（30+ 生态），满足"按模板叠加工具"的需求。
- **模型适配**：统一 LLM API 层（`pi-ai`），可对接 DeepSeek / Claude / OpenAI 等，支持用户自配 Key。
- **部署形态**：Node/TypeScript 生态，可容器化，符合平台"每 Agent 一个独立容器实例"的部署模型。

适配注意点（平台侧需处理）：

- 无内置权限/隔离系统，默认以启动用户权限运行——平台必须在其外层提供沙箱/容器隔离（复用既有 `19-remote-browser-acceptance.md` 与容器编排基线）。
- 本体侧重"任务执行型"交互，对话型体验需通过模板补充系统提示与前端 UI。

### 2.2 deepseek-harness（`deepseek-ai/deepseek-harness`）

核心特性：

- **"一切皆插件"**：基于 Cordis 插件框架，模型适配器、工具注册表、会话日志、Agent 循环全部是可替换插件，通过**插件树**组合出不同 Agent。
- **预设与模板机制（Preset / Profile）**：
  - 提供内置 profile（如 web 浏览器应用、headless 一次性运行器），可在此基础上定制；
  - 通过 preset 定义模型、工具、系统提示的组合，天然对应平台"Agent 模板"概念。
- **组合包分发（Bundle）**：以 Bundle 形式打包插件与配置，可整体分发/部署，契合平台"交付包"与模板市场形态。
- **会话记忆**：会话日志（session logs）作为唯一上下文来源，可投影到平台记忆系统（记忆权威模型见 `14-multi-tenant-agent-runtime.md` 的 transcript authority 基线）。
- **能力 seam**：提供 `ctx.fs`、`ctx.shell`、`ctx.terminals`、`ctx.sandbox` 等能力边界，平台可在这些 seam 处注入租户隔离与安全策略。
- **事件系统**：`session/event`、`agent/*`、`tools/*`、`telemetry/*` 等事件可对接平台可观测（`17-agent-resource-telemetry.md`）。

适配注意点（平台侧需处理）：

- 插件生态以 DeepSeek 模型为默认，需在模板层显式配置模型适配器以支持多模型（用户自配 Key）。
- Profile（web/headless）决定运行形态，平台需按"对话型/任务型"模板选择合适的 profile 与前端承载。

### 2.3 双引擎分工建议

| 维度 | pi-agent | deepseek-harness (dsh) |
| --- | --- | --- |
| 适合的 Agent 类型 | 编码、文件操作、数据/脚本任务、快速工具型 Agent | 客服、助手、知识库问答、多工具对话型 Agent |
| 交互形态 | 任务执行型（工具原语） | 对话型（web profile）/ 任务型（headless） |
| 定制方式 | extensions + 配置 | 插件树 + preset/profile/Bundle |
| 模板化匹配 | 中等（配置驱动） | 高（preset 天然是模板） |
| 隔离要求 | 必须外层沙箱 | 必须外层沙箱（复用容器隔离） |

> 结论：**双引擎并存而非二选一**——模板声明自己基于哪个引擎，平台按模板的 `engine` 字段选择拉起对应的容器镜像/运行配置。这样既覆盖对话型 Agent（dsh），又覆盖任务/编码型 Agent（pi），实现"更多元的 Agent 实例"。

## 三、Agent 模板体系（核心）

### 3.1 模板 = 可一键实例化的 Agent 规格

模板是平台侧的一等资源，用声明式 manifest 描述"从本体引擎拉起一个完整可用 Agent"所需的全部信息：

```yaml
# agent-template manifest（示意）
template:
  id: tpl-cs-dsh-v1
  name: 智能客服模板（DeepSeek Harness）
  engine: dsh                 # pi | dsh，选择运行本体
  engineConfig:
    profile: web              # dsh: web | headless；pi: 容器入口配置
    preset: customer-service  # 引擎内置 preset / Bundle 引用
    bundle: baiui/dsh-cs-v1   # 可选：组合包（Bundle）分发
  model:
    default: deepseek-chat
    providers: [deepseek, claude, openai]   # 用户可自配 Key
  tools:
    - feishu-docs
    - web-search
    - internal-api
  systemPrompt: |
    你是客户服务 Agent，负责售前咨询与售后工单……
  memory:
    mode: session-log         # session-log | obsidian | none
    retentionDays: 30
  channels:
    - feishu
    - web
  ui:
    kind: dsh-web             # 本体自带 UI 或平台托管占位
  quota: { concurrentSessions: 20, maxTokensPerDay: 500000 }
```

字段说明：

- `engine` / `engineConfig`：决定运行本体的镜像与配置，是模板的**第一维**。
- `model` / `tools` / `systemPrompt` / `memory`：决定 Agent 的**能力与人格**，是模板的**第二维**（基于引擎的 preset/插件叠加）。
- `channels` / `ui` / `quota`：决定对外**使用形态**与资源边界。

### 3.2 模板来源与生命周期

| 来源 | 说明 |
| --- | --- |
| 官方模板 | 平台预置，覆盖高频场景（客服、助手、知识库、编码、数据分析等），双引擎各出若干 |
| 引擎生态模板 | 直接复用 pi / dsh 官方与社区 preset、Bundle，标注来源与版本 |
| 用户/组织模板 | 用户基于现有模板 fork 修改，保存为自己的模板，可分享到组织 |

生命周期：`创建/导入 → 校验（manifest 合法、引擎与 preset 存在）→ 发布（版本化）→ 一键创建实例 → 停用/归档`。

### 3.3 一键创建流程（用户视角）

```text
控制台「模板库」
  -> 选择模板（浏览/筛选：引擎、场景、工具）
  -> 一键创建
     平台后端:
       a. 解析 manifest，生成实例配置（注入用户 org/agent_id、密钥占位、域名）
       b. 基于 engine 选择容器镜像，拉起独立容器实例
       c. 注入用户配置（API Key 由用户在实例配置页自配，不落模板）
       d. 分配独立子域 agent-{id}.bairui.app，绑定网关路由
  -> 返回 agent 卡片（状态 initializing -> running）
  -> 用户点「对话」/ 直接访问 agent-{id}.bairui.app 使用
```

与 `25` 号文档 §4 的启动动作完全一致，仅"拉起什么"由模板决定。

### 3.4 实例配置与隔离

- 模板只含**公共规格**；用户 API Key、渠道凭证、业务配置属于**实例私有**，落在该实例，不污染模板与其他实例（沿用 `25` 号文档 §1 的"用户自配置"）。
- 实例 manifest = 模板 + `agent_id` + 用户配置引用，存平台 PostgreSQL（`packages/db`）。
- 安全边界、密钥封套、机器身份复用既有 `12-control-plane-security.md`、`secret-envelope`、`server-protocol`。

## 四、平台侧改动清单（Runtime Boundary 适配）

原有 "Bairui Runtime Boundary（围绕 Hermes 的平台适配器）" 重构为 **"引擎适配层（Engine Adapter Layer）"**，接口不变、实现切换：

| 平台能力 | 对 Hermes 的旧实现 | 对 pi/dsh 的新实现 |
| --- | --- | --- |
| 实例化 / 编排 | 基于 Hermes 镜像 | 基于 `engine` 选择 pi 或 dsh 镜像，注入 manifest 配置 |
| 对话前端 | Hermes UI | dsh web profile UI / pi 托管 UI（模板 `ui.kind` 决定） |
| 模型调用 | Hermes 模型层 | pi `pi-ai` / dsh 模型适配器（用户自配 Key） |
| 工具执行 | Hermes 工具 | pi extensions / dsh 插件树（含 MCP） |
| 记忆 | Hermes 记忆 | dsh session-log 投影 / pi 配置化记忆（对齐 `18` 号文档投影） |
| 可观测 | Hermes 遥测 | dsh telemetry 事件 / pi 遥测（对齐 `17` 号文档） |
| 渠道 | OpenClaw 候选 | 复用 `23-durable-channel-bridge.md`，Channel Worker 不变 |

> 引擎适配层应保持**单一接口**（`spawn(manifest) / stop(agentId) / health(agentId) / route(agentId)`），把 pi 与 dsh 的差异封装在适配器内部，平台上层（控制面、console、server-agent）不感知引擎差异。接口精确契约、镜像与环境变量注入、数据库迁移、渠道/可观测映射见 **`28-dual-engine-platform-build-specs.md`**（落地规格）。

## 五、演进路线

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 确认模板 manifest schema；`console-mvp` 模板库展示双引擎模板（mock） | 模板库页可浏览/筛选/一键创建（mock 状态流转） |
| P1 | 引擎适配层接口落地：pi 与 dsh 各出 1 个官方模板容器镜像；`spawn/health/route` 打通 | 真实拉起 1 个 dsh 对话型实例 + 1 个 pi 任务型实例，独立子域可访问 |
| P2 | 模板市场：官方 + 引擎生态 + 用户模板；版本化发布 | 用户可 fork 模板、发布、一键创建 |
| P3 | 多引擎规模化：Docker Swarm 编排（沿用 `25` 号 §3 基线）、隔离与配额 | 多租户多实例稳定运行，隔离/配额生效 |

## 六、与既有文档的关系

- `25-agent-runtime-env-and-request-routing.md`：路由、域名、实例模型**不变**，本文为其"本体实现"补充说明；
- `20-platform-agent-integration-guide.md`：跨仓集成契约的"Agent 本体侧"从 Hermes 替换为 pi/dsh，接口契约字段（agent_id、status、embedUrl）不变；
- `docs/README.md`：索引以本文为准，Hermes 专项设定文档（03/18/21/能力地图）已随本体切换移除。

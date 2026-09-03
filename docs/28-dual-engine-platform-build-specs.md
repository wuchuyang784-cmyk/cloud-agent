# 双引擎平台建设设定清单（pi-agent + deepseek-harness 落地规格）

> 状态：落地规格（承接 `27` 号架构决策）
> 适用范围：平台控制台（管理面）+ 引擎适配层（运行时边界）+ 部署编排（infra）
> 关联文档：`27-agent-runtime-template-strategy.md`（策略与模板体系）、`25-agent-runtime-env-and-request-routing.md`（路由与独立域名基线，不变）、`14-multi-tenant-agent-runtime.md`（多租户边界）、`docs/README.md`（文档索引）
> 文档定位：`27` 号确定了"本体换成 pi-agent + deepseek-harness、模板化一键创建"的**决策与方向**；本文把决策落到**可执行的平台建设设定**——数据模型（SQL）、引擎适配契约、部署编排、模型与凭证、渠道、前端、安全、可观测 八项，逐项给出字段、接口与验收。凡本文未提及的既有能力（控制面协议、密钥封套、Channel Worker、记忆 outbox 等）均复用不变。

## 一、数据模型设定（PostgreSQL 迁移 022）

> 现有迁移到 `021` 为止（`packages/db/migrations/*.sql`）。本批新增 `022_agent_templates.sql`，全部使用 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`，可重复执行，与既有迁移风格一致（BEGIN/COMMIT + CHECK 约束）。

### 1.1 新表：agent_templates（模板库）

模板是平台一等资源（`27` 号 §3），存声明式 manifest：

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS agent_templates (
  id               text PRIMARY KEY,
  organization_id  text REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = 官方/平台模板
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  engine           text NOT NULL CHECK (engine IN ('pi', 'dsh')),
  manifest         jsonb NOT NULL,           -- 27 号 §3.1 的完整 manifest
  version          integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'published', 'archived')),
  source           text NOT NULL DEFAULT 'official'
                   CHECK (source IN ('official', 'ecosystem', 'user')),
  upstream_ref     text,                     -- 引擎生态模板来源：preset/Bundle 名称+版本
  fork_of          text REFERENCES agent_templates(id) ON DELETE SET NULL,
  engine_config    jsonb NOT NULL DEFAULT '{}'::jsonb, -- 拉取/校验缓存的引擎配置快照
  created_by       text REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_templates_lookup_idx
  ON agent_templates (status, engine, source);

CREATE INDEX IF NOT EXISTS agent_templates_org_idx
  ON agent_templates (organization_id) WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_templates_org_name_version_idx
  ON agent_templates (organization_id, name, version)
  WHERE organization_id IS NOT NULL;

COMMIT;
```

要点：

- `organization_id` 为 NULL 表示官方/平台级模板（对所有租户只读）；非空表示用户/组织模板。
- `manifest` 存 `27` 号 §3.1 的完整声明（engineConfig / model / tools / systemPrompt / memory / channels / ui / quota）。
- `engine_config` 为引擎校验结果快照（如 preset 是否存在、profile 是否合法），避免每次创建实例都回查引擎。

### 1.2 agents 表新增列：引擎绑定

`agents` 表既有列见 `001`（id/organization_id/name/description/status/created_at）与 `005`（owner_user_id/soul_markdown/initialization_status/desired_runtime_state/settings/last_error_code 等）。新增引擎与模板绑定：

```sql
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'dsh'
    CHECK (engine IN ('pi', 'dsh')),
  ADD COLUMN IF NOT EXISTS template_id text REFERENCES agent_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_version integer;
```

- `engine`：本实例运行本体，由创建时的模板决定，创建后不可变（模板可换版本，引擎不换）。
- `template_id` + `template_version`：实例与模板的**版本绑定**；升级模板 = 更新这两个字段并走实例重启（`25` 号 §4 启动流程）。
- 实例私有配置（用户 API Key 引用、渠道绑定、业务配置）继续落 `agents.settings`（jsonb，已有），模板只含公共规格。

### 1.3 新表：agent_template_installs（模板派生/订阅）

记录"用户基于某模板一键创建实例"的派生关系，支撑模板市场统计与升级提示：

```sql
CREATE TABLE IF NOT EXISTS agent_template_installs (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id      text NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
  agent_id         text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  template_version integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id)
);
```

### 1.4 新表：agent_engine_runs（引擎运行记录）

记录每次引擎实例的 spawn/stop 状态机，供网关路由、控制面与运维观测：

```sql
CREATE TABLE IF NOT EXISTS agent_engine_runs (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id         text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  engine           text NOT NULL CHECK (engine IN ('pi', 'dsh')),
  template_version integer NOT NULL,
  status           text NOT NULL DEFAULT 'initializing'
                   CHECK (status IN ('initializing', 'running', 'degraded', 'stopped', 'failed', 'deleting')),
  container_ref    text,                      -- 容器/服务引用（Swarm service 名、container id）
  runtime_url      text,                      -- 内部反代地址（http://host:port）
  subdomain        text NOT NULL,             -- agent-{id}.bairui.app（25 号 §3.1）
  engine_pid       integer,
  last_error_code  text,
  last_error_detail text,
  desired_state    text NOT NULL DEFAULT 'stopped'
                   CHECK (desired_state IN ('running', 'stopped', 'deleting')),
  started_at       timestamptz,
  stopped_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_engine_runs_agent_latest_idx
  ON agent_engine_runs (agent_id, created_at DESC);
```

要点：

- `subdomain` 创建后**永久绑定** `agent_id`（`25` 号 §3 基线），容器重建只更新 `container_ref` / `runtime_url`。
- `desired_state` 与 `agents.desired_runtime_state`（005 已有）双写：`agents` 表面向控制面语义，本表面向引擎执行语义。
- 网关按 `agents.engine` + 本表最新 `runtime_url` 分发到对应引擎容器。

### 1.5 记忆改造：obsidian 投影 → 引擎无关投影

既有 `obsidian_notes`（`003`）与 `015_hermes_obsidian_memory.sql` 的 `hermes_*` 列绑定 Hermes。改造设定：

1. **`015` 的 `hermes_*` 列标记为兼容遗留（deprecated）**：不改名、不删列（避免破坏既有数据），新代码不再写入；既有投影数据在 retention 窗口（`011`）内自然退役。
2. **新增引擎无关的记忆投影目标表**（在 `022` 中）：

```sql
CREATE TABLE IF NOT EXISTS agent_memory_entries (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id         text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  engine           text NOT NULL CHECK (engine IN ('pi', 'dsh')),
  kind             text NOT NULL DEFAULT 'knowledge'
                   CHECK (kind IN ('knowledge','fact','preference','constraint','procedure','person','project','event')),
  content          text NOT NULL,
  importance       smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source           text NOT NULL CHECK (source IN ('session-log', 'config', 'platform')),
  retention_days   integer,                    -- NULL = 跟随模板 memory.retentionDays
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_memory_entries_agent_idx
  ON agent_memory_entries (agent_id, importance DESC, updated_at DESC);
```

3. **投影管道复用 `memory_projection_outbox`（`017`）**：队列结构不变，仅 `reason` 枚举扩展：
   - `dsh_session_projection`：dsh session logs → 平台 → `agent_memory_entries`（dsh 会话日志为权威源，`27` 号 §2.2 的 transcript authority 基线）；
   - `pi_memory_projection`：pi 配置化记忆 → `agent_memory_entries`。
4. **保留 `obsidian_notes`**：用户知识库/笔记场景仍可用，不再作为 Agent 记忆权威源。

## 二、引擎适配层接口契约（Runtime Boundary）

`27` 号 §4 确定：Bairui Runtime Boundary 重构为**引擎适配层（Engine Adapter Layer）**，单一接口，pi/dsh 差异封装在适配器内部。本设定给出精确契约（落点在 `bairui-agent` 仓的 bridge 模块，接口名与 `25`/`20` 号文档既有字段保持一致）：

```ts
// packages/engine-adapter/types.ts（平台侧类型，供 control plane + server-agent 共用）
export type EngineKind = 'pi' | 'dsh';

export interface AgentInstanceSpec {
  agentId: string;
  engine: EngineKind;
  template: { manifest: unknown; version: number }; // 已解析并校验的 manifest
  config: {
    providerKeyRef?: string;   // 用户自配 Key 的封套引用（不落明文，14 号边界）
    channels: string[];        // 渠道绑定 id（agent_channel_bindings）
    subdomain: string;         // agent-{id}.bairui.app
  };
}

export interface SpawnResult {
  containerRef: string;        // Swarm service / 容器 id
  runtimeUrl: string;          // 内部反代地址
  status: 'running' | 'degraded';
}

export interface HealthResult {
  status: 'running' | 'degraded' | 'offline' | 'unknown';
  enginePid?: number;
  resource?: { cpuPercent: number; memoryUsedBytes: number }; // 对齐 012 字段
}

export interface EngineAdapter {
  readonly engine: EngineKind;
  spawn(spec: AgentInstanceSpec): Promise<SpawnResult>;
  stop(agentId: string): Promise<void>;
  health(agentId: string): Promise<HealthResult>;
  route(agentId: string): Promise<string>;   // 返回当前 runtimeUrl，供网关反代
  validate(manifest: unknown): Promise<{ ok: boolean; errors: string[] }>;
}
```

适配器实现要点：

| 能力 | pi 适配器 | dsh 适配器 |
| --- | --- | --- |
| spawn 注入 | 镜像内 `pi-agent-core` headless + 注入 manifest（model/tools/systemPrompt） | 镜像内 `dsh web`/`headless` profile + preset/Bundle 注入 |
| 前端承载 | 平台托管 UI 壳（模板 `ui.kind=pi-hosted`） | dsh web profile 自带 UI |
| 模型 | `pi-ai`（DeepSeek/Claude/OpenAI，用户 Key） | dsh 模型适配器插件（默认 deepseek，模板显式配置多模型） |
| 工具 | extensions + MCP 挂载 | 插件树 + 工具注册表 |
| 记忆 | 配置化记忆 → `agent_memory_entries` | session logs → 投影 → `agent_memory_entries` |
| 安全 seam | 容器层沙箱（§七） | `ctx.sandbox` / `ctx.fs` / `ctx.shell` 注入租户策略（§七） |
| 事件映射 | 遥测适配器 → §八 schema | `session/event`、`agent/*`、`telemetry/*` → §八 schema |

> 平台上层（control plane、console、server-agent、Channel Worker）只依赖 `EngineAdapter` 接口，不感知引擎差异。

## 三、部署编排设定（infra）

`25` 号 §3 已定：每 Agent 启动 = 独立容器实例 + 永久子域；MVP 直接拉容器，规模化走 Docker Swarm。本设定补齐镜像与环境变量契约。

### 3.1 引擎基线镜像（新增）

| 镜像 | 内容 | 对应引擎 |
| --- | --- | --- |
| `bairui-agent-pi` | `pi-agent-core` headless + 平台注入侧 + 托管 UI 壳 | pi |
| `bairui-agent-dsh` | `dsh`（web/headless profile）+ 平台注入侧 | dsh |

构建参数：`ENGINE_IMAGE_TAG`（对应 `27` 号 P1 里程碑）。镜像由 `bairui-agent` 仓 CI 构建推送，平台 infra 引用。

### 3.2 环境变量注入契约（每实例）

平台 spawn 时按引擎注入（全部来自 `agents.settings` 解析 + 密钥封套引用，明文不落库）：

```
公共（两引擎一致）：
  AGENT_ID=<agent_id>
  AGENT_ENGINE=pi|dsh
  SUBDOMAIN=agent-<id>.bairui.app
  RUNTIME_URL=http://<container>:<port>      # 内部回传
  RUNTIME_SHARED_SECRET=<shared_secret>      # 与平台通信鉴权（25 号 / 12 号）
  TEMPLATE_MANIFEST=<manifest json>          # 27 号 §3.1 渲染后（密钥为引用）
pi：
  PI_PROVIDER=<deepseek|claude|openai>
  PI_MODEL=<model>
  PI_API_KEY=<key>                            # 来自封套解密，仅注入运行时
dsh：
  DSH_PROFILE=web|headless
  DSH_PRESET=<preset>
  DSH_BUNDLE=<bundle-ref>                     # 可选
  DSH_MODEL_ADAPTER=<deepseek|claude|openai>
  DSH_API_KEY=<key>
```

### 3.3 docker-compose 扩展

- **静态基础设施不变**：`infra/docker-compose.yml` 仅含 postgres + platform（现状即可）。
- **Agent 实例不进静态 compose**：由编排器按 `agent_id` 动态创建（MVP 阶段 `docker run`，规模化阶段 `docker service create --replicas 1`），镜像为 §3.1 的基线镜像。
- `infra/server-agent.env.example` 增加：`BAIRUI_ENGINE_PI_IMAGE`、`BAIRUI_ENGINE_DSH_IMAGE`（默认 `bairui-agent-pi:local` / `bairui-agent-dsh:local`）、`BAIRUI_AGENT_SUBDOMAIN_TEMPLATE=agent-%s.bairui.app`。

### 3.4 网关路由设定（不变，补 engine 维度）

网关按 `Host: agent-{id}.bairui.app` 取 `{id}` → 查 `agents.engine` + `agent_engine_runs` 最新 `runtime_url` → 反代。域名、TLS、鉴权完全沿用 `25` 号 §3.1/§3.2。

## 四、模型与凭证设定

### 4.1 模型 Provider 配置（复用 + 扩展）

- **组织级模型通道**：复用 `provider_configurations`（`003`）与 `provider_channels`（`009`）。两表均以 `provider` 字段区分厂商，新增枚举映射设定：`provider IN ('deepseek','claude','openai')` 两引擎都支持；pi 走 `pi-ai` 统一 LLM API，dsh 走模型适配器插件。
- **模型策略**：复用 `model_policies`（`019` 已默认 `user_custom_keys_allowed=true`），按模板 `model.providers` 白名单约束用户可自配的厂商。

### 4.2 用户自配 Key 注入（复用 14 号边界）

- 用户 Key 存**实例私有**（`agents.settings` 中的封套引用，`secret-references` / `server-credentials` 机制复用），**不落模板、不落 manifest**（`27` 号 §3.4）。
- spawn 时由平台解密注入运行时环境（§3.2），凭据**不出浏览器响应**（`14` 号多租户边界）。

### 4.3 模板校验器（新增代码，非 DB）

`packages/templates/` 新增 manifest 校验器：校验 `engine` ∈ {pi, dsh}、`engineConfig` 引用的 preset/profile/Bundle 在引擎 registry 中存在、`model.providers` 非空、`quota` 数值合法。校验结果写入 `agent_templates.engine_config` 快照。

## 五、渠道设定

复用 `agent_channel_bindings`（`008`，channel 枚举 `web/cli/feishu/wechat/qq` 不变）与 `provider_channels`（`009`）：

- **web 渠道**：对话在独立子域（`25` 号 §2.1），无需额外绑定动作。
- **feishu 等外部渠道**：绑定沿用 `23-durable-channel-bridge.md` 的 Channel Worker，**不变**；仅运行时目标从 Hermes 换为引擎容器。
- **引擎与渠道映射**（模板 `channels` 声明，适配器负责执行）：

| 模板声明渠道 | pi 实现 | dsh 实现 |
| --- | --- | --- |
| web | 托管 UI 壳 | dsh web profile |
| feishu | extensions/适配 | dsh feishu 插件 |
| cli | pi CLI 入口 | dsh headless runner |

## 六、前端控制台设定（apps/console-mvp）

### 6.1 新增页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/templates` | 模板库 | 浏览/筛选（engine、场景、工具）、搜索；卡片标注引擎徽标（pi/dsh） |
| `/templates/:id` | 模板详情 | manifest 只读展示（模型/工具/记忆/配额）+「一键创建」+「Fork」 |
| `/agents/:id/config` | 实例配置页 | 用户自配 API Key（封套）、渠道绑定、模型选择（按模板白名单） |
| `/agents/:id` | 实例详情 | 状态、独立子域链接（`agent-{id}.bairui.app`）、启停操作 |

### 6.2 新增 API 契约（apps/console-mvp/src/api.ts）

```
GET    /api/templates?engine=pi|dsh&status=published     # 模板库
GET    /api/templates/:id                                 # 模板详情（含 manifest）
POST   /api/agents      { templateId, name, config }      # 一键创建 → 返回 { id, subdomain, status }
GET    /api/agents/:id                                    # 实例状态 + subdomain
POST   /api/agents/:id/start | /stop                      # 启停（25 号 §4 动作）
POST   /api/templates/:id/fork    { name }                # 派生用户模板（P2）
```

- 一键创建流程对齐 `27` 号 §3.3：后端解析 manifest → 校验 → 落 `agent_templates`/`agent_template_installs`/`agents` → spawn → 返回独立子域。
- 现有 `App.tsx` 的 pi/dsh mock 模板数据改为 `GET /api/templates` 驱动（P0 即可接）。

## 七、安全与隔离设定

| 层面 | 设定 | 依据 |
| --- | --- | --- |
| 容器沙箱 | pi 无内置权限系统 → **容器层隔离**（非 root、只读根文件系统、网络隔离、cgroup 资源限制），复用 `19-remote-browser-acceptance.md` 容器编排基线 | `27` 号 §2.1 |
| dsh 能力 seam | 在 `ctx.sandbox` / `ctx.fs` / `ctx.shell` / `ctx.terminals` 注入**租户策略对象**（路径白名单、命令白名单、网络域名白名单）；web profile 的浏览器操作进沙箱 | `27` 号 §2.2 |
| 密钥 | 封套机制（`secret-references`/`server-credentials`/`12` 号）复用；Key 只经平台解密注入运行时，不出浏览器 | `14` 号 |
| 多租户 | 1 Agent = 1 容器 = 1 子域，配置/会话/资源按域隔离（`25` 号 §3.2） | `25` 号 |
| 配额 | 模板 `quota`（concurrentSessions / maxTokensPerDay）由适配层在 spawn/route 时校验并上报 `usage_rollups` | `27` 号 §3.1 |

## 八、可观测设定

- **复用既有 schema**：`telemetry_events`、`usage_rollups`、`agent_resource_samples`（`012`）结构不变，仅来源标注引擎。
- **dsh 事件映射**（`session/event`、`agent/*`、`tools/*`、`telemetry/*`）：

| dsh 事件 | 平台落点 |
| --- | --- |
| `session/event`（run 开始/结束） | `agent_engine_runs` 状态 + `telemetry_events` |
| `agent/*`（行为/步骤） | `telemetry_events`（reason 前缀 `dsh.`） |
| `tools/*` | `usage_rollups`（按工具聚合） |
| `telemetry/*`（token/延迟） | `usage_rollups` + `agent_resource_samples` |

- **pi 遥测**：由适配器收集（token、步骤、资源）映射到同一 schema（reason 前缀 `pi.`）。
- 资源采集（cpu/mem/storage/os）对齐 `agent_resource_samples` 字段，`26` 号总览仪表盘无需改 schema。

## 九、执行顺序与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | `022_agent_templates.sql` 落地（1.1–1.4 + 1.5 记忆表）；`packages/templates/` manifest 校验器；console 模板库 + 一键创建接 `GET/POST /api/templates*`（真数据，非 mock） | 模板可发布、创建实例落库（`agent_templates`/`agents.engine`/`agent_template_installs`），控制台模板库/详情/实例配置页可用 |
| P1 | 引擎适配层接口 + pi/dsh 适配器；两个基线镜像；spawn/stop/health/route 打通；记忆投影（dsh session-log → outbox → `agent_memory_entries`） | 真实拉起 1 个 dsh 对话型 + 1 个 pi 任务型实例，独立子域可访问、可启停，记忆投影落库 |
| P2 | 模板市场（fork/发布/版本化）；渠道绑定按引擎生效；`015` 遗留列完全停写 | 用户可 fork 模板并发布，feishu/web 渠道在新引擎下可用 |
| P3 | 规模化：Docker Swarm 动态 service（副本 1）、冷启动、配额、多节点调度；`agent_engine_runs` 成为运维权威视图 | 多租户多实例稳定运行，隔离/配额生效，`26` 号仪表盘数据正常 |

## 十、与既有文档的关系

- `27` 号：本文的**上层策略**（模板体系、引擎分工、演进路线）——本文把其 §四 改动清单落到字段与契约。
- `25` 号：路由、独立域名、1 Agent = 1 容器 基线**不变**，本文仅补 engine 维度（§3.4）。
- `20` 号：跨仓集成契约字段（agent_id/status/embedUrl）不变，本体侧实现切换由本文 §二 覆盖。
- `14` 号 / `17` 号 / `18` 号 / `23` 号：多租户边界、遥测、记忆投影管道、渠道桥**均复用**，本文只做扩展标注（记忆 reason、遥测前缀）。
- `docs/README.md`：索引新增本文；`015` 迁移在本文 §1.5 标记为兼容遗留。

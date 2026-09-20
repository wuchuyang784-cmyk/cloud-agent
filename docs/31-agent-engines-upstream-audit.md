# 31 上游引擎接入核对（pi / dsh）

> 本文件是 `docs/README.md`「上游引擎子模块」与 `28-dual-engine-platform-build-specs.md` §3 的**源码级事实基线**：记录两个引擎本体的真实入口、配置/凭据机制、数据目录与版本 pin，并给出平台 spawn env 与引擎真实消费形式的映射结论。
> 上游会演进：任何断言都有核对时间与 pin 提交，升级 pin 前按本文 §6 复核对账。

## 1. 核对目的与方法

- **目的**：为「bairui-agent-pi / bairui-agent-dsh 自建镜像 + 平台注入侧 wrapper」（`28` 号 §3）提供实现依据，消除以文档推断冒充上游事实的风险（此前 `28` 号 §3.2 的 `PI_API_KEY` 等即属此类）。
- **方法**：以本地子模块源码为主、上游官方文档为辅逐条核对；每条结论附证据路径；无法在源码确认的项明确标「B2 待定」。
- **核对时间**：2026-09-08。
- **复核修正（2026-09-09）**：§4.3 遥测 env 改为以 `DSH_TELEMETRY_MODE` 为主控（base bundle 默认 `FEEDBACK_ONLY`，非静默）；§4.4 凭据注入核实为 `DEEPSEEK_API_KEY`（`llm-deepseek` 默认 `apiKeyEnv`），据此解除 B2-4 的 env 名部分、同步校正 §5 契约表与 `28` §3.2 注释。
- **复核修正（2026-09-11）**：B2-1 已钉——pi RPC 事件 schema 以 `packages/coding-agent/docs/rpc.md` 为准，已实装于平台 wrapper（`apps/platform-api/src/runtime/pi/wrapper.mjs`，处理 `response`/`message_update`(`assistantMessageEvent.text_delta`+`usage`)/`message_end`/`agent_settled`/`extension_error`）；同批落地 `bairui-agent-pi:0.85.1` 基线镜像（构建成功 + 容器冒烟通过），实现状态见 `28` §3.5。
- **依据 pin（与 `docs/README.md` 一致）**：

| 引擎 | 子模块 | pin | 上游版本锚点 |
| --- | --- | --- | --- |
| pi | `upstreams/pi` | `c1d4c801114545f47c440921d8b3e04aeb1e565d` | coding-agent 0.85.1；monorepo root 0.0.3 |
| dsh | `upstreams/dsh` | `b0a7d2ce3b4c19d7452e364b2d7acbfa87e707ed` | `@deepseek-ai/dsh-root` / CLI 0.1.3-alpha.2 |

## 2. 引擎速览对比

| 维度 | pi-agent（earendil-works/pi） | deepseek-harness（dsh） |
| --- | --- | --- |
| 包形态 | npm workspaces（`packages/*`），Node ≥ 22.19 | pnpm workspaces，Node ^22.19 ‖ ≥ 24，pnpm@11.7 |
| CLI bin | `pi`（`@earendil-works/pi-coding-agent` 提供） | `dsh`（`@deepseek-ai/dsh` 提供，bin → `lib/bin.js`） |
| 产品形态 | TUI/CLI 编码 agent，工具原语型 | profile 驱动的插件化 Harness（web/headless/sdk/acp） |
| 官方 Docker 镜像 | 无 | 无（仓库内未发现 Dockerfile/containerization 文档） |
| 对外 HTTP server | 无现成 server 入口（须自建 wrapper） | web profile 自带浏览器 UI/服务（端口/绑定细节 B2 待定） |
| 沙箱 | 无内置权限系统（默认全权限），须容器层隔离 | 插件可注入 `ctx.sandbox/fs/shell`；仓库含 native/landlock-run（Linux） |
| 凭据机制 | 真实 provider env（`DEEPSEEK_API_KEY` 等）或 `~/.pi/agent` auth 存储 | 默认 DeepSeek，模型层为适配器插件（deepseek/pi-ai/replay/mock） |
| 数据根目录 | `~/.pi/agent`（官方容器化以 volume 持久化） | 默认 `~/.dsh`，可被 `DSH_HOME` 覆盖 |

## 3. pi-agent 事实清单

### 3.1 运行挂载点（镜像侧候选）

| 挂载点 | 形态 | 证据 |
| --- | --- | --- |
| CLI `pi` | `@earendil-works/pi-coding-agent` 的 bin，单次任务可用 `pi -p "<prompt>"`（非交互） | `upstreams/pi/packages/coding-agent/package.json`（bin/exports）；`.../docs/containerization.md`（`sbx exec -- pi -p …`） |
| 运行 mode | 源码 `src/modes/` 含 `interactive/`、`rpc/`、`json-event.ts`、`print-mode.ts`（非 TUI 的结构化输出/一次性打印） | `upstreams/pi/packages/coding-agent/src/modes/` |
| RPC 入口 | 包导出 `./rpc-entry` → `dist/bundle/rpc-entry.js`，源码 `src/rpc-entry.ts`；根仓另有 `profile:rpc` 脚本 | `packages/coding-agent/package.json`（exports）；`src/rpc-entry.ts`；monorepo `package.json` |
| SDK 内嵌 | `@earendil-works/pi-agent-core` 0.85.1，Node 内跑 agent 循环（wrapper 次选方案） | `packages/coding-agent/package.json`（dependencies） |
| HTTP server | **未发现可复用为对外 API 的 server**（`@earendil-works/pi-server` 在 devDeps，主要服务本地 UI 链路），须平台自建 wrapper | `packages/coding-agent/package.json`（devDependencies） |

### 3.2 凭据与配置

- **provider → 真实 env key**（`pi-ai` 层按 provider 发现 env）：`deepseek→DEEPSEEK_API_KEY`、`openai→OPENAI_API_KEY`、`anthropic→ANTHROPIC_AUTH_TOKEN/ANTHROPIC_OAUTH_TOKEN/ANTHROPIC_API_KEY`（含 many 其他 provider：openrouter、groq、xai…）。证据：`upstreams/pi/packages/ai/src/env-api-keys.ts`；provider 实现如 `packages/ai/src/providers/deepseek.ts`。
- **配置/会话/auth 位置**：`~/.pi/agent`（容器内 `/root/.pi/agent`）；官方 Plain Docker 用 named volume 持久化 settings/sessions/auth。证据：`packages/coding-agent/docs/containerization.md`。
- **不存在** `PI_API_KEY`/`PI_PROVIDER`/`PI_MODEL` 这类**启动级** env——`PI_PROVIDER/PI_MODEL` 只是 pi 注入给 shell 工具的会话标记变量，不是 provider/model 选择配置（依据 pi.dev 官方 Environment variables/Providers 文档）。auth 文件读取优先序、`auth.json` schema 细节 → **B2 待定**。
- 自配 key 也可经 `~/.pi/agent/auth.json`（CLI 侧 auth 存储实现位于 `packages/coding-agent/src/core/auth-storage.ts`、`runtime-credentials.ts`）→ 具体格式 B2 待定。

### 3.3 沙箱与隔离

- 官方明示 **pi 默认以启动用户全权限运行**（"Pi runs with all permissions by default"），无内置 sandbox；隔离须容器/工具路由层做。证据：`packages/coding-agent/docs/containerization.md`（并引用 `security.md#no-built-in-sandbox`）。
- 官方容器化仅给模式建议与 Dockerfile 样例（`node:24-bookworm-slim` + `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` + `ENTRYPOINT ["pi"]`），**无官方发布镜像**；另有第三方 sandbox kit `docker.io/sbx/pi-kit:latest`。

### 3.4 结论

`bairui-agent-pi` 必须**自建镜像**，且在镜像内带**平台注入侧 wrapper**；pi 版本必须 pin（上游 npm 版本随 main 演进，本仓以 gitlink pin + build 时版本锁双重约束）。

## 4. dsh（deepseek-harness）事实清单

### 4.1 CLI 与运行形态

- 顶层命令解析：`dsh` 只解析自己拥有的 launcher flags（`--profile <name>`、`--patch <file>`、`--dump-config`/`--dump-default-config`、`web` 是 `--profile web` 的别名；`plugin` 子命令转发给 pnpm），**其后的参数原样交给被拉起 profile 的应用插件**。证据：`upstreams/dsh/apps/cli/src/args.ts`、`bin.ts`。
- **headless 一次性任务**是官方用法：`dsh --profile headless "run the tests"`（答一个任务、打印结果、退出）。证据：`apps/cli/src/args.ts` 帮助文本。
- `dsh web --help` 打印 web app 自己的 flags（端口/绑定待其 CLI 定稿，见 B2）。

### 4.2 Profile / Bundle / Preset 机制（对应模板体系）

- **Profile = `$DSH_HOME/profiles/<name>` 目录**，含 `package.json`（`dsh.profile.bundles` 有序 bundle 层列表）与 `cordis.patch.yml`（用户 patch 层，最后叠加）。证据：`upstreams/dsh/packages/boot/app-boot/src/profile.ts`。
- 内置 profile 模板（首次使用自动初始化）：`acp`(base+acp-app)、`web`(base+web-app)、`headless`(base+headless)、`sdk`(base+sdk-app)、`sdk-minimal`(sdk-minimal)。证据：`.../profile.ts`（`PROFILE_TEMPLATES`）。
- **Bundle** = 声明 `dsh.bundle.patch` 的 npm 包；本仓 bundle 包如 `packages/bundle/{base,web-app,headless,sdk-app,sdk-minimal,acp-app}/cordis.patch.yml`。平台/模板的 `bundle` 引用最终要落成 profile 的 `dsh.profile.bundles` + 依赖安装。证据：`profile.ts`（ProfileLayer）、`packages/bundle/*`。
- **Preset** = `packages/preset/agent-presets/presets` 下的配置树，经 CLI 包 `dsh.configTrees`（mount `config/agent-presets`，scanRoster）扫描。证据：`apps/cli/package.json`（`dsh.configTrees`）。
- `--patch <file>` 可在 profile 自身层之后再叠加平台 patch overlay（**这是平台注入 systemPrompt/模型/工具组合的推荐 seam**）。

### 4.3 数据根目录与真实 env

- 数据根：默认 `~/.dsh`；`DSH_HOME` env 覆盖；全部用户数据（profiles、session、setting）在单根下。证据：`upstreams/dsh/packages/util/home-paths/src/index.ts`（`resolveDshHome`：configured > `$DSH_HOME` > `~/.dsh`，空白视为未设置）。
- 已核实的真实 env：
  - `DSH_TELEMETRY_MODE`：session 遥测主开关，取值 `FEEDBACK_ONLY` / `DISABLED`；**base bundle 默认 `FEEDBACK_ONLY`**（新反馈内容会经 OTel 上传，非静默），平台若要求零外发必须显式设 `DSH_TELEMETRY_MODE=DISABLED`。证据：`upstreams/dsh/packages/session/session-telemetry-otel/src/index.ts`（`SessionTelemetryMode` 枚举 + `DEFAULT_TELEMETRY_MODE`）；`packages/bundle/base/tests/base.spec.ts`（cordis 默认 `process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'`）；`apps/cli/reference/README.md`（deployment stance）。
  - `DSH_TELEMETRY_DISABLED`（任意非空）：早期 pre-load 硬性 opt-out，保留为遗留（勿当作主控）。证据：`.agents/notes/archived/feature/2026-08-10-telemetry-default-off.md`。
  - launcher 的 layered env 加载 `loadLayeredEnv('dsh')`（`apps/cli/src/bin.ts`）。
  - 更多开关清单 → B2 待定。

### 4.4 模型层与凭据

- 模型层是**可插拔 LLM 适配器**：`dsh-llm-deepseek`（默认 DeepSeek）、`dsh-llm-pi-ai`、`dsh-llm-replay`、`dsh-llm-mock-server`（仓库自带 mock LLM 服务器，可用离线验收）。证据：`apps/cli/package.json`（devDependencies）；monorepo `package.json`（`mock:llm`）。
- **DeepSeek provider key 注入方式已核实**：`llm-deepseek` 适配器配置项 `apiKeyEnv` 默认 `DEEPSEEK_API_KEY`，每次请求经凭据 seam 解析——先查 `ctx.credentials`，无命中再回落进程环境变量。证据：`packages/llm/llm-deepseek/src/index.ts`（`DEFAULT_API_KEY_ENV`、`resolveApiKey`）、`packages/llm/llm-deepseek/README.md`。
- 凭据 seam 分层（`@deepseek-ai/dsh-credentials` + `credentials-local`）：单次运行 env override > `$DSH_HOME/.credentials.yaml`（本地私密 YAML，仅存 ref 值，不物化进 `process.env`）> `.env` 层。即平台最简注入 = spawn env `DEEPSEEK_API_KEY=<key>`，**不存在** `DSH_API_KEY`。证据：`packages/credentials/{credentials,credentials-local}/README.md`、`apps/cli/reference/README.md`。
- web/headless 的 deepseek onboarding e2e 围绕上述 DeepSeek provider 配置展开；`--patch` 最小模板与离线 `mock:llm` 验收细节 → B2 待定。

### 4.5 容器化现状

- 仓库内**未发现 Dockerfile/containerization 文档** → 与 pi 相同：基线镜像须自建，dsh CLI 以全局/卷内安装 + `DSH_HOME` 指向实例卷的方式运行。
- 桌面/Web/CLI 三形态同仓（`apps/{desktop,web,cli}`）；`native/landlock-run` 是 Linux 权限隔离原生件（可选启用，非必需）。

## 5. 凭据与配置注入契约（校正 docs/28 §3.2 的依据）

原则：**平台 spawn env 全部是「镜像内 wrapper 的输入」，不是引擎自身读的变量**。wrapper 负责翻译为引擎真实消费形式：

| 平台注入（wrapper 输入） | pi 侧真实消费 | dsh 侧真实消费 |
| --- | --- | --- |
| 模型提供方/模型选择 | wrapper 用它选 model、落 `~/.pi/agent` auth/设置或 CLI 参数；`PI_PROVIDER/PI_MODEL` 不冒充启动配置 | wrapper 用它生成 profile bundles/cordis patch 里的模型行 |
| 用户 API Key（封套解密后） | wrapper 以**真实 provider env**（`DEEPSEEK_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`…）或 auth 文件注入 | wrapper 以 spawn env **`DEEPSEEK_API_KEY`** 注入（`llm-deepseek` 默认 `apiKeyEnv`，credential seam → env 回落）或物化 `$DSH_HOME/.credentials.yaml`；**不存在** `DSH_API_KEY` 之类上游变量 |
| Profile/Preset/Bundle | — | wrapper 在 `$DSH_HOME/profiles/<name>` 物化 profile（`dsh.profile.bundles` + `cordis.patch.yml`），必要时追加 `--patch` overlay |
| 数据根目录 | 持久化卷挂到 `~/.pi/agent` | 持久化卷作为 `$DSH_HOME`（单根） |

`28` 号 §3.2 需据此改写（本文件即改动依据），重点：

1. 删除/降级 `PI_API_KEY`：改为「真实 provider env 名（上游 `env-api-keys.ts` 实测）」或「wrapper 写 auth 存储」两种注入形式。
2. `PI_PROVIDER/PI_MODEL` 明确为 wrapper 内部输入，勿标注为 pi 读取。
3. dsh 侧 `DSH_PROFILE/DSH_PRESET/DSH_BUNDLE/DSH_MODEL_ADAPTER/DSH_API_KEY` 明确为 wrapper 输入，其真实落点见上表；上游真实变量仅有 `DSH_HOME`、`DSH_TELEMETRY_MODE`（主控，默认 `FEEDBACK_ONLY`）等少量已核实项（遗留 `DSH_TELEMETRY_DISABLED` 为 pre-load 硬 opt-out，见 §4.3）。
4. 两镜像均标注「上游无官方镜像/无官方 containerization（dsh）」，Dockerfile 自建且引擎版本必须 lock。

## 6. 对既有文档的影响与待办

- 校正对象：`28-dual-engine-platform-build-specs.md` §3.1（镜像内容行）、§3.2（env 注入契约）；`docs/README.md`（子模块节补 audit 指针 + 规范表加本文件行）。
- **B2 待定清单（镜像侧实现前需钉死）**：
  1. ~~pi `rpc-entry`/`json-event` 的事件 schema 与调用样例~~ **已钉（2026-09-11）**：以 `packages/coding-agent/docs/rpc.md` 为准，wrapper 已实装 `response`/`message_update`/`message_end`/`agent_settled` 事件处理，见 `apps/platform-api/src/runtime/pi/wrapper.mjs`。
  2. pi `~/.pi/agent/auth.json` 读取顺序与格式（`auth-storage.ts`/`runtime-credentials.ts`）。
  3. dsh web profile 的监听端口/绑定 env 与 `dsh web` 应用 flags（`@deepseek-ai/dsh-web-app`/host-webserver）。
  4. dsh `--patch` 最小模板样例与离线 `mock:llm` 验收脚本（provider key env 已核实为 `DEEPSEEK_API_KEY`，见 §4.4）。
  5. dsh 会话日志目录（`session-persistence-jsonl` 等）与记忆投影对接点。

升级任一 pin 时：重跑本文 §3/§4 证据路径（尤其 package.json、modes、env-api-keys、profile.ts、home-paths），核对后再更新基线镜像与本文。

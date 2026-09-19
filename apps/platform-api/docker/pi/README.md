# bairui-agent-pi 基线镜像（P1 容器化接入）

> docs/32 §3.1 阶段 A：平台已不再自行 `docker run` 拉起实例，也不再挂载宿主
> docker.sock。本镜像改作**外部编排系统**（K8s / Swarm / 运行时池）拉起 Agent
> Runtime 实例的镜像源，平台侧以 `BAIRUI_RUNTIME_DRIVER=remote` 请求拉起并登记
> 实例 `runtimeUrl`、负责巡检与回收。开发 / CI 用 local 形态（本机 wrapper 子进程）
> 即可，无需本镜像、无需 Docker daemon。

自建镜像（pi 上游无官方镜像，docs/31 §3.2），镜像内包含平台 wrapper 与
`@earendil-works/pi-coding-agent`（`pi --mode rpc` 常驻）。

## 构建（需要 Docker daemon）

```powershell
cd e:/cloud-agent
docker build -f apps/platform-api/docker/pi/Dockerfile -t bairui-agent-pi:0.85.1 .
```

构建时可用 `--build-arg PI_VERSION=0.85.1` 与 `--build-arg NPM_REGISTRY=...` 覆盖版本与源。

受限网络（无法直连 docker.io）用国内镜像源覆盖基础镜像：

```powershell
docker build -f apps/platform-api/docker/pi/Dockerfile `
  --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim `
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com `
  -t bairui-agent-pi:0.85.1 .
```

已验证（2026-09-11）：镜像构建成功；`docker run` 后 `/healthz` 返回健康；容器内
`pi --version` = 0.85.1，`rg`/`git`/`node` 齐备；向容器 `/v1/tasks` 发送信封签名任务时，
`pi` 实跑并返回 `No API key found for the selected model`——证明 wrapper→`pi --mode rpc`
链路通，真实 LLM 对话需注入 `DEEPSEEK_API_KEY` 等官方 provider env。

已验证（2026-09-12，**历史形态**：平台直接 `docker run`）：注入 `DEEPSEEK_API_KEY`
后，docker 形态真实对话跑通——
`PiEngineAdapter(image=bairui-agent-pi:0.85.1)` 拉起容器，`/v1/tasks` 返回真实回复
（含 `12*8=96`，usage 1678 tokens，模型耗时约 2.7s），`stop` 后容器随 `--rm` 自动移除。
同轮修复了 wrapper 的 `new_session` 竞态：pi 的 `new_session` 是异步的，必须等其
`response` 返回后再发 `prompt`，否则 prompt 会在会话重置窗口内被丢弃、模型永不执行
（表现为一直等到 `task_timeout`）。

## 本地 smoke（无需 Docker daemon）

开发/CI 可用 local 形态：`BAIRUI_PI_LOCAL=1` 时 adapter 直接 `node wrapper.mjs`
在平台同机跑，wrapper 内 `pi` 二进制默认取 PATH（可 `PI_BIN` 覆盖；测试可用
`PI_SPAWN_CMD` 指定可执行 argv 以注入 fake pi）。

```powershell
# 一次性安装 pi CLI（npmmirror 源已验证可获取 0.85.1）
npm i -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1

# 平台进程注入真实 provider key 与引擎开关后启动
$env:BAIRUI_PI_LOCAL='1'
$env:DEEPSEEK_API_KEY='<your deepseek key>'
$env:PI_PROVIDER='deepseek'
$env:PI_MODEL='deepseek-chat'
npm run dev --prefix apps/platform-api
```

随后控制台创建 Agent 时选择「Pi 引擎」（engine=pi），就绪后对话即走真实 pi
RPC → DeepSeek 通道（信封签名由平台侧 PiEngineAdapter 下发）。

## 验收清单

1. `docker build ...` 成功（daemon 已启动）。
2. `POST /api/user/agents { name, engine: 'pi' }` → 202；Worker provision 后
   agent.status=ready，且 adapter `health` 为 running。
3. 对话 SSE 收到 `message.completed` 真实回复，余额被扣除、Usage 写入
   `conversation_messages.output_tokens`。
4. 平台重启后（adapter 实例表清空）agent.runtimeUrl 仍指向实例，直接对话可用。

## 备注

- 镜像 context 为仓库根目录（COPY wrapper.mjs）。
- wrapper 是受信实例边界，任务请求带 `x-bairui-*` 信封头（shared secret 校验），
  实现见 `apps/platform-api/src/runtime/pi/wrapper.mjs`。
- 容器内 wrapper 仅通过 RUNTIME_SHARED_SECRET 环境透传密钥，不落盘。

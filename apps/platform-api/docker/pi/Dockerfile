# bairui-agent-pi 基线镜像（docs/27 §P1 / docs/28 §3.1 / docs/31 §5）
# 自建镜像（pi 上游无官方镜像，docs/31 §3.2）：内置平台 wrapper + pi CLI（rpc 模式常驻）。
#
# 构建（context = 仓库根目录，需要 Docker daemon）：
#   docker build -f apps/platform-api/docker/pi/Dockerfile \
#     --build-arg PI_VERSION=0.85.1 \
#     -t bairui-agent-pi:0.85.1 .
#
# 受限网络（无法直连 docker.io）可用镜像源覆盖基础镜像与 npm registry：
#   docker build -f apps/platform-api/docker/pi/Dockerfile \
#     --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     -t bairui-agent-pi:0.85.1 .
#
# 运行时由平台 PiEngineAdapter 以 `docker run` 拉起，向容器注入：
#   AGENT_ID / SUBDOMAIN / RUNTIME_SHARED_SECRET / PI_PROVIDER / PI_MODEL / PI_OFFLINE
#   以及真实 provider key env（DEEPSEEK_API_KEY 等，docs/31 §4.4）。

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG PI_VERSION=0.85.1
ARG NPM_REGISTRY=https://registry.npmmirror.com

# git/ripgrep：pi 工具链在 agent workspace 内做代码检索所需。
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm_config_registry=${NPM_REGISTRY} npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
  && rm -rf /root/.npm /root/.cache

COPY apps/platform-api/src/runtime/pi/wrapper.mjs /app/wrapper.mjs

ENV PI_BIN=pi \
    PORT=8092 \
    PI_OFFLINE=1 \
    PI_TELEMETRY=0

WORKDIR /workspace
EXPOSE 8092

HEALTHCHECK --interval=5s --timeout=2s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8092)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/wrapper.mjs"]

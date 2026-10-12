# F1 source-only release. The context is a validated git archive, not the repo.
ARG BASE_IMAGE=docker.m.daocloud.io/library/node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
FROM ${BASE_IMAGE} AS pi-builder
WORKDIR /opt/pi
ADD pi-source.tar /opt/pi/
COPY model-data /opt/pi/packages/ai/src/providers/data
# No prepare/postinstall or model catalog network generation. Only explicit,
# reviewed compile steps from the fixed source are run.
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm run build:offline \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM ${BASE_IMAGE} AS pi-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --from=pi-builder /opt/pi /opt/pi
COPY production /app/pi/production
COPY provenance.json /app/pi/provenance.json
RUN mkdir -p /workspace /agent-state \
    && chown 1000:1000 /workspace /agent-state
ENV HOME=/agent-state
WORKDIR /workspace
USER 1000:1000
EXPOSE 8092
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
    CMD node -e "try{const c=JSON.parse(require('node:fs').readFileSync('/run/config/pi.json'));if(!Number.isInteger(c.listenPort)||c.listenPort<1||c.listenPort>65535||!['127.0.0.1','0.0.0.0','::1'].includes(c.listenHost))process.exit(1);const h=c.listenHost==='::1'?'[::1]':'127.0.0.1';fetch('http://'+h+':'+c.listenPort+'/readyz',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))}catch{process.exit(1)}"
ENTRYPOINT ["node", "/app/pi/production/index.mjs", "--config", "/run/config/pi.json"]

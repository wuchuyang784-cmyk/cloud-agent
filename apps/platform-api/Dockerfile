FROM node:22-alpine

# 受限网络下 alpine 官方源不可达，统一走镜像源。
# docs/32 §3.1：实例拉起已交给 RuntimeDriver，平台不在容器内 `docker run`，
# 也不再挂载宿主 docker.sock，因此无需 docker 客户端。
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories

WORKDIR /app
COPY apps/platform-api/package.json ./package.json
COPY apps/platform-api/package-lock.json ./package-lock.json
RUN npm ci --omit=dev
COPY apps/platform-api/src ./src

ENV NODE_ENV=production
EXPOSE 8080 8090

CMD ["node", "src/index.mjs"]

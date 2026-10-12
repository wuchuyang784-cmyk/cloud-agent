FROM node:22-alpine

# Dedicated machine orchestrator; only this image contains the Docker CLI.
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories \
    && apk add --no-cache docker-cli

WORKDIR /app
COPY apps/platform-api/package.json ./package.json
COPY apps/platform-api/package-lock.json ./package-lock.json
RUN npm ci --omit=dev
COPY apps/platform-api/src ./src

ENV NODE_ENV=production
USER root
CMD ["node", "src/runtime/managed-entry.mjs", "orchestrator"]

FROM node:22-alpine AS build
WORKDIR /web
COPY apps/console-mvp/package.json apps/console-mvp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/console-mvp/src ./src
COPY apps/console-mvp/public ./public
COPY apps/console-mvp/index.html apps/console-mvp/theme.css apps/console-mvp/tsconfig*.json apps/console-mvp/vite.config.ts ./
RUN npm run build

FROM node:22-alpine AS admin-build
WORKDIR /admin
COPY apps/admin-console/package.json apps/admin-console/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/admin-console/src ./src
COPY apps/admin-console/index.html apps/admin-console/tsconfig.json apps/admin-console/vite.config.ts ./
RUN npm run build

FROM caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
COPY --from=build /web/dist /srv
COPY --from=admin-build /admin/dist /srv/admin
COPY output/preprod/Caddyfile /etc/caddy/Caddyfile

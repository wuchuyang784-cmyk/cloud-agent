FROM node:22-alpine

WORKDIR /app
COPY apps/platform-api/package.json ./package.json
COPY apps/platform-api/package-lock.json ./package-lock.json
RUN npm ci --omit=dev
COPY apps/platform-api/src ./src

ENV NODE_ENV=production
EXPOSE 8080 8090

CMD ["node", "src/index.mjs"]

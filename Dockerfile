ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV CONFIG_PATH=/app/config.json

# 依赖层（package-lock 已锁定版本）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 源码与配置模板
COPY tsconfig.json config.example.json ./
COPY src ./src
COPY assets ./assets

EXPOSE 8080

# 容器健康检查（alpine 自带 busybox wget）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1

# 运行时直接执行 TypeScript（tsx 已在 dependencies 中）
CMD ["node_modules/.bin/tsx", "src/main/index.ts"]

# Stage 1: Build
FROM node:22-alpine AS builder

# 依赖下载源可配置（默认中国镜像；海外/CI 可在 build 时用 --build-arg 覆盖为官方源）
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=${NPM_REGISTRY} \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY}

WORKDIR /app

# Copy workspace root files for pnpm resolution
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/web/package.json packages/web/

# Install dependencies（固定 pnpm 版本，避免 corepack 拉取 @latest 造成网络解析失败）
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
RUN pnpm install --frozen-lockfile --filter @inkbloom/web...

# Copy source code
COPY packages/web/ packages/web/

# Build
WORKDIR /app/packages/web
RUN pnpm build

# Stage 2: Serve with nginx
FROM nginx:alpine

COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

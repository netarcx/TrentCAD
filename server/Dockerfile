# syntax=docker/dockerfile:1.6
#
# Multi-stage build: deps + build stages run in parallel under BuildKit.
#
#                       base
#                      /    \
#              server-deps   ui-deps
#                  |             |
#              build-server  build-ui
#                  \             /
#                      runtime

FROM node:22-alpine AS base
WORKDIR /app
ENV JOBS=max \
    npm_config_jobs=max
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add python3 make g++ libc-dev linux-headers

FROM base AS server-deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --no-audit --no-fund --prefer-offline

FROM base AS ui-deps
COPY ui/package.json ui/package-lock.json* ./ui/
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm --prefix ui ci --no-audit --no-fund --prefer-offline

FROM ui-deps AS build-ui
COPY ui ./ui
RUN npm --prefix ui run build

FROM server-deps AS build-server
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p .
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=42130 \
    HOST=0.0.0.0

COPY --from=build-server /app/node_modules ./node_modules
COPY --from=build-server /app/dist ./dist
COPY --from=build-ui     /app/dist/ui ./dist/ui
COPY package.json ./

VOLUME ["/data"]
EXPOSE 42130

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

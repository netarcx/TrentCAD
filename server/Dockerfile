# Multi-stage so the runtime image doesn't ship build tools.
#
# Stage 1 (`build`): full node:22 + the dev dependencies needed to
# compile TypeScript. We build to ./dist, then prune dev deps.
#
# Stage 2 (`runtime`): node:22-slim with just the runtime tree. The
# /data volume is where SQLite + the setup-PIN file live; mount it
# externally so the database survives container replacements.

FROM node:22-alpine AS build
WORKDIR /app
# Build tools for argon2 / better-sqlite3 native modules.
RUN apk add --no-cache python3 make g++ libc-dev linux-headers
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=42130 \
    HOST=0.0.0.0

# Copy the pruned node_modules + built JS. argon2 / better-sqlite3
# carry their native .node files already inside node_modules so we
# don't need build tools at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

VOLUME ["/data"]
EXPOSE 42130

# A simple HEALTHCHECK that polls our own /api/health. Docker marks the
# container unhealthy if the endpoint stops responding — useful for
# orchestrators and for `docker ps` at-a-glance.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

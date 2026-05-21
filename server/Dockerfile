# syntax=docker/dockerfile:1.6
#
# Multi-stage so the runtime image doesn't ship build tools.
#
# Stage 1 (`build`): full node:22-alpine + the native-build toolchain
# needed by `argon2` and `better-sqlite3`. Installs server deps,
# installs UI deps, copies source, builds both (`npm run build` runs
# `build:ui` first, then `tsc -p .`). The UI lands at `./dist/ui` so
# Fastify's `@fastify/static` plugin can serve it from `GET /`.
#
# Stage 2 (`runtime`): node:22-alpine carrying only the pruned
# node_modules + compiled JS. SQLite + the bootstrap SETUP_PIN.txt
# live under `/data`, exposed as a named VOLUME so the database
# survives container replacements.
#
# The `# syntax=` directive at the top enables BuildKit cache mounts
# (the `--mount=type=cache` lines below). Without it those lines are
# silently ignored and the build falls back to the slow path that
# re-downloads every tarball / re-fetches every apk index on each
# cache-busting rebuild. Docker 23+ has BuildKit on by default; with
# older docker run `DOCKER_BUILDKIT=1 docker build ...` to opt in.

FROM node:22-alpine AS build
WORKDIR /app

# Native-build deps for argon2 / better-sqlite3. Cache the apk index
# across builds so the (rare) rebuild of this layer doesn't re-fetch
# from upstream. python3+make+g++ is the standard prebuild-install
# fallback; libc-dev + linux-headers cover edge cases where the
# prebuilt binaries don't match the Alpine musl ABI.
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add python3 make g++ libc-dev linux-headers

# 1. Install server deps. The cache mount keeps npm's tarball store
#    across builds, so a package.json change re-resolves the lockfile
#    but doesn't re-download anything that hasn't actually changed.
#    `--prefer-offline` makes npm consult the cache before the network.
#    `npm ci` (vs install) so the build fails fast if package-lock.json
#    is out of sync with package.json.
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --prefer-offline

# 2. Install UI deps the same way. Separate from server deps so a
#    UI-only change doesn't invalidate the server install layer.
COPY ui/package.json ui/package-lock.json* ./ui/
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix ui ci --no-audit --no-fund --prefer-offline

# 3. Bring in source. Any change here busts the build cache below.
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui

# 4. Build UI then server. We skip `npm run build` here and call the
#    individual steps so the redundant `npm install` inside `build:ui`
#    (useful for first-time dev clones) doesn't fire when deps are
#    already installed.
RUN npm --prefix ui run build
RUN npx tsc -p .

# 5. Drop dev deps to shrink the runtime image. Native `.node` files
#    in argon2 / better-sqlite3 are prod deps, so they survive.
RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=42130 \
    HOST=0.0.0.0

# Copy only what the runtime needs: pruned node_modules + built JS +
# package.json (the entry point references it via the bin script's
# resolved path). No source, no UI source, no toolchain.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

VOLUME ["/data"]
EXPOSE 42130

# Polls our own /api/health. Docker marks the container unhealthy if
# the endpoint stops responding — useful for orchestrators (compose,
# Swarm, Kubernetes) and for `docker ps` at-a-glance.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

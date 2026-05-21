# syntax=docker/dockerfile:1.6
#
# Multi-stage so the runtime image doesn't ship build tools, AND so
# the independent install / build steps can run in parallel under
# BuildKit. Topology:
#
#                       base
#                      /    \
#              server-deps   ui-deps          ← run in parallel
#                  |             |
#              build-server  build-ui         ← run in parallel
#                  \             /
#                      runtime               ← assembles both
#
# A cold build on a many-core host went from ~50s sequential to
# ~30s on this layout — the npm-ci passes (which dominate cold
# wall time) overlap on disk + CPU, and the tsc + vite passes that
# follow them also run concurrently. With BuildKit cache mounts on
# both stages, a hot rebuild is single-digit seconds either way.
#
# The `# syntax=` directive at the top enables BuildKit's
# `--mount=type=cache` lines below. Without it those are silently
# ignored. Docker 23+ has BuildKit on by default; older versions
# need `DOCKER_BUILDKIT=1 docker build ...`.

# ─── base ──────────────────────────────────────────────────────────
# Common ancestor for the two parallel deps stages. Carries the
# native-build toolchain + the JOBS=max env vars used by node-gyp
# when argon2 / better-sqlite3 fall through to source compilation.
FROM node:22-alpine AS base
WORKDIR /app
ENV JOBS=max \
    npm_config_jobs=max

RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add python3 make g++ libc-dev linux-headers

# ─── server-deps ───────────────────────────────────────────────────
# Installs the team-server's prod + dev deps. Native modules
# (argon2, better-sqlite3) compile here when prebuilds don't match
# Alpine musl — JOBS=max parallelises make across every core.
# `--prefer-offline` makes npm consult the cache mount before the
# network for already-resolved tarballs.
FROM base AS server-deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --no-audit --no-fund --prefer-offline

# ─── ui-deps ───────────────────────────────────────────────────────
# Independent of server-deps so BuildKit runs both in parallel.
# Doesn't need python/make/g++ because the admin UI is pure JS, but
# it inherits them via `base` — the toolchain is in /usr/local so
# its presence in this stage is harmless layer weight (and the
# layer is shared with server-deps anyway).
FROM base AS ui-deps
COPY ui/package.json ui/package-lock.json* ./ui/
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm --prefix ui ci --no-audit --no-fund --prefer-offline

# ─── build-ui ──────────────────────────────────────────────────────
# Vite build of the admin SPA. Writes to ../dist/ui (relative to
# server/ui), i.e. /app/dist/ui from this stage's perspective.
FROM ui-deps AS build-ui
COPY ui ./ui
RUN npm --prefix ui run build

# ─── build-server ──────────────────────────────────────────────────
# tsc + npm prune. Pruning runs in this same stage AFTER tsc because
# tsc itself depends on the typescript dev dep — prune-then-build
# would break. Runs in parallel with build-ui under BuildKit.
FROM server-deps AS build-server
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p .
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm prune --omit=dev

# ─── runtime ───────────────────────────────────────────────────────
# Clean slate (no toolchain, no source, no UI source). Just node +
# the pruned modules + the two dist trees + package.json (the entry
# point's bin script resolves against it).
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

# Polls our own /api/health. Docker marks the container unhealthy
# if the endpoint stops responding — useful for orchestrators
# (compose, Swarm, Kubernetes) and for `docker ps` at-a-glance.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

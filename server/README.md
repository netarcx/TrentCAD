# FrameCAD Team Server

Self-hosted coordination server for FrameCAD desktop clients. Replaces
the old GitHub coordination-repo with a small Node + SQLite service,
and ships alongside a self-hosted Git-LFS object store (Giftless) so
the team's CAD files never touch GitHub's metered LFS storage.

## Quick start (recommended: docker compose)

From this directory (`server/`):

```bash
# 1. Create .env with the required secret — copy the template:
cp .env.example .env

# 2. Generate a random 32-byte hex string for LFS_JWT_SECRET and
#    paste it into .env. Pick whichever command you have handy:
openssl rand -hex 32                                              # Linux/macOS/WSL/Git Bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # Windows PowerShell
pwsh -c "[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))"  # PowerShell 7+

# 3. Bring it all up:
docker compose up -d
```

> **Why is the secret required?** It's the symmetric HMAC key that
> the team server uses to sign LFS auth tokens and Giftless uses to
> verify them. The compose file's `LFS_JWT_SECRET:?` marker refuses
> to start without it because running with a default secret would
> defeat the whole point of self-hosted LFS auth. Don't reuse a
> secret you've used somewhere else; it's only consumed by these two
> containers and never leaves the host.

That pulls the prebuilt multi-arch image from
[`ghcr.io/netarcx/framecad-server:latest`](https://github.com/netarcx/FrameCAD/pkgs/container/framecad-server)
plus the public `datopian/giftless:latest` image, starts both
containers, and exposes:

- **Team server (API + admin web UI)** on `http://<host>:42130`
- **LFS object store** on `http://<host>:42131`

Both containers bind-mount `./data` on the host — database, setup-PIN
file, and LFS objects all land there so backups are plain rsync/borg.

Look up the first-launch admin PIN — printed in the logs and also
saved to disk:

```bash
docker compose logs framecad-server | grep PIN
# or
cat ./data/SETUP_PIN.txt
```

Paste that PIN into FrameCAD desktop's "Enroll with Team" screen along
with your server URL (e.g. `http://localhost:42130`) to claim admin.
Open the admin web UI in any browser at the same URL — on first
launch you'll see a 4-step setup wizard (team info → LFS check →
first project → first member) that bootstraps the team. Every step
is skippable; you can do anything later from the sidebar.

To pin a specific release, edit `docker-compose.yml` and change
`:latest` to e.g. `:3.0.0`. List available tags at the GHCR package
page linked above.

To pull a newer image and restart:

```bash
docker compose pull
docker compose up -d
```

To stop:

```bash
docker compose down
```

To wipe and start over (delete the database AND all LFS objects):

```bash
docker compose down
rm -rf ./data
docker compose up -d
```

## Self-hosted LFS (giftless)

The `framecad-lfs` container in compose is [Giftless](https://giftless.datopian.com/),
a Python LFS server that talks the standard Git-LFS protocol. We
configure it for JWT auth using `LFS_JWT_SECRET`: the team server
mints short-lived (15 min) HS256 tokens scoped to a single project,
and Giftless validates them against the same secret. Neither container
ever talks to the other directly — they cooperate purely through the
tokens.

**Where the LFS URL points (for clients):** the `LFS_SERVER_URL` env
var. Defaults to `http://localhost:42131`, which only works for the
operator running compose on their own machine. For any real deployment
(team server on a school computer, students connecting from their
laptops), set this to the host's LAN IP or DNS name in `.env`:

```
LFS_SERVER_URL=http://framecad.school.local:42131
```

**Per-project quotas:** the admin web UI's Projects page lets you set
a hard cap per project (default 10 GiB, blank = unlimited). When a
project is over quota, the team server mints read-only tokens — the
desktop can still pull existing files, but pushes are blocked until
the admin raises the cap or someone deletes content. Usage is
re-scanned on every `/api/lfs/token` call (cheap; just sums file
sizes under `data/lfs-objects/framecad/<projectId>/`).

**Storage layout:** `./data/lfs-objects/framecad/<projectId>/<sha256>`.
You can `du -sh ./data/lfs-objects/framecad/*` to see per-project
usage at the OS level. Both containers see this directory: `framecad-lfs`
writes there (read-write), `framecad-server` reads from it (read-only)
to compute usage.

## Plain docker run (if you'd rather not use compose)

```bash
# Generate a secret and export it
export LFS_JWT_SECRET=$(openssl rand -hex 32)

# Team server
docker run -d \
  --name framecad-server \
  -p 42130:42130 \
  -e LFS_JWT_SECRET="$LFS_JWT_SECRET" \
  -e LFS_SERVER_URL=http://<host>:42131 \
  -e LFS_STORAGE_DIR=/lfs-storage \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/data/lfs-objects:/lfs-storage:ro" \
  ghcr.io/netarcx/framecad-server:latest

# LFS server
docker run -d \
  --name framecad-lfs \
  -p 42131:5000 \
  -e LFS_JWT_SECRET="$LFS_JWT_SECRET" \
  -e GIFTLESS_CONFIG_FILE=/etc/giftless/giftless.yaml \
  -v "$(pwd)/data/lfs-objects:/lfs-storage" \
  -v "$(pwd)/giftless-config.yaml:/etc/giftless/giftless.yaml:ro" \
  datopian/giftless:latest
```

Compose is strongly recommended — it keeps the two services lockstepped
and avoids hand-syncing the shared env vars.

## Building the image locally

When you've patched the server source and want to test before pushing,
flip the `image:` / `build:` lines in `docker-compose.yml` (the
comments there explain how) and:

```bash
docker compose up -d --build
```

## Local dev

```bash
cd server
npm install

# LFS_JWT_SECRET is read by the team server at boot. Without it,
# /api/lfs/* returns 503 but the rest of the server boots fine —
# useful when you're iterating on non-LFS code. To exercise LFS
# in dev, export it:
export LFS_JWT_SECRET=$(openssl rand -hex 32)

npm run dev        # tsx watch — restarts on save
```

On Windows PowerShell:

```powershell
$env:LFS_JWT_SECRET = (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm run dev
```

Data lands in `./data/` next to the source. Delete it to start fresh.

## Configuration

All via environment variables. Compose reads these from `.env` next
to `docker-compose.yml`.

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `LFS_JWT_SECRET` | **yes** | — | Symmetric HMAC key shared between the team server (signs LFS auth tokens) and giftless (verifies them). 32+ random bytes, hex-encoded. Generate with `openssl rand -hex 32` |
| `LFS_SERVER_URL` | no | `http://localhost:42131` | Public-facing URL of the LFS server as clients reach it. Override for any non-localhost deployment |
| `LFS_STORAGE_DIR` | no | (unset → quotas disabled) | Path inside the team-server container to the LFS object store mount. Set by docker-compose; only override for non-compose deployments |
| `PORT` | no | `42130` | TCP port the team server binds |
| `HOST` | no | `0.0.0.0` | Team server bind address |
| `DATA_DIR` | no | `./data` (dev) / `/data` (docker) | Where SQLite + setup-PIN file live |
| `LOG_LEVEL` | no | `info` | Pino log level |

## Endpoints

### Public (no auth)

- `GET /api/health` — liveness
- `POST /api/enroll` — exchange a PIN for a bearer token + team snapshot

### Client (`Authorization: Bearer <token>`)

- `GET /api/me` — your member + device
- `GET /api/team` — team settings snapshot (includes `lfsUrl`)
- `GET /api/members` — roster (students see only themselves)
- `GET /api/projects` — registered projects
- `POST /api/lfs/token` — mint a short-lived JWT scoped to one project, used by the desktop client to talk to giftless

### Admin (`Authorization: Bearer <token>` with `role='admin'`)

- `POST/GET/DELETE /api/admin/pins[/:code]` — issue / list / revoke PINs
- `GET/PATCH/DELETE /api/admin/members[/:id]` — list with caps / update / hard-delete
- `GET/POST/PATCH/DELETE /api/admin/projects[/:id]` — list with usage+quota / add (with optional `quotaBytes`) / edit quota / remove
- `PATCH /api/admin/team` — team config
- `GET /api/admin/setup-state` + `POST /api/admin/setup-complete` — gates the first-launch wizard
- `GET /api/admin/version-status` — server vs. GitHub-latest comparison + per-device outdated client list
- `GET /api/admin/devices` — list all enrolled devices
- `DELETE /api/admin/devices/:id` — revoke a device
- `GET /api/admin/audit?limit=N` — recent audit events

## Data model

SQLite at `${DATA_DIR}/framecad.db`. Tables:

- `team` — singleton row, one team per server. `setupComplete` gates the first-launch wizard.
- `members` — display name + GitHub username + role + status, plus per-member `capabilities` (JSON), `allowedProjectIds` (JSON), and optional `autoOpenProjectId` for kiosk-style enrollment.
- `devices` — one per enrolled FrameCAD instance, holds the argon2id-hashed bearer token AND the last reported `clientVersion` (powers the Dashboard's "update available" banner).
- `pins` — single-use 6-char enrollment codes with baked-in role + capabilities + allowlist + autoOpen.
- `projects` — registry: name + repoUrl + description, plus `quotaBytes` (NULL = unlimited) and the rolling `storageBytes` / `storageScannedAt` for the admin UI's usage indicator.
- `audit_events` — append-only log of admin actions.

WAL journal mode, `synchronous=NORMAL`, foreign keys on. Migrations
are an additive list under `db.ts`'s `MIGRATIONS` array — never
reorder; the `user_version` PRAGMA tracks which have been applied.

## Security notes

- Tokens are 256-bit random, stored only as argon2id hashes.
- LFS tokens (HS256 JWTs) are minted on demand, scoped to a single project, and expire in 15 min — even a leaked one is useless within a class period.
- PINs are single-use; consuming one atomically burns it via `UPDATE … WHERE consumedAt IS NULL`.
- PINs are case-insensitive and drawn from a reduced alphabet (`A-Z2-9`, no `0/1/I/O`) to avoid handwritten / shouted misreads.
- `LFS_JWT_SECRET` is loaded from `.env` (never committed) and never written to disk by the running containers — it lives only in memory.
- Server is HTTP by default — fine on a LAN. For internet exposure, put both containers behind a reverse proxy that terminates TLS.

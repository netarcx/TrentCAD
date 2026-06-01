# FrameCAD Team Server

Self-hosted coordination server for FrameCAD desktop clients. Replaces
the old GitHub coordination-repo with a small Node + SQLite service.

It is the team's **identity and coordination** brain: it issues enrollment
PINs, tracks members and devices, coordinates check-out / check-in **locks**,
records **publish history**, holds team config (including the allowed Google
Shared Drive IDs), and powers the admin web UI.

> **It does NOT store CAD files.** The bytes live in your team's
> [Google Shared Drive](../docs/google-workspace-setup.md). There is no
> LFS server, no object store, and no second container — just this one
> Node service.

## Quick start (recommended: docker compose)

From this directory (`server/`):

```bash
# 1. (Optional) create .env from the template if you want to override
#    any defaults (port, data dir, etc.). The defaults work out of the box.
cp .env.example .env

# 2. Bring it up:
docker compose up -d
```

That pulls the prebuilt multi-arch image from
[`ghcr.io/netarcx/framecad-server:latest`](https://github.com/netarcx/FrameCAD/pkgs/container/framecad-server),
starts the container, and exposes:

- **Team server (API + admin web UI)** on `http://<host>:42130`

The container bind-mounts `./data` on the host — the SQLite database and the
setup-PIN file land there, so backups are plain rsync/borg.

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
launch you'll see a short setup wizard (team info → first project →
first member) that bootstraps the team. Every step is skippable; you
can do anything later from the sidebar.

> **Before clients can join a project**, complete the one-time
> [Google Workspace setup](../docs/google-workspace-setup.md) (create the
> OAuth credentials and the team Shared Drive) and add the Shared Drive IDs
> under **Team Settings → Google Drive** in the admin UI.

To pin a specific release, edit `docker-compose.yml` and change
`:latest` to e.g. `:5.0.8`. List available tags at the GHCR package
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

To wipe and start over (delete the database — your CAD files in Google
Drive are untouched):

```bash
docker compose down
rm -rf ./data
docker compose up -d
```

## Storage: Google Drive, not the server

FrameCAD's file store is a team Google Shared Drive. The desktop client
signs in to Google directly (loopback OAuth) and downloads / uploads CAD
files straight from Drive; the bytes never pass through this server.

The team server's only role in storage is governance: it holds the list
of **allowed Shared Drive IDs** (Team Settings → Google Drive in the admin
UI) so enrolled clients only see and join the team's sanctioned drives.
That allowlist is surfaced to clients on `GET /api/team` and on enrollment.

See [docs/google-workspace-setup.md](../docs/google-workspace-setup.md)
for how to create the Google Cloud project, OAuth credentials, and the
Shared Drive.

## Plain docker run (if you'd rather not use compose)

```bash
docker run -d \
  --name framecad-server \
  -p 42130:42130 \
  -v "$(pwd)/data:/data" \
  ghcr.io/netarcx/framecad-server:latest
```

Compose is still recommended — it keeps the port mapping and volume
mount documented in one place.

## Building the image locally

`docker compose build` builds from local source and tags the image as
`ghcr.io/netarcx/framecad-server:latest` — same name the production
compose pulls — so the next `docker compose up -d` uses your local
build automatically.

```bash
docker compose build           # build from current source
docker compose up -d           # start the stack (uses the just-built image)
```

To switch back to the CI image:

```bash
docker compose pull            # pull ghcr.io/.../framecad-server:latest
docker compose up -d           # restart with the pulled image
```

### Why the same tag for built + pulled?

Pulling and building both target `ghcr.io/netarcx/framecad-server:latest`,
so whichever you ran most recently wins in your local image cache —
no separate tag bookkeeping, no compose-file edits. The image is
multi-arch when CI builds it (linux/amd64 + linux/arm64); your local
build is just whatever arch your machine is.

### Compose shortcuts (npm scripts)

Thin wrappers around the equivalent `docker compose` invocations, for
operators who prefer not to remember flags:

| Script | What it does |
|---|---|
| `npm run docker:up` | `docker compose up -d` |
| `npm run docker:down` | `docker compose down` |
| `npm run docker:logs` | `docker compose logs -f` |
| `npm run docker:build` | `docker compose build` (build only) |
| `npm run docker:dev` | `docker compose up -d --build` (build + start in one step) |

## Local dev

```bash
cd server
npm install
npm run dev        # tsx watch — restarts on save
```

Data lands in `./data/` next to the source. Delete it to start fresh.

## Configuration

All via environment variables. Compose reads these from `.env` next
to `docker-compose.yml` (every variable is optional — the defaults boot
a working single-team server).

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `42130` | TCP port the team server binds |
| `HOST` | no | `0.0.0.0` | Team server bind address |
| `DATA_DIR` | no | `./data` (dev) / `/data` (docker) | Where SQLite + setup-PIN file live |
| `LOG_LEVEL` | no | `info` | Pino log level |

## Endpoints

### Public (no auth)

- `GET /api/health` — liveness
- `POST /api/enroll` — exchange a PIN for a bearer token + team snapshot
- `POST /api/login` — password sign-in (multi-device self-service)

### Client (`Authorization: Bearer <token>`)

- `GET /api/me` — your member + device
- `GET /api/team` — team settings snapshot (includes the allowed Google Shared Drive IDs)
- `GET /api/members` — roster (students see only themselves)
- `GET /api/projects` — registered projects
- `GET/POST/DELETE /api/projects/:key/locks` — list / acquire (check out) / release (check in) a Drive-project lock
- `GET/POST /api/projects/:key/history` — read / append the project's publish history

### Admin (`Authorization: Bearer <token>` with `role='admin'`)

- `POST/GET/DELETE /api/admin/pins[/:code]` — issue / list / revoke PINs
- `GET/PATCH/DELETE /api/admin/members[/:id]` — list with caps / update / hard-delete
- `GET/POST/PATCH/DELETE /api/admin/projects[/:id]` — list / add / edit / remove registered projects
- `PATCH /api/admin/team` — team config (name, prefix, welcome message, allowed Shared Drive IDs, …)
- `GET /api/admin/setup-state` + `POST /api/admin/setup-complete` — gates the first-launch wizard
- `GET /api/admin/version-status` — server vs. GitHub-latest comparison + per-device outdated client list
- `GET /api/admin/devices` — list all enrolled devices
- `DELETE /api/admin/devices/:id` — revoke a device
- `GET /api/admin/audit?limit=N` — recent audit events

## Data model

SQLite at `${DATA_DIR}/framecad.db`. Tables:

- `team` — singleton row, one team per server. Holds team config including
  `googleSharedDriveIds` (the allowlist clients enforce). `setupComplete`
  gates the first-launch wizard.
- `members` — display name + role + status, plus per-member `capabilities`
  (JSON), `allowedProjectIds` (JSON), and optional `autoOpenProjectId` for
  kiosk-style enrollment.
- `devices` — one per enrolled FrameCAD instance, holds the argon2id-hashed
  bearer token AND the last reported `clientVersion` (powers the Dashboard's
  "update available" banner).
- `pins` — single-use 6-char enrollment codes with baked-in role +
  capabilities + allowlist + autoOpen.
- `projects` — registry: name + description (+ optional metadata for the
  admin UI).
- `locks` — active check-out / check-in locks, keyed by project + file path,
  with owner and timestamp. Replaces the old `git lfs lock` mechanism.
- `audit_events` — append-only log of admin actions.

WAL journal mode, `synchronous=NORMAL`, foreign keys on. Migrations
are an additive list under `db.ts`'s `MIGRATIONS` array — never
reorder; the `user_version` PRAGMA tracks which have been applied.

## Security notes

- Tokens are 256-bit random, stored only as argon2id hashes.
- PINs are single-use; consuming one atomically burns it via `UPDATE … WHERE consumedAt IS NULL`.
- PINs are case-insensitive and drawn from a reduced alphabet (`A-Z2-9`, no `0/1/I/O`) to avoid handwritten / shouted misreads.
- The server never holds Google credentials or CAD bytes — each client authenticates to Google directly, and Drive enforces its own access control on top of the team-server allowlist.
- Server is HTTP by default — fine on a LAN. For internet exposure, put the container behind a reverse proxy that terminates TLS.

# FrameCAD Team Server

Self-hosted coordination server for FrameCAD desktop clients. Replaces
the old GitHub coordination-repo with a small Node + SQLite service.

## Quick start (recommended: docker compose)

From this directory (`server/`):

```bash
docker compose up -d
```

That builds the image locally, starts the container, exposes the API +
admin web UI on port 42130, and bind-mounts `./data` for the database
and setup-PIN file.

Look up the first-launch admin PIN — it's printed in the logs and also
saved to disk:

```bash
docker compose logs framecad-server | grep PIN
# or
cat ./data/SETUP_PIN.txt
```

Paste that PIN into FrameCAD desktop's "Enroll with Team" screen along
with your server URL (e.g. `http://localhost:42130`) to claim admin.
Open the admin web UI in any browser at the same URL.

To stop:

```bash
docker compose down
```

To wipe and start over (delete the database):

```bash
docker compose down
rm -rf ./data
docker compose up -d
```

## Plain docker run (if you'd rather not use compose)

```bash
docker run -d \
  --name framecad-server \
  -p 42130:42130 \
  -v "$(pwd)/data:/data" \
  $(docker build -q .)
```

## Local dev

```bash
cd server
npm install
npm run dev        # tsx watch — restarts on save
```

Data lands in `./data/` next to the source. Delete it to start fresh.

## Configuration

All via environment variables:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `42130` | TCP port to bind |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` (dev) / `/data` (docker) | Where SQLite + setup-PIN file live |
| `LOG_LEVEL` | `info` | Pino log level |

## Endpoints

### Public (no auth)

- `GET /api/health` — liveness
- `POST /api/enroll` — exchange a PIN for a bearer token + team snapshot

### Client (`Authorization: Bearer <token>`)

- `GET /api/me` — your member + device
- `GET /api/team` — team settings snapshot
- `GET /api/members` — roster (students see only themselves)
- `GET /api/projects` — registered projects

### Admin (`Authorization: Bearer <token>` with `role='admin'`)

- `POST/GET/DELETE /api/admin/pins[/:code]` — issue / list / revoke PINs
- `PATCH/DELETE /api/admin/members/:id` — update role / status / displayName / hard-delete
- `POST/DELETE /api/admin/projects[/:id]` — add / remove projects
- `PATCH /api/admin/team` — team config
- `GET /api/admin/devices` — list all enrolled devices
- `DELETE /api/admin/devices/:id` — revoke a device
- `GET /api/admin/audit?limit=N` — recent audit events

## Data model

SQLite at `${DATA_DIR}/framecad.db`. Tables:

- `team` — singleton row, one team per server
- `members` — display name + GitHub username + role + status
- `devices` — one per enrolled FrameCAD instance, holds the argon2id-hashed bearer token
- `pins` — single-use 6-char enrollment codes with baked-in role
- `projects` — project registry (name + repoUrl + description)
- `audit_events` — append-only log of admin actions

WAL journal mode, `synchronous=NORMAL`, foreign keys on.

## Security notes

- Tokens are 256-bit random, stored only as argon2id hashes.
- PINs are single-use; consuming one atomically burns it via
  `UPDATE … WHERE consumedAt IS NULL`.
- PINs are case-insensitive and drawn from a reduced alphabet
  (`A-Z2-9`, no `0/1/I/O`) to avoid handwritten / shouted misreads.
- Server is HTTP by default — fine on a LAN. For internet exposure,
  put it behind a reverse proxy that terminates TLS.

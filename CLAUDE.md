# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is FrameCAD

A desktop CAD collaboration tool built for FRC Team 2129. Wraps Git LFS with a user-friendly UI so SolidWorks users can share files without learning Git. Uses check-out/check-in (lock-based) collaboration like GrabCAD Workbench. GitHub hosts the Git repos; **a self-hosted Giftless container** hosts the LFS objects (so the team isn't billed by GitHub for storage / bandwidth).

## Terminology: "server" vs "client"

Strict, non-overlapping. Don't conflate them:
- **Server** = the team server. Docker Compose deployment under `server/`. Hosts the admin web UI at port 42130 + the self-hosted Giftless LFS server at 42131. **All administration lives here**: PINs, members, devices, projects, team settings, capabilities, storage quotas, version status, audit log.
- **Client** = the Electron desktop app under `src/`. Pure end-user surface: project browser, check-out/check-in, sync, publish, parts. Talks to the server over HTTPS for auth + team state. **No admin functionality** — anything that affects the team belongs on the server. The legacy `AdminPage.tsx` is slated for removal/shrinking to client-local prefs only.

## Build Commands

```bash
npm run dev        # Start Electron dev server with hot reload
npm run build      # Production build (outputs to out/)
npm run package    # Build + create installer (outputs to dist/)
```

## Architecture

The repo holds three deliverables side by side:
1. **FrameCAD desktop** — the Electron app the user lives in (`src/`)
2. **FrameCAD team server** — a self-hosted Node + SQLite service that coordinates desktop clients (`server/`)
3. **FrameCAD SolidWorks add-in** — a COM-registered C# add-in (`solidworks-addin/`)

### Desktop (Electron, `src/`)

Three processes:
- **Main process** (`src/main/`) — Git operations, file locking, file watching, IPC handlers, team-server client
- **Preload** (`src/preload.ts`) — Bridges main ↔ renderer via `contextBridge`
- **Renderer** (`src/renderer/`) — React UI

**Key main process modules:**
- `git.ts` — All Git/LFS operations (create, clone, sync, publish, status, history). Uses `simple-git` npm package.
- `locking.ts` — Check-out/check-in via `git lfs lock`/`unlock`
- `parts.ts` — Part numbering system (`parts.json` manifest, auto-assign, create new part/assembly)
- `teamServer.ts` — Talks to the team server (enroll, refresh, sign out). Owns the in-memory snapshot + persists `serverUrl + token` to `framecad-app.json`.
- `rest.ts` — Local REST API server on port 42129 for SolidWorks add-in communication
- `ipc.ts` — All `ipcMain.handle()` registrations + chokidar file watcher
- `config.ts` — App config (recent projects, team-server enrollment) persisted in Electron userData

**Renderer:**
- `hooks/useGit.ts` — Single hook managing project state and IPC calls
- `hooks/useTeam.ts` — Push-subscribed accessor for the team snapshot (replaces the old `useCoordState`)
- Components: `ProjectSetup` (welcome screen), `ProjectBrowser`, `Toolbar`, `ActivityFeed`, `DetailsPanel`, `AdminPage` (Settings overlay), `TeamEnroll` (server-URL + PIN screen)

### Team server (`server/`)

Self-hosted Node + Fastify + SQLite (via `better-sqlite3`). Replaces the old GitHub coordination-repo. Single team per server instance.

- `src/index.ts` — entry, migrations, bootstrap PIN
- `src/db.ts` — SQLite schema (`team`, `members`, `devices`, `pins`, `projects`, `audit_events`)
- `src/auth.ts` — PIN gen (6-char alphanum), token gen, argon2id hashing, bearer middleware. Reads `X-Client-Version` from every authed request and updates `devices.clientVersion`.
- `src/version.ts` — Reads server's own version from `package.json`, fetches latest GitHub release (1h cache), HS256 semver-ish comparator. Powers the Dashboard "update available" banner.
- `src/lfs.ts` — Mints short-lived (15min) HS256 JWTs the desktop client sends to Giftless. Uses `node:crypto.createHmac` — no jose/jsonwebtoken dep.
- `src/routes/{public,client,admin}.ts` — `/api/enroll`, `/api/me`, `/api/team`, `/api/members`, `/api/projects`, `/api/lfs/token`, `/api/admin/*`, `/api/admin/version-status`
- `src/bootstrap.ts` — first-launch admin PIN to `data/SETUP_PIN.txt`
- `ui/` — React admin web UI served at `GET /` (built bundle lands in `dist/ui/`). Pages: `Dashboard`, `Members`, `Pins`, `Projects`, `TeamSettings`. Components: `UpdateBanner`, `CapabilityControls`.

Ships as two Docker images under `server/docker-compose.yml`:
- **`framecad-server`** (`server/Dockerfile`) — the Node app on port 42130
- **`framecad-lfs`** (`datopian/giftless`) — LFS object store on port 42131, validates JWTs signed by `framecad-server` using a shared `LFS_JWT_SECRET` env var. Object storage is a host bind-mount at `./data/lfs-objects` (so backups are plain rsync/borg).

Operators self-host on Unraid / Pi / school server. `.env` (next to compose file) must set `LFS_JWT_SECRET`; see `server/.env.example`.

### SolidWorks add-in (`solidworks-addin/`)

C# .NET Framework 4.8, COM-registered, talks to the desktop's REST API on `127.0.0.1:42129`. Same `/api/coord-state` shape as before — backing data now comes from `teamServer.ts` instead of the old coord-repo clone, so no add-in code changes were needed.

**Shared types** in `src/shared/types.ts` — used by both main and renderer.

## Git-to-CAD Terminology

This project deliberately hides Git terminology. In code and UI:
- Repository → Project
- Clone → Join Project
- Pull → Sync
- Commit + Push → Publish
- git lfs lock → Check Out
- git lfs unlock → Check In
- git log → History

## UI Layout

The file browser is the central element (full-width table, not a sidebar tree). Right side has a details panel for the selected file. Activity feed is a collapsible panel at the bottom. Status bar at the very bottom shows counts of modified/locked files.

## Tech Stack

Desktop client:
- Electron + React + TypeScript
- electron-vite (Vite-based build)
- simple-git (Git CLI wrapper)
- chokidar (file watching)
- electron-builder (packaging)
- @vitejs/plugin-react v4 (must stay v4 for electron-vite/vite 6 compat)

Team server:
- Node 22 + Fastify + TypeScript
- better-sqlite3 (synchronous, single-file DB)
- argon2 (PIN/token hashing)
- React + Vite (admin web UI bundle served by the same Fastify instance)
- HS256 JWT signing via node:crypto (no jose/jsonwebtoken dep)

LFS server (separate container):
- Giftless (Python/Flask, from datopian/giftless) with local filesystem backend
- HS256 JWT auth — same shared secret as the team server

## Admin onboarding workflow (target UX)

Goal: "Apple-level" — one linear flow on first launch, sensible defaults, skip-able. After consuming the bootstrap PIN from `SETUP_PIN.txt`, the admin web UI walks the operator through:

1. **Team info** — name, GitHub org, project prefix, welcome message
2. **LFS setup** — confirm the public LFS URL clients will use (the env-default works for single-machine, otherwise the operator types the LAN URL). Test connection button.
3. **First project** — admin pastes GitHub repo URL → server records the project, ALSO sets the project's storage quota (per-project hard cap; default 10 GB, editable). Storage usage shown live (`5.2 GB / 12 GB` with a progress bar) once data flows.
4. **First member** — issue a PIN with role + capabilities + project allowlist + auto-open. Skip to do later.

After the wizard, the admin can do anything from the sidebar — wizard is for the first-launch path, not the only path. Subsequent admins don't see it. Per-project quota lives on the Projects page (per-row); not a separate Storage page.

## Part Numbering (Phase 2)

- `parts.json` at project root, committed to Git so the whole team shares it
- Hierarchical format: `YY-2129-XX-YYY` (year-team-assembly-part), e.g., `26-2129-01-001`
- Folder structure determines hierarchy (folder = assembly group)
- Auto-assigns numbers to SolidWorks files (.sldprt, .sldasm, .slddrw)
- "New Part" / "New Assembly" buttons create files pre-named with part numbers
- Drawings share the number of the part/assembly with the same base filename
- Deleted file entries stay as tombstones so numbers are never reused

## REST API (Phase 3)

- HTTP server on `127.0.0.1:42129` (localhost only), starts when a project is open
- Endpoints: `/api/health`, `/api/status`, `/api/file?path=`, `/api/checkout`, `/api/checkin`, `/api/sync`, `/api/publish`, `/api/locks`, `/api/parts`
- Write operations are serialized via a mutex to prevent concurrent git commands
- Port configurable via `FRAMECAD_API_PORT` environment variable

## SolidWorks Add-in (Phase 3)

- Located in `solidworks-addin/` — separate C# project, not part of the Electron build
- .NET Framework 4.8, COM-registered, targets SolidWorks interop assemblies
- Task pane shows: part number, file status, lock state for the active document
- Buttons: Check Out, Check In, Sync, Publish
- Auto-refreshes on document switch via `ActiveDocChangeNotify`
- Health polling every 5 seconds to detect FrameCAD connection
- Build with Visual Studio on Windows: open `solidworks-addin/FrameCAD.SolidWorksAddin.sln`

## Dev Notes

- On Linux, run with `ELECTRON_DISABLE_SANDBOX=1` (already set in the dev script)
- `simple-git`'s `.add()` only accepts file paths — use `.raw(['add', '-A'])` for staging all
- Lock state takes priority over modified state in `getStatus()` so lock indicators always show
- `parts.json` is excluded from the chokidar watcher to prevent infinite loops

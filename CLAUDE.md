# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is FrameCAD

A desktop CAD collaboration tool built for FRC Team 2129. Gives SolidWorks users a friendly check-out/check-in (lock-based) collaboration workflow — like GrabCAD Workbench — without learning any version-control tooling. **Files are stored in the team's Google Shared Drive**; a small self-hosted **team server** coordinates identity, locks, and publish history. There is no Git, no Git LFS, and no GitHub in the storage path (the project migrated off a Git/LFS + self-hosted-Giftless backend — see the history note in `CHANGELOG.md`).

## Terminology: "server" vs "client"

Strict, non-overlapping. Don't conflate them:
- **Server** = the team server. Docker deployment under `server/`. Hosts the admin web UI at port 42130. **All administration lives here**: PINs, members, devices, projects, team settings, the Shared-Drive allowlist, capabilities, version status, audit log, and the publish-history + locks tables.
- **Client** = the Electron desktop app under `src/`. Pure end-user surface: project browser, check-out/check-in, sync, publish, parts. Talks to the server over HTTPS for team identity/state + locks, and to Google directly for Drive storage. **No team administration** — `AdminPage.tsx` is a client-local Settings overlay (theme/prefs, read-only profile, project layout, COTS); anything that affects the whole team belongs on the server.

## Build Commands

```bash
npm run dev        # Start Electron dev server with hot reload
npm run build      # Production build (outputs to out/)
npm run package    # Build + create installer (outputs to dist/)
npm test           # vitest (unit tests for parts/meta/config helpers)
```

## Architecture

The repo holds three deliverables side by side:
1. **FrameCAD desktop** — the Electron app the user lives in (`src/`)
2. **FrameCAD team server** — a self-hosted Node + SQLite service that coordinates desktop clients (`server/`)
3. **FrameCAD SolidWorks add-in** — a COM-registered C# add-in (`solidworks-addin/`)

### Desktop (Electron, `src/`)

Three processes:
- **Main process** (`src/main/`) — Google Drive sync, file locking (via the team server), file watching, IPC handlers, team-server client
- **Preload** (`src/preload.ts`) — Bridges main ↔ renderer via `contextBridge`
- **Renderer** (`src/renderer/`) — React UI

**Key main process modules:**
- `drive.ts` — Google Drive transfer engine (list/download/upload, COTS mirroring, parallel transfers + background staging).
- `drive-project.ts` — Drive-backed project lifecycle: open / join / sync / publish / status against a local folder + its `.framecad/drive-manifest.json`.
- `drive-manifest.ts` — the per-project manifest (path ↔ Drive file id ↔ hash) + the hash cache.
- `project-paths.ts` — the open project's local directory (`getProjectPath`/`setProjectPath`/`clearProjectPath`), shared by the filesystem helpers (parts, meta, documents, thumbnails).
- `google-auth.ts` — Google OAuth (loopback) sign-in/out + status, in the main process.
- `teamServer.ts` — Talks to the team server (enroll, refresh, sign out, **Drive locks**, **publish history**). Owns the in-memory snapshot + persists `serverUrl + token` to `framecad-app.json`.
- `persistence.ts` — backend-agnostic shared-metadata sync (parts.json / parts-meta.json / admin.json) straight to the Drive project folder.
- `parts.ts` — Part numbering system (`parts.json` manifest, auto-assign, create new part/assembly).
- `meta.ts` — per-part metadata (release state, mass, cost, comments, mfg method/material); deferred-commit batching.
- `rest.ts` — Local REST API server on port 42129 for SolidWorks add-in communication.
- `ipc.ts` — All `ipcMain.handle()` registrations + chokidar file watcher.
- `config.ts` — App config (recent projects, team-server enrollment) persisted in Electron userData.

> Note: there is no `git.ts`/`locking.ts`/`lfsMultipart.ts` anymore — the Git/LFS backend was removed. Locks are team-server rows; "history" is the team server's publish log.

**Renderer:**
- `hooks/useGit.ts` — Single hook managing project state and IPC calls (name is historical; it drives the Drive backend).
- `hooks/useTeam.ts` — Push-subscribed accessor for the team snapshot.
- Components: `ProjectSetup` (welcome screen), `DriveJoin` (Google sign-in → pick Shared Drive → pick folder → join), `ProjectBrowser`, `Toolbar`, `DetailsPanel`, `AdminPage` (client-local Settings overlay), `TeamEnroll` (server-URL + PIN screen).

### Team server (`server/`)

Self-hosted Node + Fastify + SQLite (via `better-sqlite3`). Replaces the old GitHub coordination-repo. Single team per server instance. **It coordinates only — it never stores a CAD byte** (those live in Google Drive).

- `src/index.ts` — entry, migrations, bootstrap PIN
- `src/db.ts` — SQLite schema (`team`, `members`, `devices`, `pins`, `projects`, `audit_events`, `locks`, `publish_log`)
- `src/auth.ts` — PIN gen (6-char alphanum), token gen, argon2id hashing, bearer middleware. Reads `X-Client-Version` from every authed request and updates `devices.clientVersion`.
- `src/version.ts` — Reads server's own version from `package.json`, fetches latest GitHub release (1h cache) for the desktop's update banner, semver-ish comparator.
- `src/routes/{public,client,admin}.ts` — `/api/enroll`, `/api/me`, `/api/team`, `/api/members`, `/api/projects`, `/api/projects/:key/locks`, `/api/projects/:key/history`, `/api/admin/*`, `/api/admin/version-status`
- `src/bootstrap.ts` — first-launch admin PIN to `data/SETUP_PIN.txt`
- `ui/` — React admin web UI served at `GET /` (built bundle lands in `dist/ui/`). Pages: `Dashboard`, `Members`, `Pins`, `Projects`, `TeamSettings`. Components: `UpdateBanner`, `CapabilityControls`.

Ships as a **single Docker image** under `server/docker-compose.yml`: `framecad-server` (`server/Dockerfile`) — the Node app on port 42130, with SQLite in a host bind-mount under `./data` (backups are plain rsync/borg). There is no LFS/Giftless container and no `LFS_JWT_SECRET`. Operators self-host on Unraid / Pi / school server. See `server/README.md` for the setup walkthrough, `server/.env.example` for the env template, and `docs/google-workspace-setup.md` for the Google Workspace / Shared-Drive setup.

### SolidWorks add-in (`solidworks-addin/`)

C# .NET Framework 4.8, COM-registered, talks to the desktop's REST API on `127.0.0.1:42129`. The `/api/coord-state` shape is preserved for the add-in's role-gating; backing data comes from `teamServer.ts`.

**Shared types** in `src/shared/types.ts` — used by both main and renderer.

## Git-to-CAD Terminology

This project deliberately hides version-control jargon. In code and UI the verbs map to the Google Drive + team-server backend:
- Repository → Project (a folder in the team's Shared Drive)
- Join Project → download the project folder from Drive to a local path
- Sync → pull teammates' latest changes down from Drive
- Publish → upload local changes to Drive + record the publish on the team server
- Check Out → acquire a lock on the team server
- Check In → release that lock
- History → the team server's publish log

## UI Layout

The file browser is the central element (full-width table, not a sidebar tree). Right side has a details panel for the selected file. Activity feed is a collapsible panel at the bottom. Status bar at the very bottom shows counts of modified/locked files.

## Tech Stack

Desktop client:
- Electron + React + TypeScript
- electron-vite (Vite-based build)
- googleapis + google-auth-library (Google Drive + OAuth)
- chokidar (file watching)
- electron-builder (packaging)
- @vitejs/plugin-react v4 (must stay v4 for electron-vite/vite 6 compat)

Team server:
- Node 22 + Fastify + TypeScript
- better-sqlite3 (synchronous, single-file DB)
- argon2 (PIN/token hashing)
- React + Vite (admin web UI bundle served by the same Fastify instance)

Storage backend:
- Google Drive (a team Google Shared Drive), accessed by the desktop via the Google APIs. The team server holds no file bytes.

## Admin onboarding workflow (target UX)

Goal: "Apple-level" — one linear flow on first launch, sensible defaults, skip-able. After consuming the bootstrap PIN from `SETUP_PIN.txt`, the admin web UI walks the operator through a short wizard (no LFS/storage step — Google Drive holds the bytes):

1. **Team info** — name, project prefix, welcome message.
2. **First project** — point the team at its Google Shared Drive / project folder (the Shared-Drive allowlist) so clients can find and join it.
3. **First member** — issue a PIN with role + capabilities + project allowlist + auto-open. Skip to do later.

After the wizard, the admin can do anything from the sidebar — the wizard is for the first-launch path, not the only path. Subsequent admins don't see it.

## Part Numbering (Phase 2)

- `parts.json` at project root, synced to the whole team via the Drive project folder (`persistence.ts`)
- Hierarchical format: `YY-2129-XX-YYY` (year-team-assembly-part), e.g., `26-2129-01-001`
- Folder structure determines hierarchy (folder = assembly group)
- Auto-assigns numbers to SolidWorks files (.sldprt, .sldasm, .slddrw)
- "New Part" / "New Assembly" buttons create files pre-named with part numbers
- Drawings share the number of the part/assembly with the same base filename
- Deleted file entries stay as tombstones so numbers are never reused

## REST API (Phase 3)

- HTTP server on `127.0.0.1:42129` (localhost only), starts when a project is open
- Endpoints: `/api/health`, `/api/status`, `/api/file?path=`, `/api/checkout`, `/api/checkin`, `/api/sync`, `/api/publish`, `/api/locks`, `/api/parts`, plus meta/title-block endpoints
- Write operations are serialized via a mutex to prevent concurrent Drive operations
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
- Lock state takes priority over modified state in the status tree so lock indicators always show
- `parts.json` is excluded from the chokidar watcher to prevent infinite loops
- Live Google OAuth needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (see `docs/google-workspace-setup.md`) and a real Workspace + Shared Drive to exercise end-to-end

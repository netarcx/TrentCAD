# FrameCAD — Developer Documentation

Architecture, build flow, REST API reference, and integration details for everyone working on FrameCAD itself or wiring an external tool to it.

For end-user docs see the [README](../README.md). For student onboarding see [STUDENT_SETUP.md](STUDENT_SETUP.md). For the one-time Google Drive / OAuth setup see [google-workspace-setup.md](google-workspace-setup.md), and for the team server see [server/README.md](../server/README.md).

---

## Features in detail

### File collaboration

- **Join / Open** projects with a guided wizard — files live in a team Google Shared Drive, no version-control commands required
- **Sync** pulls teammates' latest files down from Google Drive into the local project folder. Renames and moves are reconciled by Drive file id so a teammate moving a part doesn't read as delete-plus-add
- **Publish** uploads the local changes back up to Drive and records an entry in the team server's publish history (with author + message). Transfers run in parallel with a background pre-upload pass for throughput
- **Check Out / Check In** acquire and release a lock on the team server (`POST` / `DELETE /api/projects/:key/locks`), preventing conflicting edits on binary CAD files. Locks are server-coordinated, not stored in the file backend
- **Real-time file watching** with chokidar — the file browser updates automatically as you save in SolidWorks
- **Pre-publish guard** blocks oversized or disallowed files before upload, listing each blocker with size and remediation

### Part numbering system

Hierarchical part numbers in the format `YY-2129-XX-YYY` (year-team-subsystem-part). `parts.json` lives at the project root and is synced to Drive immediately on every reservation so the whole team shares a single source of truth.

- Auto-assigns numbers to SolidWorks files (`.sldprt`, `.sldasm`, `.slddrw`)
- **Top-level folder = subsystem**. Sub-folders inherit the parent subsystem's number (no extra dash-segment per nested folder)
- "New Part" / "New Assembly" buttons create files pre-named with their part number, so SolidWorks assembly references are never broken by renaming
- Drawings (`.slddrw`) automatically share the part number of the part/assembly with the same base filename in the same folder
- Deleted file entries remain as tombstones so part numbers are never reused

```
YY-2129-XX-YYY
 │   │    │   └── Part number (3 digits, per-subsystem counter)
 │   │    └────── Subsystem number (2 digits, per top-level folder)
 │   └─────────── Team number
 └─────────────── Year (last 2 digits, set at project creation)
```

Examples (for a project created in 2026):
- `26-2129-001` — a part in the project root (no subsystem)
- `26-2129-01` — the first subsystem (top-level folder)
- `26-2129-01-001` — the first part inside that subsystem (regardless of how deeply nested)
- `26-2129-02-001` — first part in the second subsystem

### Per-part metadata

Stored in `.framecad/parts-meta.json` (synced to Drive) and edited from the Details panel:

- **Release state**: draft → in-review → released → manufactured
- **Comments thread** (author + timestamp)
- **Manufacturing notes**, method (3D Print / CNC / Manual / Other), material
- **Mass** (lb), **cost** ($) — drive project totals + weight headroom

### Build-season documents

Generated on-demand from the Settings page into `Documents/` at the project root. Each document writes both a machine-readable source format (CSV / Markdown) and a styled PDF with page-numbered headers/footers.

- `BOM.csv` / `BOM.pdf` — every part with number, file, type, subsystem, release status, method, material, mass, cost
- `Manufacturing-Queue.csv` / `Manufacturing-Queue.pdf` — released + in-review parts grouped by Method → Material so a station walks one contiguous block
- `Project-Summary.md` / `Project-Summary.pdf` — totals (mass + 125 lb headroom callout, cost, parts/released/manufactured counts), by-subsystem rollup, by-method rollup

Files overwrite on each regeneration. Ride along on the next publish so the build team always sees the latest.

### SolidWorks add-in

- C# COM add-in that integrates directly into SolidWorks as a Task Pane
- Displays the active document's part number, file status, and lock state
- Check Out, Check In, Sync, and Publish buttons available without leaving SolidWorks
- Auto-refreshes when switching between documents (`ActiveDocChangeNotify`)
- Communicates with FrameCAD's local REST API (no direct file-store operations)

### Storage backend

CAD files live in a team **Google Shared Drive**. The desktop signs in to Google with a loopback OAuth flow (`google-auth.ts`) and talks to the Drive API directly (`drive.ts`). A per-project manifest (`.framecad/drive-manifest.json`, managed by `drive-manifest.ts`) maps each local file to its Drive file id / revision so Sync and Publish can do efficient, rename-aware diffs. The team server holds the allowlist of Shared Drive IDs clients are permitted to use; it never sees the file bytes.

### REST API

- Local HTTP server on `127.0.0.1:42129` for add-in and external tool communication
- Endpoints for health, file status, locks, check-out/check-in, sync, publish, parts manifest, parts metadata
- Write operations are serialized via a mutex to prevent concurrent Drive transfers from racing
- Localhost-only — never exposed to the network

## Prerequisites

- [Node.js](https://nodejs.org/) 24 (matches `.nvmrc` and CI). 22 also works; 20 is past EOL.
- Google OAuth "Desktop app" credentials and a team Google Shared Drive — see [google-workspace-setup.md](google-workspace-setup.md). No Git or Git LFS needed.
- (Optional) a running [team server](../server/README.md) for enrollment, locks, and publish history. The desktop also runs standalone.

## Getting started

### Installation

```bash
git clone https://github.com/netarcx/FrameCAD.git
cd FrameCAD
npm install
```

### Development

```bash
npm run dev
```

This starts the Electron app with hot reload via electron-vite. On Linux, `ELECTRON_DISABLE_SANDBOX=1` is set automatically in the dev script.

### Production build

```bash
npm run build       # Build to out/
npm run package     # Build + create installer to dist/
```

The packager produces a Windows NSIS installer (`framecad-{version}-setup.exe`), a macOS DMG, and a Linux AppImage depending on what platform you build on.

### CI / release

`.github/workflows/build-installer.yml` builds all three platforms in a matrix on every push to `main`. Releases auto-publish to GitHub.

The Windows job additionally builds and bundles the SolidWorks add-in DLL via `dotnet publish`; non-Windows jobs skip it (SolidWorks is Windows-only).

### Version numbering — beta releases

**Always use dot-separated prerelease identifiers** (`1.1.4-beta.1`, `1.1.4-beta.2`), never hyphen-separated (`1.1.4-beta-a`). electron-updater's GitHub provider treats hyphen-separated suffixes as their own custom channel, which means each `-beta-X` build is its own dead-end chain that can't auto-update to anything else (not to the next beta, and not even to the eventual stable release). Dot-separated lands every beta on the shared `"beta"` channel, which auto-flows to stable.

If a user gets stranded on a hyphen-suffix beta, they have to manually reinstall a non-suffix release once to break out.

## Architecture

```
src/
  main/                         # Electron main process
    index.ts                    # App entry point, window creation
    ipc.ts                      # IPC handlers + chokidar file watcher
    google-auth.ts              # Google loopback OAuth (sign in / out / status)
    drive.ts                    # Google Drive API I/O (download, upload, diff)
    drive-project.ts            # Open-project orchestration (sync, publish, status)
    drive-manifest.ts           # Per-project manifest (.framecad/drive-manifest.json)
    project-paths.ts            # The open project's local root path (shared state)
    persistence.ts              # Immediate Drive sync for team-shared metadata files
    parts.ts                    # Part numbering engine + manifest management
    meta.ts                     # Per-part metadata (.framecad/parts-meta.json)
    admin.ts                    # Per-project admin config (.framecad/admin.json)
    teamServer.ts               # Team-server client (enroll, refresh, locks, history)
    global-admin.ts             # Install-wide admin settings + build-time defaults
    rest.ts                     # Local REST API server
    documents.ts                # Build-season doc generation (CSV + MD + PDF)
    export-queue.ts             # Export-queue staging for the manufacturing flow
    issue.ts                    # "Report a problem" issue creator
    config.ts                   # App config (recent projects, Google auth) in userData
  preload.ts                    # contextBridge — exposes IPC API to renderer
  shared/
    types.ts                    # TypeScript types shared across all processes
  renderer/
    src/
      App.tsx                   # Root component — routing between setup and main UI
      hooks/
        useGit.ts               # Single hook managing all project state + IPC calls
        useTeam.ts              # Push-subscribed accessor for the team snapshot
        useParts.ts             # Parts manifest / numbering accessor
        useLayoutTier.ts        # Responsive layout tier (wide / medium / compact)
      components/
        ProjectSetup.tsx        # Join/Open welcome screen
        DriveJoin.tsx           # Google sign-in → Shared Drive → folder → download
        ProjectBrowser.tsx      # Full-width file table
        Toolbar.tsx             # Action buttons (Sync / Publish) + New Part/Assembly modals
        ActivityView.tsx        # Publish history view (from the team server)
        DetailsPanel.tsx        # Selected file info sidebar with per-part metadata
        AdminPage.tsx           # Settings panel (Ctrl+Shift+A); role-gated tabs
        TeamEnroll.tsx          # Team-server enrollment (server URL + 6-char PIN)
        settings/               # Per-project settings sub-panel
        ManufacturingQueue.tsx  # Tabbed shop view
        OnboardingTour.tsx      # First-launch tour
      styles/
        global.css              # All styles

server/                         # Self-hosted FrameCAD team server (Docker)
  src/
    index.ts                    # Fastify entry, bootstrap, route registration
    config.ts                   # Env config (PORT, HOST, DATA_DIR, LOG_LEVEL)
    db.ts                       # SQLite schema + migrations
    auth.ts                     # PIN gen, token gen, argon2id, bearer middleware
    bootstrap.ts                # First-launch admin PIN
    routes/
      public.ts                 # /api/health, /api/enroll, /api/login
      client.ts                 # /api/me, /api/team, /api/members, /api/projects,
                                #   /api/projects/:key/locks, /api/projects/:key/history
      admin.ts                  # /api/admin/* (CRUD on PINs, members, projects, team)
  ui/                           # React admin web UI served at GET /
    src/                        # Vite + React, builds to ../dist/ui/
  Dockerfile
  docker-compose.yml

solidworks-addin/               # C# SolidWorks add-in (separate project, Windows-only)
  FrameCAD.SolidWorksAddin/
    SwAddin.cs                  # COM entry point, Task Pane creation
    TaskPaneControl.cs          # WinForms UI with status display + buttons
    FrameCadApiClient.cs        # HTTP client for FrameCAD REST API
    PublishMessageDialog.cs     # Commit message input dialog
```

### Process communication

```
SolidWorks Add-in  ──HTTP──>  REST API (rest.ts)
                                    │
                                    v
Renderer (React)  ──IPC──>  Main Process (ipc.ts)
                                    │
                                    ├──> drive-project.ts ──> drive.ts ──HTTPS──> Google Drive
                                    ├──> teamServer.ts ──────HTTPS──> team server (locks / history)
                                    ├──> parts.ts (manifest)
                                    ├──> meta.ts (parts-meta.json)
                                    └──> documents.ts (BOM / Mfg / Summary)
```

## CAD-friendly terminology

FrameCAD deliberately hides the storage/coordination plumbing to be approachable for CAD users. Each surface verb maps to a concrete action:

| FrameCAD Term | What it does |
|---------------|--------------|
| Project | A folder in the team's Google Shared Drive |
| Join Project | Download a Drive project folder to a local directory |
| Sync | Pull teammates' latest files down from Drive |
| Publish | Upload local changes to Drive + record an entry in the team server's history |
| Check Out | Acquire a file lock on the team server |
| Check In | Release that lock |
| History | The team server's publish log for the project |

## REST API reference

All endpoints are served on `http://127.0.0.1:42129` (configurable via `FRAMECAD_API_PORT` env var). The server starts automatically when a project is opened.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server status + current project info |
| `GET` | `/api/status` | Full file tree with status and part numbers |
| `GET` | `/api/file?path=<relative>` | Single file status |
| `GET` | `/api/locks` | All current check-out locks (from the team server) |
| `GET` | `/api/parts` | Full parts manifest |
| `POST` | `/api/checkout` | Lock a file `{"path": "..."}` (acquires a team-server lock) |
| `POST` | `/api/checkin` | Unlock a file `{"path": "..."}` (releases the team-server lock) |
| `POST` | `/api/sync` | Pull latest changes from Drive |
| `POST` | `/api/publish` | Upload changes to Drive + log history `{"message": "..."}` |
| `POST` | `/api/stage` | Stage a new file `{"path": "..."}` (used by the add-in for newly-saved parts) |

Write operations (`checkout`, `checkin`, `sync`, `publish`, `stage`) are serialized — only one runs at a time, so concurrent Drive transfers can't race.

## SolidWorks add-in setup

### Option 1: Use the Windows installer (recommended)

The Windows installer auto-registers the add-in via `RegAsm.exe`. Restart SolidWorks after installing — the FrameCAD pane appears in the right Task Pane.

### Option 2: Manual install from GitHub Actions artifact

The add-in is built automatically by GitHub Actions on every push.

1. Go to **Actions** → the latest **Build & Release** run → download the **FrameCAD-SolidWorksAddin** artifact
2. Extract the zip to a permanent folder (e.g., `C:\FrameCAD-Addin\`)
3. Open a Command Prompt **as Administrator** and run:
   ```batch
   %windir%\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe /codebase "C:\FrameCAD-Addin\FrameCAD.SolidWorksAddin.dll"
   ```
4. Restart SolidWorks — the FrameCAD pane appears in the Task Pane

### Option 3: Build locally

Requires the [.NET SDK](https://dotnet.microsoft.com/download) and [.NET Framework 4.8 Developer Pack](https://dotnet.microsoft.com/download/dotnet-framework/net48). No Visual Studio needed.

```batch
cd solidworks-addin
dotnet publish FrameCAD.SolidWorksAddin/FrameCAD.SolidWorksAddin.csproj -c Release -o build/solidworks-addin
```

Then run RegAsm.exe as in Option 2.

### Usage

The add-in requires FrameCAD (the Electron app) to be running with a project open — it communicates via the REST API on port 42129. The connection indicator in the pane shows green when connected.

## Settings page

Access via **Ctrl+Shift+A** from anywhere in the app, or click the Settings gear in the sidebar. What you see depends on your role from the team server (or full admin if you haven't enrolled — standalone mode):

- **Student**: Profile + About + per-user preferences (screensaver toggle).
- **Mentor**: above + Project workflow (Parts Manager, Approvals, Documents, Export Queue), Maintenance (Locks, Tools), Project Registry.
- **Admin**: above + Team Settings, Member roster, per-project Settings (part numbering, COTS, weekly tags), factory reset.

Standalone mode (not enrolled with a team server) grants full admin so solo users aren't locked out. Enforcement is UI-only — the real security boundary is Google Drive access: the Shared Drive is restricted to the team's Workspace domain, and the team server allowlists which Shared Drive IDs clients may use.

### Build-time secrets

The CI workflow consumes these GitHub Actions secrets / env vars to bake defaults into the installer (see `electron.vite.config.ts`, which inlines them as `__…__` defines). Setting them at build time means students never have to enter credentials:

- `GOOGLE_CLIENT_ID` — Google OAuth "Desktop app" client ID (Drive access)
- `GOOGLE_CLIENT_SECRET` — matching client secret (not confidential for desktop OAuth clients, per Google's docs)
- `FRAMECAD_GOOGLE_SHARED_DRIVE_IDS` — comma-separated allowed Shared Drive IDs (the team server's value wins when set)
- `FRAMECAD_DEFAULT_SERVER_URL` — default team-server URL pre-filled on the enroll screen
- `FRAMECAD_DEFAULT_GITHUB_ORG` — team's GitHub org (used for the "report a problem" issue flow, not for storage)
- `FRAMECAD_DEFAULT_PROJECT_PREFIX` — project name prefix for filtering Browse
- `FRAMECAD_DEFAULT_TEAM_NAME` — team display name
- `FRAMECAD_DEFAULT_WELCOME_MESSAGE` — optional welcome text on the setup screen
- `FRAMECAD_DEFAULT_ISSUE_REPO` — repo the "report a problem" flow files issues against

See [google-workspace-setup.md](google-workspace-setup.md) for how to obtain the Google values.

## Tech stack

- **[Electron](https://www.electronjs.org/)** — cross-platform desktop app
- **[React](https://react.dev/)** 19 — renderer UI
- **[TypeScript](https://www.typescriptlang.org/)** — type safety across all processes
- **[electron-vite](https://electron-vite.org/)** — Vite-based build tooling for Electron
- **[googleapis](https://github.com/googleapis/google-api-nodejs-client)** + **[google-auth-library](https://github.com/googleapis/google-auth-library-nodejs)** — Google Drive storage backend + loopback OAuth
- **[chokidar](https://github.com/paulmillr/chokidar)** — cross-platform file watching
- **[electron-builder](https://www.electron.build/)** — packaging and installers
- **[vitest](https://vitest.dev/)** — unit tests covering parts numbering, per-part metadata, bulk meta + cascade, where-used, and path canonicalization (`canonPath`)

## CAD file types

Because files live in Google Drive as opaque blobs, FrameCAD uploads any file in the project folder regardless of extension — there's no LFS configuration step and no per-file host limit to dodge. The part-numbering engine recognizes SolidWorks documents (`.sldprt`, `.sldasm`, `.slddrw`, `.sldlfp`) for auto-numbering and drawing-pairing; everything else (CAD interchange formats, PDFs, images, archives) rides along unchanged.

The team's blocked-extension policy (configured on the team server) and the pre-publish guard are the backstops that keep junk out of a project, replacing the old "must be LFS-tracked or GitHub rejects the push" failure mode.

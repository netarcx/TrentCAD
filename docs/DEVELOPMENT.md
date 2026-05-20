# FrameCAD — Developer Documentation

Architecture, build flow, REST API reference, and integration details for everyone working on FrameCAD itself or wiring an external tool to it.

For end-user docs see the [README](../README.md). For student onboarding see [STUDENT_SETUP.md](STUDENT_SETUP.md).

---

## Features in detail

### File collaboration

- **Create / Join / Open** projects with a guided wizard — no Git commands required
- **Download** pulls the latest changes from the team (`git pull --rebase` under the hood, with auto-stash around dirty trees so the rebase never blocks on uncommitted student edits)
- **Upload** stages all changes, commits with a message, and pushes (`git add -A && git commit && git push`). Failed pushes automatically roll back the local commit so the UI doesn't lie about what's been published
- **Check Out / Check In** locks and unlocks files via `git lfs lock` / `git lfs unlock`, preventing conflicting edits on binary CAD files
- **Real-time file watching** with chokidar — the file browser updates automatically as you save in SolidWorks
- **Pre-publish size guard** aborts before upload if any non-LFS file is over 50 MB, listing each blocker with size and remediation
- **Repository Health** admin section scans the project tree for large files and badges them as BLOCKER / WARNING / OK-LFS

### Part numbering system

Hierarchical part numbers in the format `YY-2129-XX-YYY` (year-team-subsystem-part). `parts.json` is committed to Git so the whole team shares a single source of truth.

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

Stored in `.framecad/parts-meta.json` (committed to Git) and edited from the Details panel:

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
- Check Out, Check In, Download, and Upload buttons available without leaving SolidWorks
- Auto-refreshes when switching between documents (`ActiveDocChangeNotify`)
- Communicates with FrameCAD's local REST API (no direct Git operations)

### Self-hosted LFS storage (opt-in)

Per-project field in admin settings. When set, FrameCAD writes a `.lfsconfig` at the project root pointing at a custom LFS server (rudolfs, giftless, Gitea, GitLab, etc.). Git push/pull still go to GitHub, only the LFS object bytes change hosts. Blank = use GitHub LFS (default). Auth is left to the user via `.netrc` / git credential helpers.

### REST API

- Local HTTP server on `127.0.0.1:42129` for add-in and external tool communication
- Endpoints for health, file status, locks, check-out/check-in, sync, publish, parts manifest, parts metadata
- Write operations are serialized via a mutex to prevent concurrent Git commands
- Localhost-only — never exposed to the network

## Prerequisites

- [Node.js](https://nodejs.org/) 24 (matches `.nvmrc` and CI). 22 also works; 20 is past EOL.
- [Git](https://git-scm.com/) with [Git LFS](https://git-lfs.com/) installed
- A GitHub account and repository for team collaboration

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
    git.ts                      # All Git/LFS operations (simple-git)
    locking.ts                  # Check-out/check-in via git lfs lock/unlock
    parts.ts                    # Part numbering engine + manifest management
    meta.ts                     # Per-part metadata (.framecad/parts-meta.json)
    admin.ts                    # Per-project admin config (.framecad/admin.json)
    coordination.ts             # Coordination repo (members.json, team.json, projects.json)
    global-admin.ts             # Install-wide admin settings + defaults from GH secrets
    rest.ts                     # Local REST API server
    documents.ts                # Build-season doc generation (CSV + MD + PDF)
    large-files.ts              # Repository health scanner
    issue.ts                    # "Report to GitHub" issue creator via gh
    auth.ts                     # gh CLI integration (login, browse, create repo)
    config.ts                   # App config (recent projects) in Electron userData
  preload.ts                    # contextBridge — exposes IPC API to renderer
  shared/
    types.ts                    # TypeScript types shared across all processes
  renderer/
    src/
      App.tsx                   # Root component — routing between setup and main UI
      hooks/
        useGit.ts               # Single hook managing all project state + IPC calls
      components/
        ProjectSetup.tsx        # Create/Join/Open wizard
        ProjectBrowser.tsx      # Full-width file table
        Toolbar.tsx             # Action buttons + New Part/Assembly modals
        ActivityFeed.tsx        # Collapsible commit history
        DetailsPanel.tsx        # Selected file info sidebar with per-part metadata
        AdminPage.tsx           # Settings panel (Ctrl+Shift+A); role-gated tabs
        TeamSetup.tsx           # Coordination repo onboarding (create / join team)
        settings/               # Self-contained sub-panels (TeamSettings, MembersPanel, etc.)
        BrowseProjects.tsx      # Org-scoped repo browser
        ManufacturingQueue.tsx  # Tabbed shop view
        OnboardingTour.tsx      # First-launch tour
      styles/
        global.css              # All styles

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
                                    ├──> git.ts (simple-git)
                                    ├──> locking.ts (git lfs lock/unlock)
                                    ├──> parts.ts (manifest)
                                    ├──> meta.ts (parts-meta.json)
                                    └──> documents.ts (BOM / Mfg / Summary)
```

## Git-to-CAD terminology

FrameCAD deliberately hides Git terminology to be approachable for CAD users:

| Git Term | FrameCAD Term |
|----------|---------------|
| Repository | Project |
| Clone | Join Project |
| Pull | Download |
| Commit + Push | Upload / Publish |
| `git lfs lock` | Check Out |
| `git lfs unlock` | Check In |
| `git log` | History |

## REST API reference

All endpoints are served on `http://127.0.0.1:42129` (configurable via `FRAMECAD_API_PORT` env var). The server starts automatically when a project is opened.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server status + current project info |
| `GET` | `/api/status` | Full file tree with status and part numbers |
| `GET` | `/api/file?path=<relative>` | Single file status |
| `GET` | `/api/locks` | All current LFS locks |
| `GET` | `/api/parts` | Full parts manifest |
| `POST` | `/api/checkout` | Lock a file `{"path": "..."}` |
| `POST` | `/api/checkin` | Unlock a file `{"path": "..."}` |
| `POST` | `/api/sync` | Pull latest changes |
| `POST` | `/api/publish` | Commit + push `{"message": "..."}` |
| `POST` | `/api/stage` | Stage a new file `{"path": "..."}` (used by the add-in for newly-saved parts) |

Write operations (`checkout`, `checkin`, `sync`, `publish`, `stage`) are serialized — only one runs at a time.

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

Access via **Ctrl+Shift+A** from anywhere in the app, or click the Settings gear in the sidebar. What you see depends on your role in the coordination repo:

- **Student**: Profile + About + per-user preferences (screensaver toggle).
- **Mentor**: above + Project workflow (Parts Manager, Approvals, Documents, Export Queue), Maintenance (Locks, Health, Tools), Project Registry.
- **Admin**: above + Team Settings, Member roster, per-project Settings (part numbering, COTS, LFS, weekly tags), factory reset.

Standalone mode (no coordination repo configured) grants full admin so solo users aren't locked out. Enforcement is UI-only — the real security boundary is GitHub org write access (push fails without it).

### Build-time secrets

The CI workflow consumes these GitHub Actions secrets to bake defaults into the installer:

- `FRAMECAD_DEFAULT_GITHUB_ORG` — team's GitHub organisation (e.g. `netarcx`)
- `FRAMECAD_DEFAULT_PROJECT_PREFIX` — repo name prefix for filtering Browse (e.g. `framecad-`)
- `FRAMECAD_DEFAULT_TEAM_NAME` — team display name
- `FRAMECAD_DEFAULT_WELCOME_MESSAGE` — optional welcome text on the setup screen

## Tech stack

- **[Electron](https://www.electronjs.org/)** — cross-platform desktop app
- **[React](https://react.dev/)** 19 — renderer UI
- **[TypeScript](https://www.typescriptlang.org/)** — type safety across all processes
- **[electron-vite](https://electron-vite.org/)** — Vite-based build tooling for Electron
- **[simple-git](https://github.com/steveukx/git-js)** — Git CLI wrapper for Node.js
- **[chokidar](https://github.com/paulmillr/chokidar)** — cross-platform file watching
- **[electron-builder](https://www.electron.build/)** — packaging and installers
- **[vitest](https://vitest.dev/)** — unit tests (106 covering parts numbering, per-part metadata, bulk meta + cascade, where-used, legacy mode, canonPath, isNonFastForward)

## LFS-tracked file types

FrameCAD automatically configures Git LFS tracking for these file types when creating a project. Existing projects get them appended to `.gitattributes` on the next open.

| Category | Extensions |
|----------|------------|
| SolidWorks | `.sldprt`, `.sldasm`, `.slddrw`, `.sldlfp` |
| CAD interchange | `.step` / `.stp`, `.iges` / `.igs`, `.stl`, `.3dxml`, `.dwg`, `.dxf`, `.obj`, `.x_t` / `.x_b` |
| Documents | `.pdf` |
| Images | `.png`, `.jpg`, `.jpeg`, `.bmp` |
| Archives + installers | `.zip`, `.rar`, `.7z`, `.tar`, `.gz`, `.exe`, `.msi` |

Archives and installers are LFS-tracked defensively — they don't really belong in a CAD repo, but teams regularly Pack-and-Go into a zip or drop a CacheCAD installer alongside their files. Without LFS coverage these silently exceed GitHub's 100 MB per-file hard limit and the whole push gets rejected.

## License

Source-available for FRC team use. No license file is currently included — if you're a mentor on another team interested in using FrameCAD, open an issue and we'll talk.

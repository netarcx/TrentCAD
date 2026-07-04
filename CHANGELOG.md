# Changelog

All notable changes to FrameCAD are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [SemVer](https://semver.org/) — though for a single-team app the
versions are mostly chronology markers.

## [1.1.12] — 2026-07-04

Cross-cutting bug-fix pass over the whole product (desktop, team server,
SolidWorks add-in, and the Lore backend) — 45 audited defects plus 7 issues
caught in an adversarial verification pass. Highlights:

### Fixed
- **Sync/publish data-safety (Drive):** sync no longer overwrites an untracked
  local file that collides with a newly-published one; the staging garbage
  collector can no longer resurrect a promoted entry and trash the live file;
  the parallel transfer pool now drains every worker before failing, so a
  straggler can't corrupt an already-saved manifest; deleted files are only
  dropped from the manifest once the Drive trash is confirmed; Google-native
  files (Docs/Sheets) in a project folder no longer wedge sync; re-joining an
  existing project no longer clobbers unpublished edits.
- **Part numbering:** offline-created (provisional) numbers are re-attached
  after a shared-file pull, so a second "+ Part" can't re-issue a number;
  coordination now works on Lore projects; drawings' links follow a rename.
- **Metadata:** deferred release-state/mass/cost edits are protected from being
  clobbered by a concurrent sync, are project-scoped so they can't leak across a
  project switch, and survive an offline close.
- **Team server:** closed an unauthenticated argon2 CPU/memory DoS in token
  auth (indexed lookup); deleting a member no longer erases their publish
  history; migrations are now atomic; the update banner recognises `rc.N`
  prereleases; `TRUST_PROXY` support for reverse-proxy deployments.
- **SolidWorks add-in:** export no longer closes (and discards unsaved changes
  in) a document the user already had open; add-in state re-derives on a
  desktop project switch; safer COM teardown; mass pushes coalesce to the newest
  value; failed part creates no longer silently orphan the reserved number.
- **Renderer:** the details panel stops wiping unsaved metadata edits on every
  file-tree refresh; create/sync/publish/enroll buttons no longer double-submit;
  thumbnails can't leak across a project switch; sticky error banners clear on
  recovery; the opt-in screensaver pauses when the window is hidden.

## [5.x] — Google Drive backend

> The big architectural arc since 1.0. Exact per-version dates aren't
> reconstructed here — see [`git log`](https://github.com/netarcx/FrameCAD/commits/main)
> for the precise milestone-by-milestone history. Desktop is currently
> at **5.1.6**, the team server at **5.0.12**.

The headline change: **Google Drive replaced Git, Git LFS, and GitHub as
the storage backend.** CAD files now live in a team Google Shared Drive;
the desktop signs in to Google directly (loopback OAuth) and downloads /
uploads files from Drive. Students no longer install Git or Git LFS, and
nothing pushes to GitHub anymore (GitHub is only used for app releases and
the "report a problem" issue flow).

### Added
- **Google Drive storage backend** — sign in with Google, "Join from
  Google Drive" (pick Shared Drive → project folder → local save path,
  then download), Sync to pull teammates' latest, Publish to upload.
  Sync reconciles teammate renames/moves by Drive file id so a moved part
  doesn't read as delete-plus-add.
- **Self-hosted team server** (Node + SQLite) — replaced the old GitHub
  coordination-repo. Owns team identity, 6-character enrollment PINs,
  members/devices, capabilities, the audit log, and the admin web UI,
  plus the update-available banner. Multi-device support and self-service
  password sign-in landed along the way.
- **Server-coordinated locks** — Check Out / Check In acquire and release
  a lock on the team server (`/api/projects/:key/locks`) instead of the
  old `git lfs lock`.
- **Publish history on the team server** (`/api/projects/:key/history`) —
  every Publish is logged with author + message and shown in the activity
  view.
- **Shared Drive allowlist** managed from the team server (Team Settings →
  Google Drive) so enrolled clients only see and join sanctioned drives;
  OAuth credentials + allowlist can also be baked into the installer at
  build time.
- **Archive mode (read-only local mirror)** — an admin issues an enrollment
  PIN with the new "Archive device" flag (alongside role / capabilities /
  project allowlist). A client enrolled with it becomes a read-only Drive
  mirror: a dedicated Archive Dashboard replaces the editing UI, every
  project on its allowlist is auto-downloaded and kept current as teammates
  publish, and it can never upload — Publish and Check Out are hidden in the
  UI and rejected by the server (403). Lets a team keep a continuously
  updated offline backup of its CAD on a spare machine.

### Changed
- **Terminology now maps to Drive**: Project = a Shared Drive folder,
  Join Project = download from Drive, Sync = pull latest from Drive,
  Publish = upload to Drive + log history, Check Out / Check In = acquire /
  release a team-server lock, History = the server's publish log.
- Toolbar verbs are **Sync** and **Publish** (previously framed as
  Download / Upload).

### Removed
- **The entire client-side Git/LFS backend** — `git.ts`, `locking.ts`,
  `lfsMultipart.ts`, `large-files.ts`, the `gh`-CLI auth module, and the
  `simple-git` dependency are gone. The desktop no longer requires Git or
  Git LFS installed, and there is no GitHub sign-in.
- **Self-hosted LFS / Giftless** on the server side — the second container,
  port 42131, `LFS_JWT_SECRET`, `/api/lfs/token`, and the
  `LFS_SERVER_URL` / `LFS_STORAGE_DIR` env vars were all removed. The team
  server is now a single Node container on port 42130 that never touches
  CAD bytes.

---

> Entries below predate the Google Drive migration and are kept as
> historical record. References to Git, Git LFS, GitHub storage, and
> self-hosted LFS describe the architecture that the 5.x line replaced.

## [1.0.0] — 2026-05-13

First stable release. The 0.x line was day-to-day driver use by FRC 2129
for one and a half build seasons; 1.0 is what shipped after the final
polish pass.

### Added
- **Per-part thumbnails** rendered from the OS shell preview (Windows SolidWorks
  thumbnail provider, macOS QuickLook). 24px in the file table, 200px in
  the details panel. Cached by mtime so a SolidWorks save refreshes the
  preview automatically.
- **Where Used** view in the part details panel listing every assembly
  the part belongs to, with one-click navigation.
- **Cascade in-review** — marking an `.sldasm` as in-review automatically
  sweeps every part under that folder subtree into the same state in
  one commit. Skips parts already marked `manufactured`.
- **Folder dirty badge** — folders show a count of modified/untracked
  files anywhere in their subtree, so collapsed folders can't hide
  pending changes.
- **Admin force-unlock** — new Locks tab in the admin panel lists every
  active check-out with an owner column and a Force Release button.
- **Bulk metadata editing** in the Parts Manager — multi-select rows
  and apply release / method / material to all of them in a single
  commit.
- **Non-blocking sync queue** — metadata edits land in a 1.2s debounced
  queue and flush as one commit. Cells stay editable while a sync is
  in flight.
- **OpenDyslexic UI font toggle** (`Ctrl+Shift+D`), persisted across
  launches.
- **Responsive layout** with three tiers — wide (≥1280px) keeps the
  full inline layout, medium (1024–1280px) turns the details panel
  into a slide-in overlay, compact (<1024px) collapses the left sidebar
  to icons-only. Minimum window size now 960×600 so 1366×768 laptops
  fit with the Windows taskbar visible.
- **`framecad://` deep-link protocol** — auto-generated project READMEs
  include a one-click `framecad://join?url=…` link that opens the
  desktop app straight into the Join Project flow.
- **Clickable logo** in the app header returns to the welcome screen
  / exits manufacturing view.
- **Auto-generated README** on project creation, committed to GitHub
  with the join link and a settings walkthrough.
- **Folder-tree auto-collapse on every load** so large projects don't
  open as a wall of files.
- **`Ctrl+Shift+R` update check** correctly reports "no published
  releases yet" instead of the raw electron-updater error.

### Changed
- Settings merged into the Admin panel — one PIN-gated place for all
  configuration. The sidebar Settings entry now opens the merged page.
- Recent-project paths normalized via `path.normalize` (uppercase
  Windows drive letter, trimmed trailing separators) so the same
  project doesn't appear twice with different slash styles.
- UI accent color changed from purple to engineering blueprint blue
  (`#60a5fa` dark / `#2563eb` light) — better contrast and a more
  obvious fit for a CAD workflow tool.
- Folder dirty badge contrast fixed (was yellow with white text — now
  uses the accent + bg-primary scheme, matching `.sidebar-badge`).
- File-tree typography: folder names bold, file extensions render at
  0.85em in secondary color.

### Fixed
- Manufacturing View no longer flashes through the regular project
  view (with sidebar) for the duration of `openProject` before the
  kiosk shell takes over.
- `git lfs lock` "Lock exists" error now resolves to either a silent
  no-op (we already own it) or a clean "Already checked out by <name>"
  message instead of raw LFS output. Also makes `checkIn` idempotent
  for files that aren't locked.
- File-tree auto-collapse no longer expires after 1.5s when no folders
  have appeared yet; it waits for the first non-empty file list.

### Internal
- `bulkUpdateMeta` IPC accepts a per-path patch map so the renderer
  edit queue and bulk-select Apply both flush as a single commit.
- New `useLayoutTier` hook + `data-layout-tier` attribute on `<html>`
  drives all CSS responsive rules.
- New `nativeImage.createThumbnailFromPath`-backed thumbnail cache in
  `src/main/thumbnails.ts` with mtime invalidation.
- Path canonicalization helper in `src/main/config.ts` migrates the
  recent-projects list on read.

## [0.8.5] — earlier
PDM correctness pass — meta changes fan out to every view.

## [0.7.x] — earlier
SolidWorks add-in, Manufacturing View, full-screen Admin, large-file
scanner, push rollback, self-hosted LFS.

## [0.6.x — 0.5.x] — earlier
Foundation: check-out / check-in, part numbering, REST API, Google
Drive sync.

For the full per-version history before 1.0, see
[`git log`](https://github.com/netarcx/FrameCAD/commits/main).

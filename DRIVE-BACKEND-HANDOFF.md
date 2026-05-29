# Google Drive backend — work-in-progress handoff

Branch: **`feat/google-drive-backend`** (off `main` @ v4.2.1). Nothing committed yet.
Goal agreed with Trent: **full replacement** of Git/LFS with Google Drive, end-to-end,
with **check-out/check-in locks moved to the team server**.

## Verified state (tsc: 0 errors in these files)

`npx tsc --noEmit -p tsconfig.node.json` shows **18 errors, all pre-existing baseline**
(`git.ts` null-checks + `LockInfo`, `ipc.ts` `projectSubpath`/`cotsSubpath`,
`lfsMultipart.ts`, `rest.ts`) — these are on `main` too; the project ships via esbuild
which skips typecheck. None are from this work.

DONE and clean:
- **package.json** — added `googleapis ^172.0.0` + `google-auth-library ^10.6.2`
  (they were in `node_modules` but missing from the manifest — `npm ci` would've broken).
- **src/shared/types.ts** — added `GoogleAuthStatus`, `DriveSharedDrive`, `DriveFolder`;
  added `backend?: 'git'|'drive'`, `driveFolderId?`, `sharedDriveId?` to `ProjectConfig`;
  added 6 methods to `IpcApi` (googleAuthStatus/googleSignIn/googleSignOut/
  driveListSharedDrives/driveListFolders/driveJoinProject).
- **src/main/config.ts** — added `AppConfig.googleAuth` + `GoogleAuthSettings` +
  `getGoogleAuthSettings`/`setGoogleAuthSettings` (mirrors the teamServer pattern).
- **src/main/drive.ts** — completed the sync engine: `ensureFolderPath` (nested-folder
  create/find w/ cache), `publishChanges` (upload adds/mods + trash deletes + manifest
  reconcile), `syncRemote` (pull new/changed, delete-locally-when-gone, conflict guard
  that never clobbers local edits). Removed the dead `uploadFile`.
- **src/main/drive-project.ts** — NEW facade: `isOpen/open/close/join/status/sync/publish/
  currentConfig/currentDir`. A Drive project = a folder with `.framecad/drive-manifest.json`.
- **src/preload.ts** — added the 6 google/drive `ipcRenderer.invoke` bindings.
- **src/main/google-auth.ts**, **drive-manifest.ts** — pre-existing (untracked), unchanged,
  now compile because their missing deps (types/config) exist.

## BROKEN / INCOMPLETE — fix first next session

**src/main/ipc.ts is half-edited.** It has two ADDED-but-UNUSED imports
(`import * as googleAuth from './google-auth'`, `import * as driveProject from './drive-project'`)
and **none of the routing or new handlers** — my batch-replace script threw on a bad anchor
(built from glitched file reads) and wrote nothing. tsc doesn't flag the unused imports so the
build isn't broken, but the feature is NOT wired. Either finish the wiring or revert those 2 lines.

### Real ipc.ts structure (confirmed, use these exact anchors)
- Setup fn is `setupIpc(getMainWindow)`; project state is a **local** `currentProject` var.
- Watcher helpers: `startWatching(dirPath, win)` / `stopWatching()`.
- REST: `setRestProject(currentProject)` — **single arg (the config)**, not `(dir, config)`.
- `open-project` is an **inline** handler (~L147): `await gitOps.openProject(dirPath)` then
  reads remote via `gitOps.getGit()`, sets `currentProject`, `setRestProject`, `startWatching`.
- `check-out`/`check-in` wrap `pathsOps.toGitRel(filePath)`.
- `get-project-config` returns the local `currentProject` (so if the Drive branches SET
  `currentProject = driveConfig`, no edit to get-project-config is needed).
- `close-project` sets `currentProject = null` + `pathsOps.clearSubpathCache()`.
- Insert new handlers after `ipcMain.handle('team-ping-server', () => teamServer.pingTeamServer())` (~L734).

### Wiring still to apply in ipc.ts
1. Add `import * as driveOps from './drive'`.
2. `open-project`: try `driveProject.open(dirPath)` first → if non-null set `currentProject`,
   `setRestProject`, `startWatching`, return; else `driveProject.close()` then the git path.
3. Branch on `driveProject.isOpen()` in: `sync` (→`driveProject.sync` w/ publish-progress),
   `publish` (→`driveProject.publish`), `get-status` (→`driveProject.status()`),
   `get-history` (→`[]`), `get-remote-ahead`/`get-local-ahead` (→`0`),
   `get-locks` (→`[]`), `check-out`/`check-in` (→ no-op TODO until Piece 3).
4. `close-project`: add `driveProject.close()`.
5. New handlers: `google-auth-status/-sign-in/-sign-out`,
   `drive-list-shared-drives`, `drive-list-folders`, `drive-join-project`
   (join sets `currentProject`, `setRestProject`, `startWatching`, emits `join-progress`).
6. `notifyFileChange` (defined ~L45): when `driveProject.isOpen()`, send
   `driveProject.status()` instead of `partsOps.syncManifest()→gitOps.getStatus()`.

Recommend a node script with **per-edit count guards that COLLECT failures and only
write if all matched** (the previous one threw mid-way). Re-fetch exact strings first.

## Not started
- **Piece 3 — server locks** (`server/`): migration v15 `locks` table, `/api/projects/.../locks`
  GET/POST/DELETE, `teamServer.ts` client calls, then wire ipc check-out/check-in/get-locks.
  Note: server `projects` table is keyed on GitHub `repoUrl`; Drive projects aren't registered
  there. Either key the locks table on a free-text project key (the Drive folderId) or extend
  the project registry. Decide before building.
- **Piece 4 — renderer UI**: ProjectSetup's join form is GitHub-only; there is NO entry point
  to sign into Google / pick a Shared Drive + folder / join-from-Drive. Until this lands the
  feature is unreachable by a user. (Toolbar sync/publish already call the routed IPC, so they
  work once a Drive project is open.)
- **Piece 5 — git rip-out**: the actual "full replacement". `git.ts` is imported by 10 main
  modules (admin, thumbnails, parts, large-files, locking, documents, rest, meta, ipc, +test).
  parts/meta/thumbnails mostly use the filesystem, but publish/locking/history are git. Big,
  destructive, do last.

## Can't be verified in this dev env (needs Trent)
- Live Google OAuth: needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars
  (see `docs/google-workspace-setup.md`) and a real Workspace + Shared Drive.
- A running team server (for Piece 3 locks).
- The Electron GUI round-trip (sign in → join → edit → publish → sync on a 2nd machine).

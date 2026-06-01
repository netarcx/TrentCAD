# Google Drive backend — work-in-progress handoff

Branch: **`feat/google-drive-backend`** (off `main` @ v5.0.7).
Goal agreed with Trent: **full replacement** of Git/LFS with Google Drive, end-to-end,
with **check-out/check-in locks moved to the team server**.

## Status summary

| Piece | What | State |
|-------|------|-------|
| 1 | Engine + types + config + drive.ts / drive-project.ts / google-auth.ts | ✅ done |
| 2 | ipc.ts routing (sync/publish/status/locks/**history** on `driveProject.isOpen()`) | ✅ done (shipped v5.1.0) |
| 3 | Server-side locks (migration v15 + routes + teamServer client + ipc wiring) | ✅ done + verified live |
| 4 | Renderer UI (Google sign-in → pick Shared Drive + folder → join) | ✅ done |
| 4b | Drive parity: persistence, **publish history** (v17), COTS-on-Drive, SolidWorks REST | ✅ done (shipped v5.1.0) |
| 5 | Git rip-out — client **and** server LFS (the destructive "full replacement") | ⬜ NOT started — staged on `chore/remove-git` |

**Build/typecheck (all green as of this session):**
- `npm run build` — desktop builds clean.
- `npx tsc --noEmit -p tsconfig.node.json` — **18 errors, all pre-existing baseline**
  (`git.ts` null-checks + `LockInfo`, `ipc.ts` `projectSubpath`/`cotsSubpath`,
  `lfsMultipart.ts`, `rest.ts`). None from this work. Ships via esbuild (skips typecheck).
- `server/ npx tsc --noEmit` — **0 errors**.

## Piece 2 — ipc.ts routing (DONE)

`src/main/ipc.ts` now imports `driveOps`, `driveProject`, `googleAuth` and branches on
`driveProject.isOpen()` in every backend verb:
- `open-project` tries `driveProject.open(dir)` first (folder with `.framecad/drive-manifest.json`),
  falls back to git. Sets `currentProject`, `setRestProject`, `startWatching`.
- `sync` → `driveProject.sync` (with publish-progress events + the same "Downloaded N files" notification).
- `publish` → `driveProject.publish` (publish-progress events).
- `get-status` → `driveProject.status()`. `get-history` → `[]`. `get-remote-ahead`/`get-local-ahead` → `0`.
- `notifyFileChange` (watcher) → `driveProject.status()` instead of manifest-sync→getStatus.
- `close-project` calls `driveProject.close()`.
- New handlers: `google-auth-status/-sign-in/-sign-out`, `drive-list-shared-drives`,
  `drive-list-folders`, `drive-join-project` (join sets currentProject + watcher + emits join-progress).
- `driveProjectKey()` helper resolves the open project's Drive folder id (throws if none) — used by the lock handlers.

## Piece 3 — server locks (DONE + VERIFIED)

**Keying decision (was open in the old handoff): locks are keyed on a free-text `projectKey`
= the Drive folder id**, NOT a FK to the `projects` table. Rationale: Drive projects are never
registered in `projects` (that table is keyed on a GitHub repoUrl). Documented in the migration.

- `server/src/db.ts` — migration **v15**: `locks(id, projectKey, filePath, ownerMemberId→members ON DELETE CASCADE, ownerName, lockedAt, UNIQUE(projectKey,filePath))` + `locks_projectKey_idx`.
- `server/src/routes/client.ts` — three routes under the existing `/api/projects` auth preHandler:
  - `GET  /api/projects/:key/locks` → `{ locks: [...] }`
  - `POST /api/projects/:key/locks` `{filePath}` → acquire; idempotent for owner; **409** w/ holder name otherwise; race-safe (catches UNIQUE violation and re-reads the winner).
  - `DELETE /api/projects/:key/locks` `{filePath, force?}` → release; owner always; mentor/admin can force; non-owner student **403**; releasing a non-existent lock is idempotent `{ok:true}`. Audit logs `lock.acquire` / `lock.release` / `lock.force-release`.
- `src/main/teamServer.ts` — `DriveLock` type + `listDriveLocks` / `acquireDriveLock` / `releaseDriveLock(key, path, force?)` (all via `fetchTeamApi`, 6s timeout).
- `src/main/ipc.ts` — `check-out`→`acquireDriveLock`, `check-in`→`releaseDriveLock`, `force-check-in`→`releaseDriveLock(force=true)`, `get-locks`→`listDriveLocks` mapped to `LockInfo{path,owner,id}` (degrades to `[]` offline). **No `toGitRel` translation** for Drive — Drive status paths are already project-relative.

**Live-verified this session** (ran `tsx src/index.ts` against a temp DB, enrolled admin+student via PINs, curl'd every path): empty-list, acquire, idempotent re-acquire (same owner), missing-filePath 400, release, idempotent re-release, 401 unauth, 409 cross-user conflict, admin force-release, student-403-on-others'-lock, project-key isolation (same path under a different key is free), and audit rows all correct.

## Piece 4 — renderer UI (DONE)

- `src/renderer/src/components/DriveJoin.tsx` — NEW. Four-step linear flow: Google sign-in
  (loopback OAuth in main) → pick Shared Drive (`driveListSharedDrives`, refreshable) →
  pick top-level folder (`driveListFolders`) → pick local save path → Join. Sign-out + refresh
  controls. Errors shown inline. Download progress is handled by the **existing App-level
  join-progress modal** (same one the git clone uses), so DriveJoin doesn't re-implement it.
- `src/renderer/src/hooks/useGit.ts` — added `joinDriveProject(args)` (calls `driveJoinProject`,
  then `getProjectConfig` + `fetchAll`, transitions into the project view).
- `src/renderer/src/App.tsx` — destructures `joinDriveProject`, passes it as `onJoinDriveProject`.
- `src/renderer/src/components/ProjectSetup.tsx` — new `'drive'` mode renders `<DriveJoin>`;
  an always-visible **"Join from Google Drive"** outline button on the welcome screen (no team
  enrollment required, since Drive auths against Google directly).

## Drive parity — DONE (shipped to main, v5.1.0)

Drive now has full feature parity; git remains a dormant runtime-routed fallback.
- Parallel transfers + background staging (promote-by-move on publish), freeze/idle-GPU fixes.
- Backend-agnostic persistence (`persistence.ts`): parts.json / parts-meta.json / admin.json
  upload straight to the Drive project folder (`drive.ts` pullMetadataFile/pushMetadataFile).
- Publish **history** via the team server (`publish_log` table + `/api/projects/:key/history`;
  `get-history` and publish both wired through `teamServer`).
- **COTS on Drive** (`drive.ts syncCotsDrive`, admin `cotsDriveFolderId`/`cotsSharedDriveId`).
- **SolidWorks REST** (`rest.ts`) Drive-routed: status/file/locks/checkout/checkin/sync/publish.
- `project-paths.ts` extracted from git.ts; admin/parts/meta/thumbnails/documents off git.ts.

## Piece 5 — git rip-out (NOT started — destructive; staged on `chore/remove-git`)

The app still *coexists* with git as a fallback. The deletion is mechanical but large; do it as
whole-file rewrites (not incremental edits — those misfired badly mid-session), build-gating each
file, on the `chore/remove-git` branch → PR. Scope:

**Client (`src/`):**
- Delete `git.ts`, `locking.ts`, `lfsMultipart.ts`, `large-files.ts`, `deps.ts`. Drop `simple-git`.
- Rewrite `ipc.ts` + `rest.ts` Drive-only (strip every `else` git-fallback branch + git-only
  handlers: create-project, join-by-URL, github-*, check-dependencies, git-resetup,
  list/create-github-repo, create-progress-tag, renormalize-all, get-main-remote-url,
  scan-large-files). New projects = "folder in Drive + Join" (no in-app create).
- Renderer Phase 5: remove ahead/behind pulse badges, GitHub-URL/LFS join UI + sentinels,
  git-identity → team identity (already aliased in ipc), the create-project flow.

**Server (`server/`) — LFS is now dead weight (Drive holds the bytes):**
- Delete `src/lfs.ts`, the `POST /api/lfs/token` route, `POST /api/admin/test-lfs`, and the
  LFS bits of `storage.ts` / `config.ts` / `routes/admin.ts` / `routes/client.ts`.
- `docker-compose.yml`: drop the `framecad-lfs` (Giftless) + `framecad-lfs-init` containers,
  the `./data/lfs-objects` bind-mount, and the `LFS_JWT_SECRET` env requirement → stack
  collapses to one Node container + SQLite. Update `server/README.md` + `.env.example`.
- DB: the LFS policy columns on `team` (`lfsTokenTtlMinutes`, `quotaGraceHours`, etc.) can stay
  (cheap, additive) or be dropped in a new migration — leave for now.
- Client `teamServer.ts` still references `/api/lfs/token`; remove with the client git rip-out.

After this the server's job is purely team coordination: identity/enrollment, locks, publish
history, team config + Shared Drive allowlist, capabilities, audit, version banner. It no longer
touches a CAD byte.

## Still needs Trent / a real environment to exercise end-to-end

- **Live Google OAuth**: needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars
  (see `docs/google-workspace-setup.md`) and a real Workspace + Shared Drive. The picker UI,
  download, publish, and sync paths can only be exercised with real creds.
- **End-to-end GUI round-trip**: sign in → join → edit → publish → sync on a 2nd machine.
- **Locks against the deployed server**: verified locally this session; confirm against the
  team's actual server once the desktop points at it.

## Possible follow-ups (not required for the feature to work)

- Admin web UI "Locks" page (view / break locks) — server API supports it; no UI yet.
- Conflict UX on sync (current behavior: local edits always win, never silently clobbered).
- New-project creation flow on Drive (currently "make a folder in Drive + Join"; no in-app create).

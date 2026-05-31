# Google Drive backend — work-in-progress handoff

Branch: **`feat/google-drive-backend`** (off `main` @ v5.0.3).
Goal agreed with Trent: **full replacement** of Git/LFS with Google Drive, end-to-end,
with **check-out/check-in locks moved to the team server**.

## Status summary

| Piece | What | State |
|-------|------|-------|
| 1 | Engine + types + config + drive.ts / drive-project.ts / google-auth.ts | ✅ done |
| 2 | ipc.ts routing (sync/publish/status/locks branch on `driveProject.isOpen()`) | ✅ done + builds |
| 3 | Server-side locks (migration v15 + routes + teamServer client + ipc wiring) | ✅ done + verified live |
| 4 | Renderer UI (Google sign-in → pick Shared Drive + folder → join) | ✅ done + builds |
| 5 | Git rip-out (the actual destructive "full replacement") | ⬜ NOT started — left for Trent |

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

## Piece 5 — git rip-out (NOT started, leave for Trent — destructive)

The Drive backend currently **coexists** with git (runtime-routed). That's a fine transition
state — the app does both. Ripping out `git.ts` (imported by 10 main modules: admin, thumbnails,
parts, large-files, locking, documents, rest, meta, ipc, +test) is the big destructive step.
parts/meta/thumbnails are mostly filesystem; publish/locking/history are git. **Recommend Trent
explicitly green-lights this** — don't do it autonomously.

## Still needs Trent / a real environment to exercise end-to-end

- **Live Google OAuth**: needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars
  (see `docs/google-workspace-setup.md`) and a real Workspace + Shared Drive. The picker UI,
  download, publish, and sync paths can only be exercised with real creds.
- **End-to-end GUI round-trip**: sign in → join → edit → publish → sync on a 2nd machine.
- **Locks against the deployed server**: verified locally this session; confirm against the
  team's actual server once the desktop points at it.

## Possible follow-ups (not required for the feature to work)

- Admin web UI "Locks" page (view / break locks) — server API supports it; no UI yet.
- Drive revision history (`get-history` returns `[]` today).
- Conflict UX on sync (current behavior: local edits always win, never silently clobbered).

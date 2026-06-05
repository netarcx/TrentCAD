# FrameCAD Pre-Release Test Plan

> Target release: desktop **5.1.6** / server **5.0.12**
> Status key:  ⬜ not tested · 🟡 in progress · ✅ pass · ❌ fail · ⏭️ N/A
>
> Priority key:  **P0** = release blocker (data integrity / can't ship without) ·
> **P1** = core workflow · **P2** = secondary / polish

This is a living checklist. Each item describes the behavior to verify from a
**user's** perspective, plus how to confirm it. Code-level audit findings get
noted inline under each item.

---

## P0 — Release Blockers

### 1. SolidWorks assembly references survive a cross-machine, cross-folder move  ⬜

**Why it's P0:** This is the #1 way a CAD collaboration tool silently corrupts
data. If references break when a teammate joins a project into a different local
folder, every multi-part assembly is at risk.

**What the code guarantees (audited 2026-06-05):**
- Manifest keys every file by its path *relative to the project root* (forward
  slashes), never an absolute path — `drive-manifest.ts` (`path.relative(rootDir, fullPath)`).
- On download, PC 2 rebuilds each file via `path.join(localPath, ...relativePath.split('/'))`
  with `fs.mkdir(..., { recursive: true })` — the full nested subfolder tree is
  recreated identically under the new root (`drive.ts`). Nothing is flattened or renamed.
- FrameCAD never opens or rewrites CAD bytes (streamed verbatim; `parts.ts`
  explicitly does *not* parse `.sldasm` references). So it cannot corrupt internal links.

**Conclusion from audit:** the FrameCAD side is safe **as long as every referenced
file lives inside the project folder tree.** The remaining risk is SolidWorks'
own reference resolution for files *outside* the tree — which only a real
two-machine test can certify.

**Manual test (do before shipping):**
1. On **PC 1**, publish a project containing a **multi-level assembly**
   (subassembly → parts) in nested subfolders. Include at least one **Toolbox**
   component and one **COTS** part if your assemblies use them.
2. On **PC 2**, join the project into a **deliberately different local path**
   (different drive letter if possible — e.g. `D:\cad\proj` vs `C:\Users\x\proj`).
3. Close SolidWorks first, then open the top-level assembly **fresh** (so nothing
   resolves from memory).
4. **File ▸ Find References** — confirm every path points *inside the new root*,
   with **no "missing" / "replaced" / "suppressed"** components and no absolute
   paths leaking back to PC 1.
5. Rebuild (Ctrl+Q) — confirm **no mate errors**.

**Known caveats to watch (SolidWorks-environment, not FrameCAD bugs):**
- **Toolbox hardware** — resolves by a central Toolbox path. PC 2 must have
  Toolbox configured at the same/standardized location or those components go
  missing. Standardize Toolbox across team machines.
- **Library / shared parts stored outside the project** (e.g. a part referenced
  from someone's Desktop or a personal network drive) — absolute path won't exist
  on PC 2.
- **COTS** — fine if assemblies reference COTS via the relative path into the
  synced `COTS/` subfolder; risky if referenced from an absolute library location.
  ✅ **RESOLVED by audit (2026-06-05):** the COTS folder is deterministically
  rooted at `<projectRoot>/COTS/...` on every machine (`drive.ts` — `path.join(projectDir, 'COTS')`,
  unaffected by `cotsSubpath`, which is display-only). Relative paths into it are
  folder-structure-driven and identical across clients, so SolidWorks references
  to COTS parts resolve consistently cross-machine. The remaining risk is only
  *absolute-path* references to a COTS library stored outside the project.

---

## P1 — Core Workflows

### 2. Onboarding / identity  ⬜
- [ ] Google OAuth sign-in (loopback) succeeds; token persists across restart
- [ ] Google sign-out revokes + clears credentials
- [ ] Team-server enrollment via 6-char PIN (display name + device label)
- [ ] Admin bootstrap PIN from `SETUP_PIN.txt` consumed on first server launch
- [ ] Team sign-out revokes device enrollment
- [ ] Revoked device (server 401) flips client back to enroll screen, does not re-grant admin

### 3. Project lifecycle  ⬜
- [ ] Join a Drive project → full folder tree downloads + manifest created
- [ ] List Shared Drives / list folders in the join picker
- [ ] Open an already-joined local project
- [ ] Sync pulls teammates' latest changes; progress + completion notification
- [ ] Publish uploads local changes to Drive + records publish on server
- [ ] Status tree shows modified / new / missing correctly
- [ ] History shows recent publishes (newest first)
- [ ] Close project flushes pending metadata + tears down watcher

### 4. Collaboration / locks  ⬜
- [ ] Check out acquires a lock; visible to all team members
- [ ] Check in releases the lock
- [ ] Checking out an already-locked file shows 409 with holder's name
- [ ] Force check-in (with capability) breaks another user's lock
- [ ] Lock state shown in file tree (locked-by-you vs locked-by-other) and takes priority over modified state

### 5. Part numbering  ⬜
- [ ] Auto-assign numbers on first open (`YY-2129-XX-YYY` format)
- [ ] New Part / New Assembly create pre-named files with correct numbers
- [ ] Create subsystem (folder, no number)
- [ ] Drawing shares the number of the part/assembly with the same basename
- [ ] Deleted entries become tombstones — numbers never reused
- [ ] Manifest integrity check: duplicate PNs, orphaned drawings, missing files

### 6. Metadata + release states  ⬜
- [ ] Set release state: draft → in-review → released → manufactured
- [ ] Setting an assembly to in-review cascades to contained parts (except already-manufactured)
- [ ] Mass, cost, comments persist and sync
- [ ] Mfg method (print / cnc / manual / purchase / other) + material + notes
- [ ] Metadata syncs to whole team (deferred-commit batching; flush on publish)
- [ ] parts-meta.json conflict markers merge cleanly
- [ ] Project totals (mass + cost) aggregate correctly

---

## P1 — Release Pipeline / Shop (the roadmap goals)

### 7. Manufacturing queue + shop dashboard  ⬜
- [ ] Released parts appear in the manufacturing queue grouped by method/material
- [ ] 3D-print / CNC / manual / purchase routes show the right parts
- [ ] Shop-dashboard / kiosk view (full screen)
- [ ] Mark part "done" → transitions to manufactured + records who + location
- [ ] Operator initials persist across the session
- [ ] **Part location** recorded and visible (roadmap Phase 4, goal 5)

### 8. Purchasing release route  ⬜
- [ ] Purchase-method parts capture vendor / SKU / unit cost / URL / qty / status
- [ ] Purchasing release route behaves per roadmap Phase 3, goal 4

---

## P1 — Permissions / Roles

### 9. Server-managed permissions  ⬜
- [ ] Role tiers: admin / mentor-manager / trusted-student behave distinctly
- [ ] Capability flags gate actions (force check-in, manage CAD structure, create project, manufacturing view, etc.)
- [ ] Project allowlist restricts a member to specific projects (empty = all)
- [ ] **Server-side enforcement** is primary; client gating is secondary (verify a capability can't be bypassed by the client)
- [ ] Auto-open / kiosk flags on a PIN

---

## P1 — Admin Web UI (server)

### 10. Admin surfaces  ⬜
- [ ] First-launch wizard: team info → first project → first member
- [ ] Dashboard overview
- [ ] Members: edit role / capabilities / allowlist / delete
- [ ] Pins: create / view / delete with role + caps + TTL + flags
- [ ] Projects: Shared-Drive allowlist (add/edit/quota/archive)
- [ ] Team settings: name, prefix, welcome msg, max file size, blocked extensions
- [ ] Version status: server vs latest; client devices with version + last-seen
- [ ] Audit log: who/what/when

---

## P1 — SolidWorks Add-in

### 11. Add-in task pane  ⬜
- [ ] Health polling shows connected / offline (port 42129)
- [ ] Check out / check in / sync / publish buttons work from inside SolidWorks
- [ ] Part number + status + lock state for the active document
- [ ] Release state + mfg method + material editable from the pane
- [ ] Auto-refresh on document switch
- [ ] `/api/coord-state` role-gating shape preserved

---

## P2 — Secondary / Polish

### 12. Archive mode (read-only local mirror)  ⬜
- [ ] PIN with `archiveMode=true` makes the device read-only (no checkout/publish)
- [ ] Choose archive root → one subfolder per project
- [ ] Continuous sync loop keeps mirrors current (publish-log poll + periodic full sync)
- [ ] Server rejects write endpoints for archive devices
- [ ] Archive dashboard shows per-project sync status

### 13. COTS mirroring  ⬜
- [ ] COTS Drive folder mirrors into the project's `COTS/` subfolder
- [ ] COTS project flag skips part-numbering (read-only library)
- [ ] **AUDIT:** confirm the COTS folder sits at the same relative path on every
      machine (ties back to §1 reference resolution)

### 14. Misc  ⬜
- [ ] Update / version banner when desktop or server is outdated
- [ ] Recent projects list + pin/unpin
- [ ] Thumbnails render for parts
- [ ] Document generation (BOM / mfg docs) if shipping this release
- [ ] Subpath projects limit visible files to a subfolder
- [ ] File-size / blocked-extension policy enforced on publish

---

---

## Audit findings — full systematic code audit (2026-06-05)

7 parallel deep-audit passes across all areas. **No BLOCKERs found.** Findings
below by severity. "Decision" = behavior may be intended; needs Trent's call.

### Resolution status — fixed in 5.1.7 / 5.0.13 (2026-06-05)

**✅ Fixed this release:**
- **A2** — **Part numbers are now server-coordinated** (optimistic-local + reconcile).
  New `part_numbers` table (migration v20) + `POST /api/projects/:key/part-numbers/claim`
  enforce uniqueness atomically (UNIQUE constraint, like locks). `createNewPart`/
  `createNewAssembly` compute locally then CLAIM; an online collision is resolved
  transparently at creation (file isn't saved yet, so no rename). Offline → a
  `provisional` number; `reconcilePartNumbers()` (runs on open/join) re-claims it
  on reconnect — clean if free, or surfaces a **conflict notice** with a suggested
  number if a teammate took it (never auto-renames — the user fixes it in
  SolidWorks so references update). Scope notes: (a) auto-numbering of files
  already on disk stays local (its candidate already accounts for the local max,
  so explicit creates never collide with it; the only residual is two clients
  auto-numbering *different* files the same counter at once — metadata-only, no
  rename); (b) the folder number (XX) for a part in a brand-new folder isn't
  separately claimed, only the part counter + bare top-level assembly are; (c) the
  conflict resolution is a notification today — an in-UI / add-in rename flow is a
  follow-up.
- **A1** — Auto-assign wired into open + join (`syncManifest` now runs); files saved
  directly in SolidWorks get numbered, renames/deletes tracked. NEW **"Imported
  project"** admin flag (`isImportedProject`, parallel to COTS) + ProjectSettings
  toggle: an imported project preserves its existing numbers (forces legacy
  adoption), so importing never renumbers a previous season / another team.
- **A3** — publish/sync now `await parts.flushNow()` first (App.tsx wrappers) — no
  more lost metadata edits within the 1.2s debounce.
- **A4** — `/api/enroll` now has a per-IP brute-force throttle (20 fails/15min →
  15min lockout), dependency-free; generous so a NATed classroom won't lock out.
- **A7** — add-in mfg-method combo now includes `purchase`.
- **A8** — `DoSync`/`DoPublish` null-coalesce → real server error instead of NRE.
- **A9** — partial join now writes a partial manifest (Open + Sync heals) instead
  of stranding a manifest-less folder.
- **A6** — first-launch wizard project step reworked for **Google Drive**: collects
  a Drive folder ID + Shared Drive ID, auto-adds the Shared Drive to the team
  allowlist (merge, not clobber) so the project is actually joinable, and
  registers a real Drive project. Stale GitHub "clone URL" framing removed; the
  GitHub-org field kept but clearly marked optional/secondary.
- (bonus) stale "GitHub"→"Shared Drive" comments in the two patched add-in methods.

Plus, in this same batch:
- **A5** — `docs/SECURITY-MODEL.md` written: documents which controls the server
  enforces vs. the 5/6 capability flags that can't be (Drive ACLs are the real
  file boundary).
- **A2 hardening** — fixed two offline-path bugs found in self-review: (1)
  `createNewPart`/`createNewAssembly` no longer roll back + throw when offline
  (the provisional entry is kept for reconcile); (2) reconcile re-attaches
  provisional entries the `pullSharedFile` would otherwise clobber. Also wired
  **on-disk auto-numbering through the server** (auto-assigned entries are
  `provisional`, reconciled on reconnect — safe in-place relabel for label
  files, conflict-notice for files named by their number).
- **A2 review fixes** (from a `/code-review high` pass before commit): (1)
  `createNewAssembly` no longer reassigns an *existing* folder number on a
  collision (was desyncing parts under that folder); (2) a server-suggested
  counter that's free in the registry but already used in local `parts.json`
  (mid-season adoption) is now skipped — prevents **duplicate numbers**; (3)
  `createNewPart`/`createNewAssembly` now run under `manifestLock` (unifying the
  IPC + REST add-in paths) so a concurrent create + background reconcile/sync
  can't clobber each other's `parts.json` write; (4) a reconcile relabel now
  follows linked drawings so a drawing can't keep a stale number.

**⏳ Deferred — fix later:**
- **A2 follow-ups** — in-UI/add-in rename flow for an offline-number conflict
  (today it's a desktop notification + the conflict list); optionally coordinate
  folder (XX) numbers for a part created in a brand-new folder (rare edge).
- **Minors:** add-in user-facing "GitHub" tooltips (TaskPaneControl.cs:258/264);
  lock TTL/staleness; purchase `unitCost×qty` → cost rollup; release-state machine
  (any transition allowed); root-assembly in-review cascading project-wide;
  `welcomeMessage` length cap; `parts.json.tmp` watcher exclusion; enroll-link
  browser 404; dead `newerOnRemote` banner.


### MAJOR — fix or decide before release

| # | Area | Finding | Disposition |
|---|------|---------|-------------|
| A1 | Part numbering | **Auto-assign / tombstone / rename-tracking engine is unwired in production.** `syncManifest`/`assignPartNumber`/`handleFileMoves` have *zero* callers outside tests (verified). Numbers are assigned ONLY via the "New Part/Assembly" buttons + add-in dialog. A `.sldprt` saved directly in SolidWorks, pulled via Sync, or made with Save-As gets **no number**; renames orphan the manifest entry; deletes leave no tombstone. Contradicts CLAUDE.md spec. `parts.ts` | **DECISION:** is explicit-create the intended workflow (then fix docs/tests), or should auto-assign run on open/sync (then wire `syncManifest` in)? |
| A2 | Part numbering | **Cross-client number race.** create-part does pull→compute-next→write→push with no Drive CAS / server coordination. Two near-simultaneous creators get the same number; the loser's push silently overwrites. Locks use server-side UNIQUE; numbering doesn't. `parts.ts` | DECISION: acceptable at team scale, or coordinate numbers server-side like locks? |
| A3 | Metadata | **Lost-write window on publish/sync.** Renderer edit queue (1.2s debounce, `useGit.ts`/`useParts.ts`) isn't flushed before publish; main-side flush has nothing to flush. Edit a Parts Manager cell + Publish within 1.2s → edit misses *this* publish, ships later. Fix: `await parts.flushNow()` before the publish/sync IPC. | **FIX** |
| A4 | Security | **`/api/enroll` not rate-limited** — 6-char PIN (32⁶) brute-forceable on an internet-exposed server. `/api/login` *is* rate-limited; enroll (higher value) isn't. `server/src/routes/public.ts` | **FIX** (add `@fastify/rate-limit`) — required only if server is ever internet-exposed; LAN-only can defer |
| A5 | Permissions | **5 of 6 capability flags are not (and structurally cannot be) server-enforced** — createProject, browseTeamProjects, openProject, manufacturingView, manageCadStructure have no server route (Drive holds the bytes). Only `forceCheckIn` is server-gated. Real boundary = Google Drive ACLs, not FrameCAD flags. | **DOCUMENT** the trust boundary; ensure the Shared Drive is tightly ACL'd |
| A6 | Admin UI | **First-launch wizard's "first project" step is GitHub-repo-shaped** (collects Repo URL, never sets the Shared-Drive allowlist) in a Drive-only product. Vestigial from the Git/LFS migration. `server/ui/src/pages/Wizard.tsx` | **FIX or remove** the wizard project step |
| A7 | Add-in | **`purchase` missing from the mfg-method combo** (`TaskPaneControl.cs:421` vs `rest.ts` validMethods). Purchase-method parts display wrong in the pane and get silently overwritten if the combo is touched. | **FIX** (one-line: add `"purchase"`) |
| A8 | Add-in | **`DoSync`/`DoPublish` NRE on a non-JSON error body** — the two primary buttons surface "Object reference not set…" instead of the real server error. Other API methods null-coalesce; these two don't. | **FIX** (mirror the `?? new …{Success=false}` pattern) |
| A9 | Lifecycle | **Failed join strands a manifest-less folder** — if `downloadProject` throws mid-way, partial files remain with no `drive-manifest.json`; later "Open" fails, re-join re-downloads everything. Not corruption, but non-self-healing. `drive.ts` | **FIX** (cleanup-on-failure or resumable join) |

### MINOR — polish / note (none block release)

- **Add-in still says "GitHub"** in two *user-facing* tooltips (`TaskPaneControl.cs:258,264`) + several stale code comments, in a Drive-only product. → fix the user-visible copy.
- **No lock TTL/staleness** — a crashed/abandoned checkout stays locked until force-check-in. Confirm intended.
- **Purchase `unitCost × qty` never feeds cost totals / BOM** — purchased parts' price is invisible to rollups unless re-typed into the Cost field.
- **No release-state machine** — any transition allowed (e.g. manufactured→draft via bulk edit, no confirm). Only client role-gating guards it. Confirm acceptable for trusted mentors.
- **Root-level assembly → in-review cascades to the *entire* project** (one click flips every draft part). Sharp edge; may be intended for a top-level robot assembly.
- **Unregistered Drive folders bypass the project allowlist** (by design — registry is opt-in). Real boundary again = Drive ACLs.
- **`welcomeMessage` / team text fields have no length cap** server-side — unbounded data fans out to every client on each `/api/team`. (Not XSS — React escapes.)
- **`parts.json.tmp` not excluded from the watcher** — spurious status refresh on each part create (no infinite loop; status path is read-only for parts.json).
- **Auth cost under no-rate-limit**: each request argon2-verifies the token against every device row + writes `lastSeenAt` — a bogus-token flood can saturate CPU (better-sqlite3 is synchronous). Compounds A4.
- **Enroll link `/enroll/<PIN>` 404s in a browser** (no SPA fallback) — confirm the intended consumer is the desktop app, not a browser.
- **`newerOnRemote` is permanently false** → the add-in's "newer version available" banner is dead UI. Document-or-remove.
- **Add-in publish timeout (10 min) vs unbounded server publish** — a slow large-assembly upload can have the add-in give up while the server completes.
- Archive: `syncNow` no-ops during an in-flight tick (button feels dead); no resume on a partial first-time mirror download.
- `syncCotsDrive` aborts the whole pass on the first failed file (not truly per-file best-effort, despite its comment) — self-heals next sync.

### Verified SOLID (high confidence — stated for the ship decision)

- **§1 path handling** — relative paths, exact nested-tree rebuild, CAD bytes never modified. ✅
- **COTS path determinism** — `<projectRoot>/COTS/...` on every machine; SolidWorks-reference-safe. ✅
- **Revoked-device handling** — 401 → clears state, flips to enroll, does *not* re-grant standalone admin. ✅
- **Manifest atomicity** (tmp+rename) + **partial-failure integrity** on sync/publish (persists what transferred, re-throws). ✅
- **Main-thread freeze mitigations** — per-request Drive timeouts, concurrent hashing, (mtime,size) hash cache, single-flight status pass. ✅
- **Locks** — atomic via UNIQUE constraint (no TOCTOU), capability-gated server-side, no add-in force-bypass, cascade-clean on member delete. ✅
- **Core authorization** — admin gating on all `/api/admin/*`, allowlist on registered projects, archive write-blocks on all 3 mutating routes, dev-reset triple-gated, enroll identity PIN-bound (no escalation). ✅
- **Archive read-only** — enforced on both client (UI replaced) and server (`denyArchive`). ✅
- **Token security** — 256-bit CSPRNG, argon2id at rest, looked up by hash. ✅
- **REST API** — loopback-only bind, CSRF Origin guard, path-traversal sanitization, write-serialization mutex. ✅
- **`/api/coord-state` contract** preserved for the add-in. ✅
- **Add-in COM hygiene** — SafeRelease everywhere, no RCW leaks, polling timer single-flighted + disposed. ✅
- **Admin UI** — append-only audit log, idempotent migrations, self-lockout guards, strong input validation on PINs/quota/team policy, SSRF defense on repo-check, no XSS sinks. ✅
- **Watcher / thumbnails / documents** — no watcher leak on open/close; both gen paths async (no main-thread block). ✅

## Notes / open questions

- (2026-06-05) §1 FrameCAD path-handling audited and confirmed safe; manual
  two-machine SolidWorks test still required before sign-off.
- (2026-06-05) Full systematic audit complete — see findings above. No blockers;
  9 MAJOR (5 fixes, 4 decisions) + assorted minors.

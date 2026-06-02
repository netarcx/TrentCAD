# FrameCAD — Roadmap to the product goals

Maps the current code to the [product goals](../CLAUDE.md) and lays out a
dependency-ordered plan to close the gaps. Status as of v5.1.3 / server 5.0.9.

## Where we are

| # | Goal | Status |
|---|------|--------|
| 1 | Easy-to-set-up/use SolidWorks PDM | ✅ Met |
| 2 | Admin manages connected systems from the server | ✅ Met |
| 3 | SolidWorks plugin (first-class) | ✅ Met |
| 4 | Release pipeline: 3D Print / Purchasing / CNC | ⚠️ Partial (no Purchasing) |
| 5 | Shop dashboard: mark finished **+ location** | ⚠️ Partial (no location; operator = typed initials) |
| 6 | Server-driven tiered permissions | ⚠️ Partial (3 roles; enforcement is client-side UI; no per-project authz) |
| 7 | Trusted-student tier (manage CAD structure) | ❌ Gap (file-structure ops are mentor-gated) |

**The keystone:** the server `projects` table is `repoUrl NOT NULL UNIQUE` with
no Drive identity (`server/src/db.ts:135`), so Drive projects are never
registered. That single fact blocks per-project permissions (goal 6), the
trusted-student/per-project model (goal 7), and kiosk auto-open. **Phase 1 fixes
it; everything else builds on it.**

---

## Phase 1 — Drive Project Registry (keystone) → unblocks 5(kiosk), 6, 7

Make a Drive project a first-class server record so locks, history, the
allowlist, and kiosk can all key on it.

**Server**
- DB migration (table-rebuild, since SQLite can't drop the `repoUrl` UNIQUE/NOT-NULL in place): rebuild `projects` with `repoUrl TEXT` nullable, add `driveFolderId TEXT`, `sharedDriveId TEXT`, and a `UNIQUE INDEX … WHERE driveFolderId IS NOT NULL`. Copy existing rows. (Test against a copy of a live `data/` first.)
- `POST /api/admin/projects`: accept a Drive project (name + driveFolderId + sharedDriveId, repoUrl optional) — relax the "repoUrl required" check (`admin.ts:386`).
- `/api/projects` + `/api/admin/projects`: return `driveFolderId`.
- Admin web UI (`ui/pages/Projects.tsx`): "Add Drive project" — pick a Shared Drive + top-level folder (or paste a folder id) and name it.

**Client**
- On Drive join, record the project's folder id (already on `ProjectConfig`); the server matches a registered project by `driveFolderId`.
- Kiosk auto-open matches recents by `driveFolderId` (already wired, `App.tsx`).

**Acceptance:** an admin can register a Drive project; `autoOpenProjectId` can point at it; a kiosk device auto-opens it; `allowedProjectIds` can reference it.
**Risk:** the `projects` table rebuild on a live DB — the one genuinely risky migration. Snapshot `data/` before deploy; gate behind a tested migration with a row-count assertion.

---

## Phase 2 — Permission model + server-side enforcement → goals 6, 7

Today roles are `admin | mentor | student` (`types.ts:280`) and the 4 capability
flags (`types.ts:337`) gate only the **client UI**. The vision's 4 tiers
(admin / mentor-manager / trusted-student / student) map cleanly to
**capability bundles** on top of the 3 roles — more flexible than a rigid role
enum and far less migration churn.

**Shared types / server**
- Extend `MemberCapabilities` with: `manageCadStructure` (the "trusted student" power), `manageMembers` + `issuePins` (the "mentor-manager" powers), `forceCheckIn`. (PIN issuance already carries capabilities.)
- Admin web UI: present capability **presets** named "Student / Trusted Student / Mentor / Mentor-Manager / Admin" so the 4 tiers are first-class in the UI without a role-enum explosion.
- **Server-side enforcement** on everything the server mediates:
  - Lock/history routes (`client.ts:419-580`): authorize `:key` against the caller's `allowedProjectIds` via the Phase-1 registry (closes review finding #7 — currently any enrolled device can lock any folder).
  - `force-release`: gate on the `forceCheckIn` capability (not just role).
  - Member management / PIN issuance routes: gate on `manageMembers` / `issuePins` (lets a "mentor-manager" do it without full admin).

**Client**
- Gate the CAD-structure ops (new part / assembly / subsystem) on `manageCadStructure` instead of `isMentor` (`App.tsx:449`, Parts view) — this is goal 7.
- Drive capabilities/role into the UI from the snapshot (already there); add the new caps.

**Acceptance:** a student PIN with `manageCadStructure` can create parts/assemblies but not release; a mentor-manager can issue PINs without being admin; a student restricted to project A is rejected (server-side) from project B's locks.
**Risk:** medium — additive capability columns; the enforcement moves are localized to routes that already have `req.member`.

---

## Phase 3 — Release pipeline: the Purchasing route → goal 4

`ManufacturingMethod` is `print | cnc | manual | other` (`types.ts:39`) — 3D-print
and CNC are real (CAM `.stl`/`.step` export + a method-grouped queue). Purchasing
is missing.

- Add `'purchase'` to `ManufacturingMethod`, and a `purchase` block to `PartMeta`: `{ vendor?, sku?, qty?, unitCost?, url?, orderStatus: 'to-order' | 'ordered' | 'received' }`.
- A **Purchasing view** (sibling of the manufacturing queue): released parts with `method === 'purchase'`, grouped, with actions to mark **ordered** / **received** (mirrors the shop "Done" flow).
- REST + add-in: allow setting `method = 'purchase'` from SolidWorks (the existing `/api/manufacturing-method` already takes a method).

**Acceptance:** a released part marked "purchase" shows in the Purchasing view; a purchaser can record vendor + mark it ordered → received.
**Risk:** low — additive metadata + a new view; reuses the release/queue machinery.

---

## Phase 4 — Shop dashboard: location + authenticated operator → goal 5

Marking finished works (`ManufacturingQueue.tsx:115` → state `manufactured`,
"Finished by {initials}"). Missing: **where the part is**, and the operator is
typed initials, not an identity.

- Add `location?: string` (or structured `{ area?, shelf?, bin? }`) to `PartMeta` (or to `PartReleaseInfo` for the manufactured state). Capture it in the "Done" dialog.
- Authenticated operator: on an enrolled shop machine, attribute "finished by" to the team member (fall back to the typed-initials prompt only when not enrolled). Ties into Phase 2 identity.
- Shop dashboard: show manufactured parts **with their location** ("where is part X") and a filter/search.

**Acceptance:** clicking Done captures a location; the dashboard answers "where is 26-2129-01-007" and who finished it.
**Risk:** low — additive metadata + UI.

---

## Phase 5 — PDM polish (goal 1) + remaining review items

Foundational quality that makes the PDM feel "Apple-level" and clears the
deferred review findings.

- **Wire the part-number engine into the Drive status path** (review #17): `syncManifest` / auto-number / move-reconcile are dead on Drive, so files saved directly in SolidWorks never auto-number and renames orphan their entry. This is core to the "auto-numbering PDM" promise (`parts.ts:429`, `drive.ts:406`, `ipc.ts:147`).
- **Offline "lock state unknown"** banner, distinct from "no locks" (review #15) — pairs with the Phase-2 publish lock enforcement.
- **Partial-publish UX** (review #21): "X of Y uploaded, retry to finish" instead of a flat failure.
- **Conflict UX on sync** (handoff follow-up): surface "a teammate published this since your last sync" rather than silent local-wins.

**Risk:** the part-number wiring is the largest item here (real behavior change in the status path); the rest are UX/observability.

---

## Sequencing & dependencies

```
Phase 1 (registry)  ──► Phase 2 (permissions/enforcement)  ──► goals 6, 7
       │
       └──► kiosk auto-open (goal 5 kiosk)
Phase 3 (purchasing)  ─── independent ───►  goal 4
Phase 4 (location)    ─── light dep on Phase 2 identity ──►  goal 5
Phase 5 (PDM polish)  ─── independent ───►  goal 1 quality
```

- **Do Phase 1 first** — it's the keystone (3 reviews have stalled on it) and unblocks the highest-value goals.
- **Phase 2 next** — the permission model is what makes FrameCAD a real multi-role team tool.
- **Phases 3, 4, 5 are largely independent** and can be tackled in any order / in parallel once 1–2 land.

## Verification bar (every phase)

`npm run build` green · `tsc` clean both sides (only the logo.png/JSX baseline) ·
server `tsc` 0 · `npm test` green · and a live round-trip for anything touching
Google OAuth / a real Shared Drive / the deployed team server (can't be
exercised headless).

# FrameCAD Security & Trust Model

This document describes **where FrameCAD's security boundaries actually are** —
which permissions the team server *enforces*, which it can't, and why. Read it
before relying on a capability flag as a security control.

The short version: **the team server is the hard boundary for coordination
(identity, locks, history, the project registry, archive read-only). Google
Drive's own sharing ACLs are the hard boundary for the CAD files themselves.**
Several capability flags are UX affordances + soft team policy, *not* file-access
security — because the server never sees a CAD byte.

---

## The pieces

- **Team server** (`server/`, Node + SQLite) — issues bearer tokens, coordinates
  locks + publish history, holds the member/role/capability records and the
  Drive project registry. **It stores no CAD bytes.**
- **Google Drive** — a team **Shared Drive** holds every CAD file. The desktop
  talks to Drive *directly* with the signed-in user's Google credentials.
- **Desktop client** (`src/`) — talks to the server for identity/locks and to
  Drive for file storage.

Because the file bytes flow **client ↔ Google Drive** and never through the team
server, the server has no place to stand between a user and a file. Google's ACLs
are the only thing that can.

---

## What the server DOES enforce (hard boundary, verified server-side)

These are checked in the Fastify route handlers / middleware, so a hand-crafted
request from a modified client can't bypass them:

| Control | Where |
|---|---|
| **Authentication** — every `/api/me`, `/api/team`, `/api/members`, `/api/projects*` route requires a valid bearer token | `requireDevice` preHandler (`server/src/routes/client.ts`) |
| **Admin gating** — every `/api/admin/*` route requires `role === 'admin'` | `requireAdmin` preHandler (`server/src/routes/admin.ts`) |
| **Project allowlist** — a student may only touch locks/history for a *registered* project on their `allowedProjectIds` | `keyAllowed()` on the lock/history routes |
| **`forceCheckIn` capability** — breaking *someone else's* lock requires admin/mentor role or this flag | lock DELETE route |
| **Archive read-only** — an archive-mode device is rejected on every mutating route (lock acquire/release, publish record) | `denyArchive()` |
| **Part-number uniqueness** — atomic claim; two clients can't take the same number | `part_numbers` UNIQUE constraint + claim route |
| **Enrollment brute-force throttle** — failed PIN attempts are rate-limited per IP | `/api/enroll` (`server/src/routes/public.ts`) |
| **Privilege-escalation guards** — can't self-promote, can't demote the last admin, enroll identity is PIN-bound (not client-supplied), role reuse is upgrade-only | `/api/me`, members PATCH, `/api/enroll` |
| **Token security** — 256-bit CSPRNG tokens, argon2id-hashed at rest, looked up by hash; revocation takes effect on the next request | `server/src/auth.ts` |
| **`dev-reset`** — env-gated (`FRAMECAD_DEV_RESET=1`) + admin-only + `confirm:"RESET"` | admin route |

If you want a *real* guarantee, it's in this table.

---

## What the server does NOT (and structurally CANNOT) enforce

Five of the six capability flags have **no server route to gate**, because the
operations they describe happen client-side, directly against Google Drive:

| Capability | What it gates in the UI | Why the server can't enforce it |
|---|---|---|
| `createProject` | "+ New project" affordances | Project folders are created in Drive by the user's Google account |
| `manageCadStructure` | "+ Part / + Assembly / + Subsystem" | Files + folders are created in Drive directly |
| `openProject` | Opening/joining a project | The bytes are downloaded from Drive with the user's own Google creds |
| `browseTeamProjects` | Seeing other projects in the list | A list-visibility affordance, not an access gate |
| `manufacturingView` | The shop-floor / kiosk queue | A client-side view toggle |

These are **honest UX affordances and soft team policy** — they shape what the
app offers a given member, and a well-behaved client respects them. They are
**not** a defense against a user who edits the client or uses the Google Drive
web UI directly. For those five, the actual access boundary is **Google Drive
sharing on the Shared Drive**, full stop.

`forceCheckIn` is the lone exception: it *is* enforced server-side, because
breaking a lock is a server operation.

---

## Operational guidance (do this)

1. **ACL the Shared Drive tightly.** Membership of the Google Shared Drive — and
   each member's Drive role (Viewer / Commenter / Contributor / Content manager /
   Manager) — is the **real** control over who can read and write CAD files. Set
   it deliberately; don't assume a FrameCAD "student" capability restricts file
   access. See `docs/google-workspace-setup.md`.
2. **Treat the capability flags as policy + UX, not file security.** Use them to
   keep the app tidy and steer normal users; don't rely on them to stop a
   determined one from touching a file their Google account can already reach.
3. **Lean on the controls the server *does* enforce** for the things that matter
   to coordination: the project **allowlist** (for registered projects), the
   **archive** read-only flag, **lock** ownership + force-break gating, and
   **admin**-only team administration.
4. **Keep the server off the open internet unless you mean to.** PIN enrollment
   is throttled, but LAN-only / VPN deployment remains the safest default for a
   team server. If you do expose it, the throttle + password-login lockout are
   your front line; keep the desktop + server versions current.

---

## TL;DR

- Server = hard boundary for **identity, locks, history, registry, archive,
  part-number uniqueness, admin**. Trust it for those.
- Google Drive ACLs = hard boundary for **the CAD files**. Trust *them* for file
  access.
- The `createProject` / `manageCadStructure` / `openProject` / `browseTeamProjects`
  / `manufacturingView` flags are **UX + policy**, not security. Don't treat a
  capability checkbox as a lock on a file.

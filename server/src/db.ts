/**
 * SQLite layer for the FrameCAD team server.
 *
 * One file at `${DATA_DIR}/framecad.db`. better-sqlite3 is synchronous
 * (it uses libsqlite3 under the hood and runs on the main thread); for
 * a single-team server with a handful of writes/minute that's the
 * cheapest path. The whole codebase reads/writes through prepared
 * statements via the exported helpers — never raw string SQL from
 * route handlers, so injection surface is zero.
 *
 * Migrations are an additive list. The `user_version` PRAGMA tracks
 * how many have been applied; on boot we run any with index ≥ that
 * value. Safe to call multiple times.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { config } from './config.js'

let db: Db | null = null

/** Roles a member can hold. Mirrors the desktop's MemberRole. */
export type Role = 'admin' | 'mentor' | 'student'

/** Membership status. `inactive` keeps the record (for audit) but
 *  revokes any device tokens. */
export type MemberStatus = 'active' | 'inactive'

/**
 * Per-member home-screen capability flags. Drives which cards the
 * student sees on the welcome screen. Admin curates at PIN-issue
 * time so a fresh enrollment lands in the exact state the admin
 * wants — kiosk-style "they only ever see what they need."
 *
 * Role is independent of capabilities: a student with `createProject`
 * can still create projects, an admin without `manufacturingView`
 * just doesn't see that card. (Admins of course can change their own
 * caps from the web UI.)
 */
export interface MemberCapabilities {
  createProject: boolean
  browseTeamProjects: boolean
  openProject: boolean
  manufacturingView: boolean
}

/** New PIN / new member default. Admin ticks what they want enabled
 *  before issuing the PIN; an unattended PIN issues with everything
 *  off, which is intentional — surfaces "you forgot to grant caps"
 *  immediately instead of accidentally over-permitting. */
export const EMPTY_CAPABILITIES: MemberCapabilities = {
  createProject: false,
  browseTeamProjects: false,
  openProject: false,
  manufacturingView: false,
}

/** Parse a JSON-encoded capability blob (DB column) into the shape.
 *  Missing keys default to false; unknown keys are dropped. */
export function parseCapabilities(raw: string | null | undefined): MemberCapabilities {
  if (!raw) return { ...EMPTY_CAPABILITIES }
  try {
    const v = JSON.parse(raw) as Partial<MemberCapabilities>
    return {
      createProject: !!v.createProject,
      browseTeamProjects: !!v.browseTeamProjects,
      openProject: !!v.openProject,
      manufacturingView: !!v.manufacturingView,
    }
  } catch {
    return { ...EMPTY_CAPABILITIES }
  }
}

/** Parse a JSON-encoded number-array column. Returns [] on any error. */
export function parseAllowedProjectIds(raw: string | null | undefined): number[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((n): n is number => Number.isFinite(n))
  } catch {
    return []
  }
}

/** Migrations run in order. New ones get appended; never reorder or
 *  edit existing entries — `user_version` records how many have
 *  already been applied. */
const MIGRATIONS: string[] = [
  // v1: initial schema. One singleton `team` row, members, devices,
  // pins, projects. Audit table for "who did what when" — added on
  // day one so we never wish we had it later.
  `
  CREATE TABLE team (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    name            TEXT NOT NULL DEFAULT 'My Team',
    gitHubOrg       TEXT NOT NULL DEFAULT '',
    projectPrefix   TEXT NOT NULL DEFAULT '',
    welcomeMessage  TEXT NOT NULL DEFAULT '',
    updatedAt       INTEGER NOT NULL
  );

  CREATE TABLE members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    displayName     TEXT NOT NULL,
    githubUsername  TEXT,
    role            TEXT NOT NULL CHECK (role IN ('admin','mentor','student')),
    status          TEXT NOT NULL CHECK (status IN ('active','inactive')) DEFAULT 'active',
    joinedAt        INTEGER NOT NULL
  );

  CREATE TABLE devices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    memberId        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    label           TEXT NOT NULL DEFAULT '',
    tokenHash       TEXT NOT NULL,
    createdAt       INTEGER NOT NULL,
    lastSeenAt      INTEGER NOT NULL
  );
  CREATE INDEX devices_memberId_idx ON devices(memberId);

  CREATE TABLE pins (
    code            TEXT PRIMARY KEY,
    role            TEXT NOT NULL CHECK (role IN ('admin','mentor','student')),
    displayName     TEXT,
    githubUsername  TEXT,
    expiresAt       INTEGER,
    consumedAt      INTEGER,
    createdBy       INTEGER REFERENCES members(id) ON DELETE SET NULL,
    createdAt       INTEGER NOT NULL
  );

  CREATE TABLE projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    repoUrl         TEXT NOT NULL UNIQUE,
    description     TEXT NOT NULL DEFAULT '',
    archived        INTEGER NOT NULL DEFAULT 0,
    createdAt       INTEGER NOT NULL
  );

  -- Append-only audit trail. Every mutating admin action writes a row.
  -- 'actorId' may be NULL for system events (e.g. setup PIN auto-issued).
  CREATE TABLE audit_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              INTEGER NOT NULL,
    actorId         INTEGER REFERENCES members(id) ON DELETE SET NULL,
    actorLabel      TEXT NOT NULL,
    action          TEXT NOT NULL,
    target          TEXT,
    detail          TEXT
  );
  `,
  // v2: per-member home-screen capabilities, project allowlist, and
  // optional auto-open project. Lets the admin curate exactly what
  // each student sees on the welcome screen — Apple-style "one PIN
  // and they're set up." Defaults to empty JSON / NULL so existing
  // members effectively land in the "nothing on" state until the
  // admin grants caps from the web UI.
  `
  ALTER TABLE members ADD COLUMN capabilities        TEXT;
  ALTER TABLE members ADD COLUMN allowedProjectIds   TEXT;
  ALTER TABLE members ADD COLUMN autoOpenProjectId   INTEGER REFERENCES projects(id) ON DELETE SET NULL;

  ALTER TABLE pins ADD COLUMN capabilities        TEXT;
  ALTER TABLE pins ADD COLUMN allowedProjectIds   TEXT;
  ALTER TABLE pins ADD COLUMN autoOpenProjectId   INTEGER REFERENCES projects(id) ON DELETE SET NULL;
  `,
  // v3: record each device's running FrameCAD version. Populated on
  // enroll (body) and on every authed request (X-Client-Version
  // header) so the admin UI can flag desktops that are running an
  // outdated build. NULL means the device hasn't reported a version
  // yet — treated as "unknown" in the UI, not "outdated".
  `
  ALTER TABLE devices ADD COLUMN clientVersion TEXT;
  `,
  // v4: per-project storage quota for the self-hosted LFS server.
  // quotaBytes is the hard cap (NULL = unlimited; we set a 10GB
  // default at insert time so the admin doesn't have to think about
  // it upfront). storageBytes is the most-recently-scanned disk
  // usage under that project's LFS prefix; updated lazily on every
  // /api/lfs/token call and shown in the admin Projects page.
  // setupComplete on the team row gates the first-launch wizard —
  // flipped to 1 once the admin walks through team info + first
  // project + first member.
  `
  ALTER TABLE projects ADD COLUMN quotaBytes   INTEGER;
  ALTER TABLE projects ADD COLUMN storageBytes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN storageScannedAt INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE team     ADD COLUMN setupComplete INTEGER NOT NULL DEFAULT 0;
  `,
  // v5: editable LFS URL on the team row. The LFS_SERVER_URL env var
  // becomes a *default* — used on fresh installs (or when the column
  // is still NULL/empty) — but once the admin edits it through the
  // setup wizard or Team Settings, the DB value wins. NULL/empty
  // means "not configured" → /api/team returns the env default,
  // letting operators who haven't visited the UI still ship.
  `
  ALTER TABLE team ADD COLUMN lfsUrl TEXT;
  `,
  // v6: kiosk-mode flag on PINs + members. When ON (1) and the row
  // also has an `autoOpenProjectId`, the desktop client treats this
  // member as locked into that project: skip the welcome screen,
  // auto-reopen on close, no escape hatch back to project browsing.
  // OFF (0, the default) keeps the existing soft-autoopen behavior
  // where the user is brought into the project on launch but can
  // still close back to the welcome screen.
  `
  ALTER TABLE pins    ADD COLUMN kioskMode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN kioskMode INTEGER NOT NULL DEFAULT 0;
  `,
  // v7: track whether each project's GitHub repo still exists.
  // `remoteStatus` is one of 'unknown' (not yet checked), 'ok' (last
  // check found a live repo), or 'missing' (last check returned 404 /
  // 401, i.e. deleted or made private). `remoteCheckedAt` is the
  // timestamp of the last check; null when never checked. Admin UI
  // surfaces "missing" with a prominent warning + remove button so a
  // stale project entry can be cleaned up without the team server
  // ever needing to talk to GitHub on behalf of the desktop client.
  `
  ALTER TABLE projects ADD COLUMN remoteStatus     TEXT NOT NULL DEFAULT 'unknown';
  ALTER TABLE projects ADD COLUMN remoteCheckedAt  INTEGER;
  `,
  // v8: 24-hour grace period on the LFS quota. When a project goes
  // OVER its `quotaBytes` cap, the first publish that crosses still
  // succeeds with a warning and the timestamp gets recorded in
  // `quotaGraceUsedAt`. Subsequent over-quota publishes within 24
  // hours of that timestamp also succeed (the user has the grace
  // window to delete files); after the window, /api/lfs/token drops
  // to read-only and writes are blocked until usage falls back under
  // the cap. Null = grace not yet consumed (or never crossed). The
  // value is RESET to null any time storageBytes goes back below
  // quotaBytes, so a user who cleans up and crosses again later gets
  // a fresh grace.
  `
  ALTER TABLE projects ADD COLUMN quotaGraceUsedAt INTEGER;
  `,
  // v9: password authentication for the admin web UI + a `kind`
  // column on devices distinguishing long-lived desktop clients
  // from short-lived web sessions.
  //
  // Once the team server is exposed to the internet, PIN-only
  // enrollment isn't strong enough — PINs are 6 chars from a 32-char
  // alphabet and could be brute-forced over weeks of unsupervised
  // attempts. After the first PIN claim, an admin sets a password;
  // future logins use a username (lowercased displayName or
  // githubUsername) plus that password. `failedLoginCount` +
  // `lockedUntil` give us a simple rate limiter — 5 failed attempts
  // inside 15 minutes lock the account for the next 15 minutes.
  //
  // The devices.kind column lets requireDevice apply a 30-day
  // expiry to web sessions (browser tokens) without breaking
  // long-lived desktop client tokens (Trent's users do offline CAD
  // for weeks at a time and shouldn't be force-reauthed). Existing
  // device rows default to 'desktop' on migration — the old
  // enrollment-from-desktop flow has always been the only writer.
  `
  ALTER TABLE members ADD COLUMN passwordHash      TEXT;
  ALTER TABLE members ADD COLUMN failedLoginCount  INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN lockedUntil       INTEGER;
  ALTER TABLE members ADD COLUMN lastLoginAt       INTEGER;
  ALTER TABLE devices ADD COLUMN kind              TEXT NOT NULL DEFAULT 'desktop';
  `,
  // v10: explicit `username` column on members. Originally login
  // matched against `displayName` or `githubUsername`, but neither
  // is great as a login handle — display names have spaces, GitHub
  // usernames change. Username is a stable, member-chosen, case-
  // insensitive-unique handle that's the canonical login key.
  // Set alongside the password at first-claim time (see the
  // set-password flow in client.ts). The conditional unique index
  // allows multiple NULL usernames (legacy members who haven't
  // logged in yet) but enforces one-per-value once set.
  `
  ALTER TABLE members ADD COLUMN username TEXT;
  CREATE UNIQUE INDEX members_username_lower_uq
    ON members(LOWER(username))
    WHERE username IS NOT NULL;
  `,
  // v11: GitHub PAT stored on the team row so the admin can create
  // repos from the admin UI's Projects page (instead of bouncing to
  // github.com → New Repo → paste URL back here). The PAT is also
  // used by the desktop client to clone private repos in the team's
  // org. Stored plaintext: the server is a trusted self-hosted box,
  // the secret is no more sensitive than the device tokens already
  // living in this table, and operators are explicitly warned not
  // to share the DB. Encrypt-at-rest is a future hardening pass if
  // anyone asks. Scopes needed: `repo` (full classic PAT) OR a
  // fine-grained token with `contents:write` + `metadata:read` +
  // `administration:write` on the target org's repos.
  `
  ALTER TABLE team ADD COLUMN gitHubPat TEXT;
  `,
  // v12: tunable policies that used to be hardcoded constants in the
  // desktop client + server source. Moving them server-side means
  // an admin can change "max file size" or "blocked extensions"
  // from the Team Settings page without cutting a new desktop
  // release. Defaults match the values the constants had on the
  // day this migration shipped so existing deployments are
  // byte-identical until an admin edits something.
  //
  // - maxFileSizeMb: hard refusal at publish time. Range 10-2048.
  // - lfsAutotrackThresholdMb: files above this auto-route to LFS
  //   via the publish-time self-heal. Must be < maxFileSizeMb.
  // - blockedExtensionsJson: JSON array of extensions (no dot) the
  //   publish guard refuses. Default mirrors src/main/git.ts's
  //   BLOCKED_EXTS set as of v3.0.16.
  // - lfsTokenTtlMinutes: lifetime of the JWT clients send to
  //   Giftless. Range 5-120. Bumping helps slow uploads complete
  //   on one token; lowering tightens the security window.
  // - quotaGraceHours: how long a project can keep publishing
  //   after crossing its storage cap. Range 0-168 (one week).
  `
  ALTER TABLE team ADD COLUMN maxFileSizeMb INTEGER NOT NULL DEFAULT 256;
  ALTER TABLE team ADD COLUMN lfsAutotrackThresholdMb INTEGER NOT NULL DEFAULT 50;
  ALTER TABLE team ADD COLUMN blockedExtensionsJson TEXT NOT NULL DEFAULT '["mp4","mov","avi","mkv","wmv","webm","m4v","flv","mpg","mpeg","3gp","mp3","wav","flac","aac","m4a","ogg","opus","rar","7z","tar","gz","tgz","bz2","xz","txz","iso","lz","lzma","z","exe","msi","dll","dmg","pkg","app","apk","deb","rpm","bat","cmd","com","ps1","sh","run","bin","url","webloc","desktop"]';
  ALTER TABLE team ADD COLUMN lfsTokenTtlMinutes INTEGER NOT NULL DEFAULT 15;
  ALTER TABLE team ADD COLUMN quotaGraceHours INTEGER NOT NULL DEFAULT 24;
  `,
  // v13: per-admin GitHub PAT. The team-level PAT (v11) is shared
  // across all admin operations, which fails when the team's
  // fine-grained token doesn't have access to a specific private
  // repo (or an admin's SSO-protected repos aren't reachable via
  // the team token). Each admin can now link their own PAT; the
  // server prefers the calling admin's PAT and falls back to the
  // team PAT. Same storage rules as the team PAT (plaintext on a
  // trusted self-hosted server, never returned to clients).
  `
  ALTER TABLE members ADD COLUMN gitHubPat TEXT;
  `,
  // v14: multi-use PINs. A single PIN can enroll the same person on
  // up to `maxUses` devices without the admin issuing a separate code
  // each time. `useCount` tracks how many enrollments have consumed
  // this PIN; `consumedAt` is set only when `useCount >= maxUses` (fully
  // exhausted) so the existing "active PINs" query (`consumedAt IS NULL`)
  // keeps working. Existing rows default to maxUses=1, useCount=0 for
  // unconsumed PINs and maxUses=1, useCount=1 for already-consumed ones.
  `
  ALTER TABLE pins ADD COLUMN maxUses  INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE pins ADD COLUMN useCount INTEGER NOT NULL DEFAULT 0;
  UPDATE pins SET useCount = 1 WHERE consumedAt IS NOT NULL;
  `,
  // v15: server-side check-out/check-in locks for the Google Drive
  // storage backend. The git/LFS backend uses `git lfs lock`, which
  // Drive has no equivalent for — so locks move to the team server,
  // the one component every client already talks to.
  //
  // `projectKey` is free-text, NOT a foreign key to `projects`. Drive
  // projects are never registered in the `projects` table (that table
  // is keyed on a GitHub repoUrl), so the lock is keyed on the Drive
  // *folder id* instead — the same id the desktop stores in its
  // drive-manifest.json. This keeps the locks feature fully decoupled
  // from the GitHub-oriented project registry. `ownerName` is the
  // member's display name denormalised at lock time so the lock list
  // renders without a join (and survives the owner being renamed).
  // ON DELETE CASCADE drops a member's locks if their account is
  // removed, so a deleted member can never leave a file stuck locked.
  `
  CREATE TABLE locks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    projectKey    TEXT NOT NULL,
    filePath      TEXT NOT NULL,
    ownerMemberId INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    ownerName     TEXT NOT NULL,
    lockedAt      INTEGER NOT NULL,
    UNIQUE(projectKey, filePath)
  );
  CREATE INDEX locks_projectKey_idx ON locks(projectKey);
  `,
  // v16: Google Drive backend Shared Drive allowlist. Admins can set
  // this centrally in the team server UI so enrolled desktops do not
  // need a new installer when the approved CAD Shared Drive changes.
  // Comma-separated Shared Drive IDs; blank means clients fall back
  // to their installer-baked allowlist.
  `
  ALTER TABLE team ADD COLUMN googleSharedDriveIds TEXT NOT NULL DEFAULT '';
  `,
]

/** Default quota applied when an admin creates a project without an
 *  explicit cap. 10 GiB — enough headroom for a robot's CAD without
 *  needing to think about it on day one. Admin can change it any
 *  time, or set it to NULL for unlimited. */
export const DEFAULT_PROJECT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024

function ensureDb(): Db {
  if (db) return db
  const filePath = path.join(config.dataDir, 'framecad.db')
  db = new Database(filePath)
  db.pragma('journal_mode = WAL')        // Concurrent readers without blocking writer.
  db.pragma('foreign_keys = ON')         // ON DELETE CASCADE actually fires.
  db.pragma('synchronous = NORMAL')      // Durable enough for a team app, faster than FULL.
  return db
}

/**
 * Apply any migrations newer than the database's current user_version.
 * Run once on startup. Idempotent: calling it twice in a row is a no-op.
 */
export function migrate(): void {
  const conn = ensureDb()
  const current = (conn.pragma('user_version', { simple: true }) as number) ?? 0
  for (let i = current; i < MIGRATIONS.length; i++) {
    conn.exec(MIGRATIONS[i])
    conn.pragma(`user_version = ${i + 1}`)
  }

  // Seed the singleton `team` row on first run. The migration created
  // the table; we put one row in it so route handlers can always
  // `SELECT * FROM team WHERE id=1` without a NULL check.
  const teamCount = conn.prepare('SELECT COUNT(*) AS n FROM team').get() as { n: number }
  if (teamCount.n === 0) {
    const now = Date.now()
    conn.prepare(
      `INSERT INTO team (id, name, gitHubOrg, projectPrefix, welcomeMessage, updatedAt)
       VALUES (1, ?, '', '', '', ?)`
    ).run('My Team', now)
  }
}

/** Singleton accessor. Throws if `migrate()` hasn't run yet. */
export function getDb(): Db {
  if (!db) throw new Error('Database not initialised — call migrate() first')
  return db
}

/** Close the DB. Tests and graceful-shutdown paths only. */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * Convenience: append a single audit event. Always do this from inside
 * the same code path that does the mutation so the two stay consistent.
 */
export function logAudit(args: {
  actorId: number | null
  actorLabel: string
  action: string
  target?: string
  detail?: string
}): void {
  getDb().prepare(
    `INSERT INTO audit_events (at, actorId, actorLabel, action, target, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    args.actorId,
    args.actorLabel,
    args.action,
    args.target ?? null,
    args.detail ?? null,
  )
}

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
]

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

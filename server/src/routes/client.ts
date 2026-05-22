/**
 * Bearer-authenticated client routes.
 *
 * Used by every enrolled FrameCAD desktop / browser admin / SW add-in
 * proxy. The shape here is consciously kept tiny and read-only — all
 * mutation lives behind `/api/admin/*`. Each route looks up the
 * caller via `requireDevice`, which attaches `req.member`.
 */

import type { FastifyInstance } from 'fastify'
import { getDb, type Role, type MemberStatus } from '../db.js'
import { requireDevice, hashPassword, isPasswordAcceptable } from '../auth.js'
import { config } from '../config.js'
import { lfsEnabled, mintLfsToken } from '../lfs.js'
import { scanProjectStorage } from '../storage.js'

interface TeamRow {
  name: string
  gitHubOrg: string
  projectPrefix: string
  welcomeMessage: string
  lfsUrl: string | null
  updatedAt: number
}

/**
 * Effective LFS URL for the running server. The team row is the
 * source of truth (admin can edit via the UI); the LFS_SERVER_URL
 * env var is the fallback for fresh installs / operators who never
 * visit the wizard. Empty string when neither side has a value —
 * the desktop client treats that as "no self-hosted LFS, use the
 * project's default (GitHub LFS)".
 */
export function effectiveLfsUrl(): string {
  const row = getDb().prepare(
    `SELECT lfsUrl FROM team WHERE id = 1`
  ).get() as { lfsUrl: string | null } | undefined
  const dbVal = (row?.lfsUrl ?? '').trim()
  if (dbVal) return dbVal
  return config.lfsServerUrl ?? ''
}

interface MemberRow {
  id: number
  displayName: string
  githubUsername: string | null
  role: Role
  status: MemberStatus
  joinedAt: number
}

interface ProjectRow {
  id: number
  name: string
  repoUrl: string
  description: string
  archived: number  // SQLite booleans are 0/1
  createdAt: number
}

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    // Only run the auth hook for /api routes inside this scope. The
    // public routes mount their own subset; admin uses requireAdmin
    // explicitly. Filtering by url prefix lets us register a single
    // hook here without it firing on the SPA's static-asset GETs.
    if (!req.url.startsWith('/api/me') &&
        !req.url.startsWith('/api/team') &&
        !req.url.startsWith('/api/members') &&
        !req.url.startsWith('/api/projects') &&
        !req.url.startsWith('/api/lfs/')) return
    await requireDevice(req, reply)
  })

  // Set or change the password on the calling member's account. New-
  // member flow: admin claims via PIN → /api/me/has-password says
  // false → web UI prompts to pick a username + set a password
  // before letting them leave the sign-in screen. Existing-account
  // flow: settings page can call this with their current password
  // as confirmation. The "current" password is optional but the
  // admin UI requires it when one is already set.
  //
  // `username` is REQUIRED on first set (when the member doesn't
  // yet have one stored). Letters / digits / dot / hyphen /
  // underscore, 3-30 chars, case-insensitive-unique across the
  // members table. The login endpoint matches against this field
  // first, then falls back to displayName / githubUsername for
  // legacy rows that haven't been through the set-password flow.
  app.post<{ Body: {
    currentPassword?: string
    newPassword?: string
    username?: string
  } }>(
    '/api/me/set-password',
    async (req, reply) => {
      const { getDb: getDbInner } = await import('../db.js')
      const m = req.member!
      const newPassword = req.body?.newPassword ?? ''
      const check = isPasswordAcceptable(newPassword)
      if (!check.ok) {
        return reply.code(400).send({ error: check.reason })
      }

      // Pull current state so we can decide whether username is
      // required + whether currentPassword needs to verify.
      const row = getDbInner().prepare(
        `SELECT passwordHash, username, displayName FROM members WHERE id = ?`
      ).get(m.id) as {
        passwordHash: string | null
        username: string | null
        displayName: string
      }

      if (row.passwordHash) {
        const { verifyPassword } = await import('../auth.js')
        const ok = await verifyPassword(row.passwordHash, req.body?.currentPassword ?? '')
        if (!ok) {
          return reply.code(401).send({ error: 'Current password is incorrect.' })
        }
      }

      // Username handling. On first set (no row.username) require
      // the field. On subsequent changes the caller may omit it to
      // keep the existing handle; passing a new value re-runs the
      // validation + uniqueness check.
      let usernameToWrite: string | null = row.username
      const raw = (req.body?.username ?? '').trim().toLowerCase()
      const userChanged = raw && raw !== (row.username ?? '').toLowerCase()
      if (!row.username && !raw) {
        return reply.code(400).send({
          error: 'Username is required when setting a password for the first time.',
        })
      }
      if (userChanged) {
        if (!/^[a-z0-9._-]{3,30}$/.test(raw)) {
          return reply.code(400).send({
            error: 'Username must be 3-30 characters, letters/digits/dot/hyphen/underscore only.',
          })
        }
        // Case-insensitive uniqueness check. The conditional unique
        // index in migration v10 enforces this too, but checking
        // here lets us return a friendly 409 instead of a SQL error.
        const clash = getDbInner().prepare(
          `SELECT id FROM members WHERE LOWER(username) = ? AND id != ?`
        ).get(raw, m.id) as { id: number } | undefined
        if (clash) {
          return reply.code(409).send({
            error: `The username "${raw}" is already taken. Pick another.`,
          })
        }
        usernameToWrite = raw
      }

      // If the member is currently named "Unnamed member" (the
      // server-side fallback when enrollment didn't carry a
      // displayName — typical of the bootstrap-PIN admin flow),
      // upgrade the displayName to match the chosen username on
      // first set-password. Otherwise the sidebar's "Signed in as
      // <displayName>" would keep showing "Unnamed member" forever.
      // Existing real displayNames are preserved.
      const displayNameToWrite =
        (row.displayName.trim() === '' || row.displayName === 'Unnamed member') && usernameToWrite
          ? usernameToWrite
          : row.displayName

      const hash = await hashPassword(newPassword)
      // Wrap the UPDATE in try/catch so a concurrent same-username
      // claim (which the SELECT check above can miss under a TOCTOU
      // race) surfaces as a clean 409 instead of a raw 500. The
      // conditional unique index in migration v10 is the actual
      // enforcement; we just translate its error code.
      try {
        getDbInner().prepare(
          `UPDATE members
              SET passwordHash = ?,
                  username = ?,
                  displayName = ?,
                  failedLoginCount = 0,
                  lockedUntil = NULL
            WHERE id = ?`
        ).run(hash, usernameToWrite, displayNameToWrite, m.id)
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return reply.code(409).send({
            error: `The username "${usernameToWrite}" was just claimed by someone else. Pick another.`,
          })
        }
        throw err
      }
      const { logAudit } = await import('../db.js')
      logAudit({
        actorId: m.id,
        actorLabel: m.displayName,
        action: row.passwordHash ? 'password.change' : 'password.set',
        target: `member:${m.id}`,
        detail: userChanged ? `username=${usernameToWrite}` : undefined,
      })
      return {
        success: true,
        username: usernameToWrite,
        displayName: displayNameToWrite,
      }
    },
  )

  // Tiny helper the sign-in / settings UI uses to decide whether to
  // show the "set password" prompt vs a regular change-password form.
  // Authed → only callable by the member themselves (no leaking of
  // other members' password state).
  app.get('/api/me/has-password', async req => {
    const { getDb: getDbInner } = await import('../db.js')
    const row = getDbInner().prepare(
      `SELECT passwordHash, username FROM members WHERE id = ?`
    ).get(req.member!.id) as { passwordHash: string | null; username: string | null }
    return {
      hasPassword: row.passwordHash !== null,
      username: row.username,
    }
  })

  app.get('/api/me', async req => {
    // req.member already carries hydrated capabilities (see auth.ts —
    // findDeviceByToken parses them on every authenticated call). The
    // shape exposed here is what the desktop client persists into its
    // TeamSnapshot.me — see src/shared/types.ts.
    const m = req.member!
    return {
      member: {
        id: m.id,
        displayName: m.displayName,
        githubUsername: m.githubUsername,
        role: m.role,
        capabilities: m.capabilities,
        allowedProjectIds: m.allowedProjectIds,
        autoOpenProjectId: m.autoOpenProjectId,
        kioskMode: m.kioskMode,
      },
      device: req.device,
    }
  })

  /**
   * Self-revoke the calling device. Used by FrameCAD desktop's
   * `teamSignOut` so a sign-out cleans up the device row on the
   * server instead of leaving an orphan record + a still-valid
   * token in the audit trail.
   *
   * Returns 200 even if the device was already gone (idempotent —
   * the desktop calls this best-effort and shouldn't fail to
   * sign-out locally just because the network blipped).
   */
  app.delete('/api/me/device', async req => {
    const deviceId = req.device?.id
    if (!deviceId) return { success: true }
    const { getDb, logAudit } = await import('../db.js')
    getDb().prepare(`DELETE FROM devices WHERE id = ?`).run(deviceId)
    logAudit({
      actorId: req.member?.id ?? null,
      actorLabel: req.member?.displayName ?? 'unknown',
      action: 'device.self-revoke',
      target: `device:${deviceId}`,
    })
    return { success: true }
  })

  app.get('/api/team', async () => {
    const team = getDb().prepare(`SELECT * FROM team WHERE id = 1`).get() as TeamRow & {
      gitHubPat: string | null
    }
    return {
      name: team.name,
      gitHubOrg: team.gitHubOrg,
      projectPrefix: team.projectPrefix,
      welcomeMessage: team.welcomeMessage,
      updatedAt: team.updatedAt,
      // Empty string when LFS isn't configured on this server (neither
      // the team row nor the env var has a value). Clients detect that
      // and fall back to whatever LFS URL the project's `.lfsconfig`
      // already specifies (i.e. GitHub LFS).
      lfsUrl: effectiveLfsUrl(),
      // Boolean only — the actual PAT never leaves the server. Used
      // by the admin UI's Team Settings page to render "Token: set /
      // not set" without round-tripping the secret. Authed devices
      // see it too (harmless — they'd know if private-repo clone
      // worked or not from the actual auth result).
      hasGitHubPat: !!team.gitHubPat,
    }
  })

  // ── Self-hosted LFS ────────────────────────────────────────────────

  // Mint a short-lived JWT for the calling member to use against the
  // self-hosted LFS server (Giftless). The token is scoped to ONE
  // project, identified by `projectId` in the body — giftless will
  // reject any request whose URL doesn't match the scope, so a token
  // for project 7 can never read or write project 12's objects.
  //
  // Quota enforcement happens here on the way in: we rescan the
  // project's on-disk footprint, update the cached value, and if
  // we're over the configured cap we mint a READ-ONLY token. The
  // desktop sees a 403 from giftless on push but pulls still work,
  // so existing work isn't stranded.
  app.post<{ Body: { projectId?: unknown } }>(
    '/api/lfs/token',
    async (req, reply) => {
      if (!lfsEnabled()) {
        return reply.code(503).send({
          error: 'Self-hosted LFS is not configured on this server',
        })
      }
      const projectIdRaw = req.body?.projectId
      const projectId =
        typeof projectIdRaw === 'number' && Number.isFinite(projectIdRaw)
          ? projectIdRaw
          : Number.parseInt(String(projectIdRaw ?? ''), 10)
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return reply.code(400).send({ error: 'projectId is required' })
      }

      const project = getDb().prepare(
        `SELECT id, name, quotaBytes, storageBytes, quotaGraceUsedAt
           FROM projects WHERE id = ?`
      ).get(projectId) as {
        id: number
        name: string
        quotaBytes: number | null
        storageBytes: number
        quotaGraceUsedAt: number | null
      } | undefined
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      // Enforce per-member project allowlist — if a student has a
      // non-empty allowlist and this project isn't on it, no token.
      // (Admins/mentors aren't allowlisted; they can always push.)
      const m = req.member!
      if (m.role === 'student' && m.allowedProjectIds.length > 0
          && !m.allowedProjectIds.includes(projectId)) {
        return reply.code(403).send({ error: 'Project not in your allowlist' })
      }

      // Re-scan disk usage; cache back into the projects row so the
      // admin Projects page shows fresh numbers without a separate
      // scheduler. Best-effort: on scan failure, fall back to the
      // cached value AND do NOT advance the scannedAt timestamp —
      // otherwise the admin UI shows "scanned 5s ago" with stale
      // bytes, AND any grace-period progression below could
      // accidentally bypass the cap if storage was modified but
      // the scan failed to observe it.
      let currentBytes = project.storageBytes
      let scanOk = false
      try {
        currentBytes = await scanProjectStorage(projectId)
        getDb().prepare(
          `UPDATE projects SET storageBytes = ?, storageScannedAt = ? WHERE id = ?`
        ).run(currentBytes, Date.now(), projectId)
        scanOk = true
      } catch { /* keep cached value; scanOk stays false */ }

      // Three-state quota check with a 24-hour grace window. The user
      // who first crosses the cap gets a writable token + a warning so
      // they can delete files; if they keep pushing past the grace
      // window the token drops to read-only. Cleaning up + dropping
      // back under the cap clears the timestamp so a future cross
      // gets its own fresh grace.
      const GRACE_MS = 24 * 60 * 60 * 1000
      const now = Date.now()
      const isOverCap = project.quotaBytes !== null
        && currentBytes >= project.quotaBytes
      let writable: boolean
      let quotaGrace: 'ok' | 'in-grace' | 'expired' = 'ok'

      if (!isOverCap) {
        // Under the cap. Clear any past grace timestamp so the next
        // crossing gets a fresh 24-hour window. Skip the clear if
        // the scan didn't run — the cached bytes might be stale
        // and the user might actually still be over the cap.
        writable = true
        if (scanOk && project.quotaGraceUsedAt !== null) {
          getDb().prepare(
            `UPDATE projects SET quotaGraceUsedAt = NULL WHERE id = ?`
          ).run(projectId)
        }
      } else if (project.quotaGraceUsedAt === null) {
        // First crossing — start the grace clock + grant write. ONLY
        // persist the timestamp when the scan succeeded; otherwise a
        // transient scan failure on a borderline project could start
        // the clock against the user's intent.
        writable = true
        quotaGrace = 'in-grace'
        if (scanOk) {
          // Guarded UPDATE: only set the grace clock when the column
          // is still NULL. Two concurrent /api/lfs/token calls would
          // otherwise both run the UPDATE and the second's `now`
          // would overwrite the first — effectively extending the
          // grace window every time the user re-publishes during it.
          // The `WHERE quotaGraceUsedAt IS NULL` clause makes only
          // the very first crossing land; subsequent concurrent
          // writes are no-ops.
          getDb().prepare(
            `UPDATE projects
                SET quotaGraceUsedAt = ?
              WHERE id = ? AND quotaGraceUsedAt IS NULL`
          ).run(now, projectId)
        }
      } else if (now - project.quotaGraceUsedAt < GRACE_MS) {
        // Still within the grace window. Keep granting writes.
        writable = true
        quotaGrace = 'in-grace'
      } else {
        // Grace expired. Read-only until the user drops back under.
        writable = false
        quotaGrace = 'expired'
      }

      const { token, expiresAt } = mintLfsToken({
        memberId: m.id,
        displayName: m.displayName,
        projectId,
        writable,
      })

      return {
        token,
        expiresAt,
        url: config.lfsServerUrl,
        projectId,
        writable,
        quota: {
          used: currentBytes,
          limit: project.quotaBytes,  // null = unlimited
          /** 'ok' under cap; 'in-grace' over but still inside the
           *  24-hour window; 'expired' grace gone, writes refused. */
          grace: quotaGrace,
          graceStartedAt: project.quotaGraceUsedAt,
        },
      }
    },
  )

  app.get('/api/members', async req => {
    const member = req.member!
    // Students see only themselves. Mentors and admins see the full
    // active roster. Inactive members are never surfaced over the
    // wire — they're an audit trail, not a directory.
    if (member.role === 'student') {
      return {
        members: [{
          id: member.id,
          displayName: member.displayName,
          githubUsername: member.githubUsername,
          role: member.role,
        }],
      }
    }
    const rows = getDb().prepare(
      `SELECT id, displayName, githubUsername, role, joinedAt
         FROM members
        WHERE status = 'active'
        ORDER BY role = 'admin' DESC, role = 'mentor' DESC, displayName COLLATE NOCASE ASC`
    ).all() as Array<{
      id: number
      displayName: string
      githubUsername: string | null
      role: Role
      joinedAt: number
    }>
    return { members: rows }
  })

  app.get('/api/projects', async req => {
    // Students with a per-member allowlist only see those project IDs.
    // Admins and mentors always see the full registry — they need to
    // be able to add a student to a project, which requires seeing
    // the project. Members with an empty allowlist see everything,
    // since "no allowlist" means "no restriction." A non-empty
    // allowlist on a non-admin role is a strict filter.
    const member = req.member!
    const rows = getDb().prepare(
      `SELECT id, name, repoUrl, description, createdAt, remoteStatus
         FROM projects
        WHERE archived = 0
        ORDER BY createdAt DESC`
    ).all() as Array<Omit<ProjectRow, 'archived'> & { remoteStatus: string }>

    if (member.role === 'student' && member.allowedProjectIds.length > 0) {
      const allowed = new Set(member.allowedProjectIds)
      return { projects: rows.filter(p => allowed.has(p.id)) }
    }
    return { projects: rows }
  })
}

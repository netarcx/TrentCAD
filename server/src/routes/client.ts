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

interface TeamRow {
  name: string
  gitHubOrg: string
  projectPrefix: string
  welcomeMessage: string
  googleSharedDriveIds?: string
  lfsUrl: string | null
  updatedAt: number
  // v11 + v12 columns
  gitHubPat?: string | null
  maxFileSizeMb?: number
  lfsAutotrackThresholdMb?: number
  blockedExtensionsJson?: string
  lfsTokenTtlMinutes?: number
  quotaGraceHours?: number
}

/** Inline copy of the v12 default blocklist. Kept in sync by hand
 *  with migration v12's DEFAULT clause AND shared/types.ts's
 *  DEFAULT_TEAM_POLICIES.blockedExtensions — if you change one,
 *  change the others. */
const DEFAULT_BLOCKED_EXTS = [
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'm4v', 'flv', 'mpg', 'mpeg', '3gp',
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus',
  'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'txz', 'iso', 'lz', 'lzma', 'z',
  'exe', 'msi', 'dll', 'dmg', 'pkg', 'app', 'apk', 'deb', 'rpm',
  'bat', 'cmd', 'com', 'ps1', 'sh', 'run', 'bin',
  'url', 'webloc', 'desktop',
]

/** Parse the JSON-encoded blockedExtensions column with a safety
 *  net: an empty / corrupt value falls back to the v12 default
 *  list so a botched manual DB edit doesn't blank the policy.
 *  An EMPTY ARRAY in the JSON is honored (admin can intentionally
 *  disable the blocklist); only undefined / null / parse failure
 *  drops back to defaults. */
function parseBlockedExts(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_BLOCKED_EXTS]
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return [...DEFAULT_BLOCKED_EXTS]
    return v.filter((x): x is string => typeof x === 'string')
  } catch {
    return [...DEFAULT_BLOCKED_EXTS]
  }
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
  /** Google Drive folder id when this is a Drive project (the canonical
   *  per-project key); null for legacy GitHub-only rows. */
  driveFolderId: string | null
  /** Which Shared Drive the folder lives in. Lets a client auto-join a
   *  Drive project without a Shared-Drive picker (used by archive mode). */
  sharedDriveId: string | null
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
        !req.url.startsWith('/api/projects')) return
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

  // Set or clear the calling member's personal GitHub PAT. The
  // server uses this token (preferred over the team-level PAT) for
  // GitHub API calls the admin initiates — check-remote on a private
  // repo, create-on-github with their own org permissions, etc. This
  // closes the gap where a fine-grained team PAT couldn't see one
  // admin's SSO-protected or repo-scoped private repos.
  //
  // Empty string clears the token. We never echo the value back —
  // only a `hasGitHubPat` boolean ships in GET /api/me.
  app.post<{ Body: { gitHubPat?: string } }>(
    '/api/me/github-pat',
    async (req, reply) => {
      const raw = (req.body?.gitHubPat ?? '').trim()
      if (raw && !/^[A-Za-z0-9_-]+$/.test(raw)) {
        return reply.code(400).send({
          error: 'GitHub PAT must contain only letters, digits, underscore, and hyphen — no whitespace.',
        })
      }
      const m = req.member!
      getDb().prepare(
        `UPDATE members SET gitHubPat = ? WHERE id = ?`
      ).run(raw || null, m.id)
      const { logAudit } = await import('../db.js')
      logAudit({
        actorId: m.id,
        actorLabel: m.displayName,
        action: raw ? 'github-pat.set' : 'github-pat.cleared',
        target: `member:${m.id}`,
      })
      return { success: true, hasGitHubPat: !!raw }
    },
  )

  app.get('/api/me', async req => {
    // req.member already carries hydrated capabilities (see auth.ts —
    // findDeviceByToken parses them on every authenticated call). The
    // shape exposed here is what the desktop client persists into its
    // TeamSnapshot.me — see src/shared/types.ts.
    const m = req.member!
    // Look up the personal-PAT boolean without leaking the value.
    // Cheap single-row read on the member id.
    const patRow = getDb().prepare(
      `SELECT gitHubPat FROM members WHERE id = ?`
    ).get(m.id) as { gitHubPat: string | null } | undefined
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
        archiveMode: m.archiveMode,
        // Boolean-only — actual token never leaves the server. Admin
        // UI uses this to render "Linked / Not linked" status.
        hasGitHubPat: !!patRow?.gitHubPat,
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
    const team = getDb().prepare(`SELECT * FROM team WHERE id = 1`).get() as TeamRow
    return {
      name: team.name,
      gitHubOrg: team.gitHubOrg,
      projectPrefix: team.projectPrefix,
      welcomeMessage: team.welcomeMessage,
      googleSharedDriveIds: team.googleSharedDriveIds ?? '',
      updatedAt: team.updatedAt,
      // Boolean only — the actual PAT never leaves the server. Used
      // by the admin UI's Team Settings page to render "Token: set /
      // not set" without round-tripping the secret. Authed devices
      // see it too (harmless — they'd know if private-repo clone
      // worked or not from the actual auth result).
      hasGitHubPat: !!team.gitHubPat,
      // v12: tunable per-team policies. Desktop reads these on every
      // snapshot refresh and uses them in place of the historical
      // hardcoded constants. Defaults applied at the migration level
      // match the old constants exactly, so a fresh deploy behaves
      // byte-identically until an admin edits something.
      policies: {
        maxFileSizeMb: team.maxFileSizeMb ?? 256,
        blockedExtensions: parseBlockedExts(team.blockedExtensionsJson),
        quotaGraceHours: team.quotaGraceHours ?? 24,
      },
    }
  })

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
    // Deny-by-default for students: a student sees ONLY the registered
    // projects on their allowlist (an empty allowlist = no registered projects,
    // NOT "everything" — access is granted by the admin). Admins and mentors
    // always see the full registry so they can add students to projects.
    // Note: this gates only REGISTERED projects; an unregistered Drive folder a
    // student joined directly isn't in this table and stays usable (so teams
    // that haven't adopted the registry yet aren't disrupted).
    const member = req.member!
    const rows = getDb().prepare(
      `SELECT id, name, repoUrl, driveFolderId, sharedDriveId, description, createdAt, remoteStatus
         FROM projects
        WHERE archived = 0
        ORDER BY createdAt DESC`
    ).all() as Array<Omit<ProjectRow, 'archived'> & { remoteStatus: string }>

    if (member.role === 'student') {
      const allowed = new Set(member.allowedProjectIds)
      return { projects: rows.filter(p => allowed.has(p.id)) }
    }
    return { projects: rows }
  })

  // ── Drive-backend check-out / check-in locks ──
  // These replace `git lfs lock` for projects on the Google Drive
  // backend. `:key` is the Drive folder id (see migration v15 for why
  // it's free-text and not a project FK). All three routes are already
  // behind requireDevice via the /api/projects preHandler above.

  interface LockRow {
    filePath: string
    ownerMemberId: number
    ownerName: string
    lockedAt: number
  }

  // Per-project authorization for the Drive folder id in `:key`. Deny-by-
  // default for students: a student may only touch a REGISTERED project that's
  // on their allowlist — an empty allowlist grants NO registered projects
  // (access is admin-granted, matching /api/projects above). Admins/mentors
  // always pass. An UNREGISTERED Drive folder (no driveFolderId row) has no
  // registry entry to gate against, so it stays open — teams that haven't
  // adopted the registry yet aren't disrupted. Returns true when access is OK.
  function keyAllowed(member: { role: string; allowedProjectIds: number[] }, key: string): boolean {
    if (member.role !== 'student') return true
    const proj = getDb().prepare(`SELECT id FROM projects WHERE driveFolderId = ?`).get(key) as { id: number } | undefined
    if (!proj) return true // unregistered folder — not gated by the registry
    return member.allowedProjectIds.includes(proj.id)
  }
  function denyKey(reply: import('fastify').FastifyReply): unknown {
    return reply.code(403).send({ error: 'You don’t have access to this project.' })
  }
  // Archive devices are read-only mirrors — they may never acquire a lock or
  // record a publish. The desktop never exposes these actions in archive mode;
  // this is the authoritative backstop so a hand-crafted request can't write.
  function denyArchive(reply: import('fastify').FastifyReply): unknown {
    return reply.code(403).send({ error: 'Archive devices are read-only.' })
  }

  // List every active lock for a Drive project.
  app.get<{ Params: { key: string } }>(
    '/api/projects/:key/locks',
    async (req, reply) => {
      if (!keyAllowed(req.member!, req.params.key)) return denyKey(reply)
      const rows = getDb().prepare(
        `SELECT filePath, ownerMemberId, ownerName, lockedAt
           FROM locks WHERE projectKey = ?
          ORDER BY lockedAt ASC`
      ).all(req.params.key) as LockRow[]
      return { locks: rows }
    },
  )

  // Acquire a lock (check out). Idempotent for the current owner;
  // 409 with the holder's name when someone else has it.
  app.post<{ Params: { key: string }, Body: { filePath?: string } }>(
    '/api/projects/:key/locks',
    async (req, reply) => {
      const member = req.member!
      if (member.archiveMode) return denyArchive(reply)
      if (!keyAllowed(member, req.params.key)) return denyKey(reply)
      const filePath = (req.body?.filePath ?? '').trim()
      if (!filePath) return reply.code(400).send({ error: 'filePath is required' })

      const existing = getDb().prepare(
        `SELECT filePath, ownerMemberId, ownerName, lockedAt
           FROM locks WHERE projectKey = ? AND filePath = ?`
      ).get(req.params.key, filePath) as LockRow | undefined

      if (existing) {
        // Already held by the caller → no-op success (lets a client
        // safely re-assert a lock it thinks it owns).
        if (existing.ownerMemberId === member.id) return { ok: true, lock: existing }
        return reply.code(409).send({
          error: `Already checked out by ${existing.ownerName}`,
          lock: existing,
        })
      }

      const now = Date.now()
      const { logAudit } = await import('../db.js')
      try {
        getDb().prepare(
          `INSERT INTO locks (projectKey, filePath, ownerMemberId, ownerName, lockedAt)
           VALUES (?, ?, ?, ?, ?)`
        ).run(req.params.key, filePath, member.id, member.displayName, now)
      } catch {
        // Lost a race against a concurrent acquire — re-read and report
        // whoever won, rather than 500 on the UNIQUE violation.
        const winner = getDb().prepare(
          `SELECT filePath, ownerMemberId, ownerName, lockedAt
             FROM locks WHERE projectKey = ? AND filePath = ?`
        ).get(req.params.key, filePath) as LockRow | undefined
        if (winner && winner.ownerMemberId === member.id) return { ok: true, lock: winner }
        return reply.code(409).send({
          error: winner ? `Already checked out by ${winner.ownerName}` : 'Lock conflict',
          lock: winner,
        })
      }
      logAudit({
        actorId: member.id,
        actorLabel: member.displayName,
        action: 'lock.acquire',
        target: `${req.params.key}:${filePath}`,
      })
      const lock: LockRow = {
        filePath, ownerMemberId: member.id, ownerName: member.displayName, lockedAt: now,
      }
      return { ok: true, lock }
    },
  )

  // Release a lock (check in). The owner can always release; a mentor
  // or admin can force-release anyone's only when the client explicitly
  // requests the "break lock" path. Releasing a non-existent lock is a
  // no-op success so the client converges even after a server restart.
  app.delete<{ Params: { key: string }, Body: { filePath?: string, force?: boolean } }>(
    '/api/projects/:key/locks',
    async (req, reply) => {
      const member = req.member!
      if (member.archiveMode) return denyArchive(reply)
      if (!keyAllowed(member, req.params.key)) return denyKey(reply)
      const filePath = (req.body?.filePath ?? '').trim()
      if (!filePath) return reply.code(400).send({ error: 'filePath is required' })

      const existing = getDb().prepare(
        `SELECT filePath, ownerMemberId, ownerName, lockedAt
           FROM locks WHERE projectKey = ? AND filePath = ?`
      ).get(req.params.key, filePath) as LockRow | undefined
      if (!existing) return { ok: true }

      const isOwner = existing.ownerMemberId === member.id
      // Force-release is allowed for mentors/admins (by role) OR anyone granted
      // the forceCheckIn capability (e.g. a trusted student running the shop).
      const canForce = member.role === 'admin' || member.role === 'mentor' || member.capabilities.forceCheckIn
      const wantsForce = req.body?.force === true
      if (!isOwner && (!wantsForce || !canForce)) {
        return reply.code(403).send({ error: `Checked out by ${existing.ownerName}` })
      }

      getDb().prepare(
        `DELETE FROM locks WHERE projectKey = ? AND filePath = ?`
      ).run(req.params.key, filePath)

      const { logAudit } = await import('../db.js')
      logAudit({
        actorId: member.id,
        actorLabel: member.displayName,
        action: isOwner ? 'lock.release' : 'lock.force-release',
        target: `${req.params.key}:${filePath}`,
        detail: isOwner ? undefined : `was held by ${existing.ownerName}`,
      })
      return { ok: true }
    },
  )

  // ── Drive-backend publish history ──
  // Replaces `git log` for Drive projects (which have no commit graph).
  // Same free-text `:key` = Drive folder id as the locks routes above,
  // and behind the same /api/projects requireDevice preHandler.

  interface PublishRow {
    id: number
    authorName: string
    message: string
    filesJson: string
    publishedAt: number
  }

  // List recent publishes, newest first. `?limit=` caps the result
  // (default 100, hard max 500 so a huge project can't OOM the response).
  app.get<{ Params: { key: string }, Querystring: { limit?: string } }>(
    '/api/projects/:key/history',
    async (req, reply) => {
      if (!keyAllowed(req.member!, req.params.key)) return denyKey(reply)
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit ?? '', 10) || 100))
      const rows = getDb().prepare(
        `SELECT id, authorName, message, filesJson, publishedAt
           FROM publish_log WHERE projectKey = ?
          ORDER BY publishedAt DESC, id DESC
          LIMIT ?`
      ).all(req.params.key, limit) as PublishRow[]
      const entries = rows.map(r => ({
        hash: String(r.id),
        message: r.message,
        author: r.authorName,
        date: new Date(r.publishedAt).toISOString(),
        files: safeParseFiles(r.filesJson),
      }))
      return { entries }
    },
  )

  // Record one publish. Called by the desktop right after a successful
  // Drive publish. `files` is the list of changed project-relative paths.
  app.post<{ Params: { key: string }, Body: { message?: string, files?: string[] } }>(
    '/api/projects/:key/history',
    async (req, reply) => {
      const member = req.member!
      if (member.archiveMode) return denyArchive(reply)
      if (!keyAllowed(member, req.params.key)) return denyKey(reply)
      const message = (req.body?.message ?? '').toString().slice(0, 2000)
      const files = Array.isArray(req.body?.files)
        ? req.body!.files.filter(f => typeof f === 'string').slice(0, 5000)
        : []
      const now = Date.now()
      getDb().prepare(
        `INSERT INTO publish_log (projectKey, authorId, authorName, message, filesJson, publishedAt)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(req.params.key, member.id, member.displayName, message, JSON.stringify(files), now)
      return { ok: true }
    },
  )
}

// Parse a publish_log.filesJson blob into a string[], tolerating any
// malformed row rather than failing the whole History response.
function safeParseFiles(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((f: unknown) => typeof f === 'string') : []
  } catch {
    return []
  }
}

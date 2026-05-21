/**
 * Admin-only mutation routes.
 *
 * Every route here goes through `requireAdmin` (which itself runs
 * `requireDevice` first), so by the time the handler fires we have
 * `req.member` and a guarantee that `req.member.role === 'admin'`.
 *
 * Mutations append an audit row. The audit table is append-only — no
 * route ever deletes or rewrites it — so even after a member is
 * removed, the history of what they did survives.
 */

import type { FastifyInstance } from 'fastify'
import {
  getDb,
  logAudit,
  parseCapabilities,
  parseAllowedProjectIds,
  DEFAULT_PROJECT_QUOTA_BYTES,
  type Role,
  type MemberCapabilities,
} from '../db.js'
import { requireAdmin, issuePin, revokePin } from '../auth.js'
import { serverVersion, getLatestReleaseVersion, isOutdated } from '../version.js'
import { config } from '../config.js'

const VALID_ROLES: Role[] = ['admin', 'mentor', 'student']

/** Coerce arbitrary JSON into a strict MemberCapabilities. Unknown
 *  keys drop, missing keys default to false. Returns null if the
 *  input isn't an object at all (so the caller can leave the column
 *  untouched). */
function coerceCapabilities(input: unknown): MemberCapabilities | null {
  if (!input || typeof input !== 'object') return null
  const v = input as Partial<MemberCapabilities>
  return {
    createProject: !!v.createProject,
    browseTeamProjects: !!v.browseTeamProjects,
    openProject: !!v.openProject,
    manufacturingView: !!v.manufacturingView,
  }
}

/** Coerce arbitrary JSON into a number[]. null if not an array. */
function coerceProjectIdList(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null
  return input.filter((n): n is number => Number.isFinite(n))
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/admin/')) return
    await requireAdmin(req, reply)
  })

  // ── PINs ───────────────────────────────────────────────────────────

  app.post<{ Body: {
    role?: string
    displayName?: string
    githubUsername?: string
    ttlMs?: number | null
    capabilities?: unknown
    allowedProjectIds?: unknown
    autoOpenProjectId?: number | null
  } }>('/api/admin/pins', async (req, reply) => {
    const role = req.body?.role as Role | undefined
    if (!role || !VALID_ROLES.includes(role)) {
      return reply.code(400).send({ error: `role must be one of ${VALID_ROLES.join(', ')}` })
    }
    const capabilities = coerceCapabilities(req.body?.capabilities) ?? undefined
    const allowedProjectIds = coerceProjectIdList(req.body?.allowedProjectIds) ?? undefined
    const autoOpenProjectId =
      req.body?.autoOpenProjectId === null
        ? null
        : (Number.isFinite(req.body?.autoOpenProjectId) ? req.body!.autoOpenProjectId! : undefined)

    const pin = issuePin({
      role,
      displayName: req.body?.displayName?.trim() || null,
      githubUsername: req.body?.githubUsername?.trim() || null,
      createdBy: req.member!.id,
      ttlMs: req.body?.ttlMs === null ? null : (req.body?.ttlMs ?? undefined),
      capabilities,
      allowedProjectIds,
      autoOpenProjectId,
    })
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'pin.create',
      target: pin.code,
      detail: `role=${pin.role}`,
    })
    return pin
  })

  app.get('/api/admin/pins', async () => {
    const now = Date.now()
    const rows = getDb().prepare(
      `SELECT code, role, displayName, githubUsername, expiresAt, createdAt,
              capabilities, allowedProjectIds, autoOpenProjectId
         FROM pins
        WHERE consumedAt IS NULL
          AND (expiresAt IS NULL OR expiresAt > ?)
        ORDER BY createdAt DESC`
    ).all(now) as Array<{
      code: string
      role: Role
      displayName: string | null
      githubUsername: string | null
      expiresAt: number | null
      createdAt: number
      capabilities: string | null
      allowedProjectIds: string | null
      autoOpenProjectId: number | null
    }>
    return {
      pins: rows.map(r => ({
        code: r.code,
        role: r.role,
        displayName: r.displayName,
        githubUsername: r.githubUsername,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        capabilities: parseCapabilities(r.capabilities),
        allowedProjectIds: parseAllowedProjectIds(r.allowedProjectIds),
        autoOpenProjectId: r.autoOpenProjectId,
      })),
    }
  })

  app.delete<{ Params: { code: string } }>('/api/admin/pins/:code', async (req, reply) => {
    const code = (req.params.code || '').toUpperCase()
    const removed = revokePin(code)
    if (!removed) return reply.code(404).send({ error: 'PIN not found or already consumed' })
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'pin.revoke',
      target: code,
    })
    return { success: true }
  })

  // ── Members ────────────────────────────────────────────────────────

  app.get('/api/admin/members', async () => {
    // Full roster with capabilities + allowlist + auto-open. The
    // public /api/members deliberately omits these (students don't
    // need to know which projects they CAN'T see); the admin UI
    // needs them so it can render the edit form.
    const rows = getDb().prepare(
      `SELECT id, displayName, githubUsername, role, status, joinedAt,
              capabilities, allowedProjectIds, autoOpenProjectId
         FROM members
        WHERE status = 'active'
        ORDER BY role = 'admin' DESC, role = 'mentor' DESC, displayName COLLATE NOCASE ASC`
    ).all() as Array<{
      id: number
      displayName: string
      githubUsername: string | null
      role: Role
      status: 'active' | 'inactive'
      joinedAt: number
      capabilities: string | null
      allowedProjectIds: string | null
      autoOpenProjectId: number | null
    }>
    return {
      members: rows.map(r => ({
        id: r.id,
        displayName: r.displayName,
        githubUsername: r.githubUsername,
        role: r.role,
        joinedAt: r.joinedAt,
        capabilities: parseCapabilities(r.capabilities),
        allowedProjectIds: parseAllowedProjectIds(r.allowedProjectIds),
        autoOpenProjectId: r.autoOpenProjectId,
      })),
    }
  })

  app.patch<{
    Params: { id: string }
    Body: {
      role?: string
      status?: string
      displayName?: string
      capabilities?: unknown
      allowedProjectIds?: unknown
      autoOpenProjectId?: number | null
    }
  }>('/api/admin/members/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid member id' })

    const updates: string[] = []
    const values: Array<string | number | null> = []
    if (req.body?.role) {
      if (!VALID_ROLES.includes(req.body.role as Role)) {
        return reply.code(400).send({ error: 'Invalid role' })
      }
      updates.push('role = ?')
      values.push(req.body.role)
    }
    if (req.body?.status) {
      if (req.body.status !== 'active' && req.body.status !== 'inactive') {
        return reply.code(400).send({ error: 'Invalid status' })
      }
      updates.push('status = ?')
      values.push(req.body.status)
    }
    if (typeof req.body?.displayName === 'string') {
      updates.push('displayName = ?')
      values.push(req.body.displayName.trim() || 'Unnamed member')
    }
    if ('capabilities' in (req.body ?? {})) {
      const caps = coerceCapabilities(req.body!.capabilities)
      if (caps) {
        updates.push('capabilities = ?')
        values.push(JSON.stringify(caps))
      }
    }
    if ('allowedProjectIds' in (req.body ?? {})) {
      const ids = coerceProjectIdList(req.body!.allowedProjectIds)
      if (ids) {
        updates.push('allowedProjectIds = ?')
        values.push(JSON.stringify(ids))
      }
    }
    if ('autoOpenProjectId' in (req.body ?? {})) {
      const v = req.body!.autoOpenProjectId
      if (v === null || Number.isFinite(v)) {
        updates.push('autoOpenProjectId = ?')
        values.push(v === null ? null : (v as number))
      }
    }
    if (updates.length === 0) return { success: true } // no-op patch

    values.push(id)
    const result = getDb()
      .prepare(`UPDATE members SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values)
    if (result.changes === 0) return reply.code(404).send({ error: 'Member not found' })

    // Inactive members shouldn't retain working tokens. Wipe their
    // devices so a status flip ≈ a session revoke.
    if (req.body?.status === 'inactive') {
      getDb().prepare(`DELETE FROM devices WHERE memberId = ?`).run(id)
    }

    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'member.update',
      target: `member:${id}`,
      detail: JSON.stringify(req.body),
    })
    return { success: true }
  })

  app.delete<{ Params: { id: string } }>('/api/admin/members/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid member id' })
    if (id === req.member!.id) {
      return reply.code(400).send({ error: "Can't delete yourself" })
    }
    const result = getDb().prepare(`DELETE FROM members WHERE id = ?`).run(id)
    if (result.changes === 0) return reply.code(404).send({ error: 'Member not found' })
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'member.delete',
      target: `member:${id}`,
    })
    return { success: true }
  })

  // ── Projects ───────────────────────────────────────────────────────

  app.get('/api/admin/projects', async () => {
    // The client-facing /api/projects strips quota info (students
    // don't need it); this admin variant returns the full row so
    // the Projects page can render usage indicators and quota inputs.
    const rows = getDb().prepare(
      `SELECT id, name, repoUrl, description, archived, createdAt,
              quotaBytes, storageBytes, storageScannedAt
         FROM projects
        ORDER BY archived ASC, createdAt DESC`
    ).all()
    return { projects: rows }
  })

  app.post<{ Body: {
    name?: string
    repoUrl?: string
    description?: string
    quotaBytes?: number | null
  } }>(
    '/api/admin/projects',
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim()
      const repoUrl = (req.body?.repoUrl ?? '').trim()
      if (!name || !repoUrl) {
        return reply.code(400).send({ error: 'name and repoUrl are required' })
      }
      // Quota: explicit number wins; explicit null means "unlimited";
      // missing means "use the default" (admin didn't have to think).
      const quota =
        req.body?.quotaBytes === null
          ? null
          : typeof req.body?.quotaBytes === 'number' && Number.isFinite(req.body.quotaBytes)
            ? Math.max(0, Math.floor(req.body.quotaBytes))
            : DEFAULT_PROJECT_QUOTA_BYTES
      try {
        const result = getDb().prepare(
          `INSERT INTO projects (name, repoUrl, description, createdAt, quotaBytes)
           VALUES (?, ?, ?, ?, ?)`
        ).run(name, repoUrl, (req.body?.description ?? '').trim(), Date.now(), quota)
        logAudit({
          actorId: req.member!.id,
          actorLabel: req.member!.displayName,
          action: 'project.create',
          target: `project:${result.lastInsertRowid}`,
          detail: repoUrl,
        })
        return { id: result.lastInsertRowid, success: true }
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return reply.code(409).send({ error: 'A project with that repoUrl is already registered' })
        }
        throw err
      }
    },
  )

  // Edit project metadata — currently only the quota is mutable from
  // the admin UI. (name / repoUrl could be added here later; for now
  // the operator deletes + recreates if they got those wrong, which
  // is fine since the desktop hasn't memorised the project id yet.)
  app.patch<{ Params: { id: string }; Body: { quotaBytes?: number | null } }>(
    '/api/admin/projects/:id',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: 'Invalid project id' })
      }
      const updates: string[] = []
      const values: Array<number | null> = []
      if ('quotaBytes' in (req.body ?? {})) {
        const q = req.body!.quotaBytes
        const next = q === null
          ? null
          : typeof q === 'number' && Number.isFinite(q)
            ? Math.max(0, Math.floor(q))
            : undefined
        if (next === undefined) {
          return reply.code(400).send({ error: 'quotaBytes must be a number or null' })
        }
        updates.push('quotaBytes = ?')
        values.push(next)
      }
      if (updates.length === 0) {
        return reply.code(400).send({ error: 'No mutable fields supplied' })
      }
      values.push(id)
      const result = getDb().prepare(
        `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`
      ).run(...values)
      if (result.changes === 0) {
        return reply.code(404).send({ error: 'Project not found' })
      }
      logAudit({
        actorId: req.member!.id,
        actorLabel: req.member!.displayName,
        action: 'project.update',
        target: `project:${id}`,
        detail: Object.keys(req.body ?? {}).join(','),
      })
      return { success: true }
    },
  )

  app.delete<{ Params: { id: string } }>('/api/admin/projects/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid project id' })
    const result = getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    if (result.changes === 0) return reply.code(404).send({ error: 'Project not found' })
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'project.delete',
      target: `project:${id}`,
    })
    return { success: true }
  })

  // ── Setup state ────────────────────────────────────────────────────

  // Returns the data the first-launch wizard needs to decide whether
  // to show itself and which steps still need attention. Cheap query;
  // safe to hit on every admin page mount.
  app.get('/api/admin/setup-state', async req => {
    const team = getDb().prepare(
      `SELECT name, gitHubOrg, setupComplete FROM team WHERE id = 1`
    ).get() as { name: string; gitHubOrg: string; setupComplete: number }
    const projectCount = (getDb().prepare(
      `SELECT COUNT(*) AS n FROM projects WHERE archived = 0`
    ).get() as { n: number }).n
    // Exclude the calling admin from the count so the "add your
    // first teammate" step doesn't claim "1 member exists" right
    // after the bootstrap admin enrolls themselves.
    const memberCount = (getDb().prepare(
      `SELECT COUNT(*) AS n FROM members WHERE id != ?`
    ).get(req.member!.id) as { n: number }).n
    return {
      setupComplete: team.setupComplete === 1,
      teamInfoSet: team.name.trim().length > 0 && team.gitHubOrg.trim().length > 0,
      lfsConfigured: !!config.lfsServerUrl,
      lfsUrl: config.lfsServerUrl ?? '',
      projectCount,
      memberCount,
    }
  })

  // Mark setup-complete on the team row. The wizard calls this when
  // the admin clicks "Finish" (or "Skip remaining"). Idempotent —
  // safe to call repeatedly. Once set, AdminShell stops showing the
  // wizard route.
  app.post('/api/admin/setup-complete', async req => {
    getDb().prepare(`UPDATE team SET setupComplete = 1 WHERE id = 1`).run()
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'team.setup-complete',
    })
    return { success: true }
  })

  // ── Team config ────────────────────────────────────────────────────

  app.patch<{ Body: {
    name?: string
    gitHubOrg?: string
    projectPrefix?: string
    welcomeMessage?: string
  } }>('/api/admin/team', async req => {
    const updates: string[] = []
    const values: string[] = []
    for (const field of ['name', 'gitHubOrg', 'projectPrefix', 'welcomeMessage'] as const) {
      if (typeof req.body?.[field] === 'string') {
        updates.push(`${field} = ?`)
        values.push(req.body[field]!.trim())
      }
    }
    if (updates.length === 0) return { success: true }
    updates.push('updatedAt = ?')
    values.push(String(Date.now()))
    getDb()
      .prepare(`UPDATE team SET ${updates.join(', ')} WHERE id = 1`)
      .run(...values)
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'team.update',
      detail: JSON.stringify(req.body),
    })
    return { success: true }
  })

  // ── Devices ────────────────────────────────────────────────────────

  app.get('/api/admin/devices', async () => {
    const rows = getDb().prepare(
      `SELECT d.id, d.memberId, d.label, d.createdAt, d.lastSeenAt,
              m.displayName, m.role
         FROM devices d
         JOIN members m ON m.id = d.memberId
        ORDER BY d.lastSeenAt DESC`
    ).all()
    return { devices: rows }
  })

  app.delete<{ Params: { id: string } }>('/api/admin/devices/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid device id' })
    if (id === req.device!.id) {
      return reply.code(400).send({ error: "Can't revoke the device you're calling from" })
    }
    const result = getDb().prepare(`DELETE FROM devices WHERE id = ?`).run(id)
    if (result.changes === 0) return reply.code(404).send({ error: 'Device not found' })
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'device.revoke',
      target: `device:${id}`,
    })
    return { success: true }
  })

  // ── Version status ─────────────────────────────────────────────────

  // What's the server running, what's the latest released build, and
  // which of our connected desktops are behind? The admin UI renders
  // a banner off this so the team can stay on a current build without
  // anyone having to remember to check GitHub manually.
  app.get('/api/admin/version-status', async () => {
    const latest = await getLatestReleaseVersion()
    const serverOutdated = isOutdated(serverVersion, latest)

    // Pull every device with a known clientVersion. NULLs mean the
    // device hasn't reported one yet (legacy enrolls before this
    // feature shipped); they show up as "unknown" in the UI rather
    // than getting flagged as outdated.
    const devices = getDb().prepare(
      `SELECT d.id        AS deviceId,
              d.label     AS deviceLabel,
              d.clientVersion,
              d.lastSeenAt,
              m.id        AS memberId,
              m.displayName,
              m.role
         FROM devices d
         JOIN members m ON m.id = d.memberId
        ORDER BY d.lastSeenAt DESC`
    ).all() as Array<{
      deviceId: number
      deviceLabel: string
      clientVersion: string | null
      lastSeenAt: number
      memberId: number
      displayName: string
      role: Role
    }>

    const outdatedClients = latest
      ? devices.filter(d => d.clientVersion && isOutdated(d.clientVersion, latest))
      : []

    return {
      server: {
        current: serverVersion,
        latest,
        outdated: serverOutdated,
      },
      clients: {
        latest,
        total: devices.length,
        outdated: outdatedClients,
      },
    }
  })

  // ── Audit log ──────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>('/api/admin/audit', async req => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 500)
    const rows = getDb().prepare(
      `SELECT id, at, actorId, actorLabel, action, target, detail
         FROM audit_events
        ORDER BY id DESC
        LIMIT ?`
    ).all(limit)
    return { events: rows }
  })
}

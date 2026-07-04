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
    manageCadStructure: !!v.manageCadStructure,
    forceCheckIn: !!v.forceCheckIn,
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
    kioskMode?: boolean
    archiveMode?: boolean
    maxUses?: number
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

    // A kiosk/auto-open target the member can't actually access just makes the
    // desktop stall on the welcome screen with no recovery. Reject the config
    // when an auto-open project sits outside a non-empty allowlist.
    if (
      autoOpenProjectId != null &&
      allowedProjectIds && allowedProjectIds.length > 0 &&
      !allowedProjectIds.includes(autoOpenProjectId)
    ) {
      return reply.code(400).send({ error: 'The auto-open project must be one of the allowed projects.' })
    }

    const pin = issuePin({
      role,
      displayName: req.body?.displayName?.trim() || null,
      githubUsername: req.body?.githubUsername?.trim() || null,
      createdBy: req.member!.id,
      ttlMs: req.body?.ttlMs === null ? null : (req.body?.ttlMs ?? undefined),
      capabilities,
      allowedProjectIds,
      autoOpenProjectId,
      kioskMode: !!req.body?.kioskMode,
      archiveMode: !!req.body?.archiveMode,
      maxUses: typeof req.body?.maxUses === 'number' ? req.body.maxUses : undefined,
    })
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'pin.create',
      target: pin.code,
      detail: `role=${pin.role} maxUses=${pin.maxUses}`,
    })
    return pin
  })

  app.get('/api/admin/pins', async () => {
    const now = Date.now()
    const rows = getDb().prepare(
      `SELECT code, role, displayName, githubUsername, expiresAt, createdAt,
              capabilities, allowedProjectIds, autoOpenProjectId, kioskMode, archiveMode,
              maxUses, useCount, boundMemberId
         FROM pins
        WHERE useCount < maxUses
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
      kioskMode: number
      archiveMode: number
      maxUses: number
      useCount: number
      boundMemberId: number | null
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
        kioskMode: r.kioskMode === 1 && r.autoOpenProjectId !== null,
        archiveMode: r.archiveMode === 1,
        maxUses: r.maxUses,
        useCount: r.useCount,
        boundMemberId: r.boundMemberId,
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
              capabilities, allowedProjectIds, autoOpenProjectId, kioskMode, archiveMode
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
      kioskMode: number
      archiveMode: number
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
        kioskMode: r.kioskMode === 1 && r.autoOpenProjectId !== null,
        archiveMode: r.archiveMode === 1,
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
      kioskMode?: boolean
      archiveMode?: boolean
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
      // Prevent the calling admin from demoting themselves to a non-
      // admin role — they'd lose access to every admin endpoint
      // including this one, locking the server until someone with
      // DB access manually flips them back. Same guard belongs on
      // status='inactive' below since deactivating yourself has the
      // same effect via the cascading device delete.
      if (id === req.member!.id && req.body.role !== 'admin') {
        return reply.code(400).send({
          error: "Can't change your own role away from admin — you'd lock yourself out. Have another admin do it.",
        })
      }
      // Also refuse to demote the last remaining admin (even by
      // someone else doing it to a different admin), so the server
      // never ends up with zero admins.
      if (req.body.role !== 'admin') {
        const adminCount = (getDb().prepare(
          `SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND status = 'active'`
        ).get() as { n: number }).n
        const targetIsAdmin = (getDb().prepare(
          `SELECT role FROM members WHERE id = ?`
        ).get(id) as { role: string } | undefined)?.role === 'admin'
        if (targetIsAdmin && adminCount <= 1) {
          return reply.code(400).send({
            error: "Can't demote the last remaining admin. Promote another member to admin first.",
          })
        }
      }
      updates.push('role = ?')
      values.push(req.body.role)
    }
    if (req.body?.status) {
      if (req.body.status !== 'active' && req.body.status !== 'inactive') {
        return reply.code(400).send({ error: 'Invalid status' })
      }
      if (id === req.member!.id && req.body.status === 'inactive') {
        return reply.code(400).send({
          error: "Can't deactivate yourself — it would revoke all your sessions immediately. Have another admin do it.",
        })
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
    const current = getDb().prepare(
      `SELECT allowedProjectIds, autoOpenProjectId FROM members WHERE id = ?`
    ).get(id) as { allowedProjectIds: string | null; autoOpenProjectId: number | null } | undefined
    if (!current) return reply.code(404).send({ error: 'Member not found' })
    const nextAllowed = 'allowedProjectIds' in (req.body ?? {})
      ? (coerceProjectIdList(req.body!.allowedProjectIds) ?? parseAllowedProjectIds(current.allowedProjectIds))
      : parseAllowedProjectIds(current.allowedProjectIds)
    const nextAutoOpen = 'autoOpenProjectId' in (req.body ?? {})
      ? (req.body!.autoOpenProjectId === null ? null : req.body!.autoOpenProjectId)
      : current.autoOpenProjectId
    if (
      Number.isFinite(nextAutoOpen) &&
      nextAllowed.length > 0 &&
      !nextAllowed.includes(nextAutoOpen as number)
    ) {
      return reply.code(400).send({ error: 'The auto-open project must be one of the allowed projects.' })
    }
    if ('kioskMode' in (req.body ?? {})) {
      // Coerce to 0/1 for SQLite. The trigger that ties kiosk to
      // autoOpenProjectId !== null lives at read time (findDeviceByToken
      // + /api/me + /api/admin/members all gate it), so we don't try
      // to enforce a multi-column invariant inside the UPDATE.
      updates.push('kioskMode = ?')
      values.push(req.body!.kioskMode ? 1 : 0)
    }
    if ('archiveMode' in (req.body ?? {})) {
      // Read-only-mirror flag. Stands alone (no autoOpen precondition), so
      // a plain 0/1 write is the whole story.
      updates.push('archiveMode = ?')
      values.push(req.body!.archiveMode ? 1 : 0)
    }
    if (updates.length === 0) return { success: true } // no-op patch

    values.push(id)
    const result = getDb()
      .prepare(`UPDATE members SET ${updates.join(', ')} WHERE id = ?`)
      .run(...values)
    if (result.changes === 0) return reply.code(404).send({ error: 'Member not found' })

    // Inactive members shouldn't retain working tokens OR hold check-out
    // locks. Wipe their devices (status flip ≈ session revoke) AND release
    // their locks — deactivation is the normal removal path, and ON DELETE
    // CASCADE only fires on a hard member DELETE, so without this a
    // deactivated member's files stay locked forever (they can't self-release
    // once their token is gone).
    if (req.body?.status === 'inactive') {
      getDb().prepare(`DELETE FROM devices WHERE memberId = ?`).run(id)
      getDb().prepare(`DELETE FROM locks WHERE ownerMemberId = ?`).run(id)
      // Also revoke any outstanding PINs bound to this member's identity —
      // enrolling with one reuses the member row and flips it back to
      // 'active', silently undoing the deactivation. Same mechanism as
      // revokePin(): delete rows that still have uses remaining.
      const gh = (getDb().prepare(
        `SELECT githubUsername FROM members WHERE id = ?`
      ).get(id) as { githubUsername: string | null } | undefined)?.githubUsername
      if (gh) {
        getDb().prepare(
          `DELETE FROM pins WHERE LOWER(githubUsername) = LOWER(?) AND useCount < maxUses`
        ).run(gh)
      }
      // Re-enroll PINs bound by member id would reactivate them the same way.
      getDb().prepare(
        `DELETE FROM pins WHERE boundMemberId = ? AND useCount < maxUses`
      ).run(id)
    }

    // A demotion must stick: enrollment treats the PIN role as upgrade-only,
    // so a leftover identity-bound PIN with a HIGHER role would silently
    // re-promote this member the next time they enroll a device with it.
    // Revoke any outstanding PIN bound to this member that now outranks them.
    if (req.body?.role) {
      const rank: Record<Role, number> = { student: 0, mentor: 1, admin: 2 }
      const outranking = VALID_ROLES.filter(r => rank[r] > rank[req.body!.role as Role])
      if (outranking.length > 0) {
        const gh = (getDb().prepare(
          `SELECT githubUsername FROM members WHERE id = ?`
        ).get(id) as { githubUsername: string | null } | undefined)?.githubUsername
        getDb().prepare(
          `DELETE FROM pins
            WHERE useCount < maxUses
              AND role IN (${outranking.map(() => '?').join(',')})
              AND (boundMemberId = ?${gh ? ' OR LOWER(githubUsername) = LOWER(?)' : ''})`
        ).run(...outranking, id, ...(gh ? [gh] : []))
      }
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

  // Issue a re-enrollment PIN for an EXISTING member — new laptop, wiped
  // install, returning student. The PIN is bound to the member row, so
  // enrolling with it attaches the new device to this member (same role,
  // capabilities, allowlist) instead of minting a duplicate identity.
  app.post<{ Params: { id: string }; Body: { ttlMs?: number | null; maxUses?: number } }>(
    '/api/admin/members/:id/pin',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid member id' })
      const member = getDb().prepare(
        `SELECT id, displayName, githubUsername, role, status FROM members WHERE id = ?`
      ).get(id) as { id: number; displayName: string; githubUsername: string | null; role: Role; status: string } | undefined
      if (!member) return reply.code(404).send({ error: 'Member not found' })
      if (member.status !== 'active') {
        return reply.code(400).send({ error: 'Member is deactivated — set them active first, then issue the PIN.' })
      }
      const pin = issuePin({
        role: member.role,
        displayName: member.displayName,
        githubUsername: member.githubUsername,
        createdBy: req.member!.id,
        // Same promise the first-launch wizard makes for its invite PIN:
        // single-use, 7 days. Both overridable per request.
        ttlMs: req.body?.ttlMs === null ? null : (req.body?.ttlMs ?? 7 * 24 * 3600 * 1000),
        maxUses: typeof req.body?.maxUses === 'number' ? req.body.maxUses : 1,
        boundMemberId: member.id,
      })
      logAudit({
        actorId: req.member!.id,
        actorLabel: req.member!.displayName,
        action: 'pin.create',
        target: pin.code,
        detail: `re-enroll member:${id} (${member.displayName})`,
      })
      return pin
    }
  )

  app.delete<{ Params: { id: string } }>('/api/admin/members/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid member id' })
    if (id === req.member!.id) {
      return reply.code(400).send({ error: "Can't delete yourself" })
    }
    // foreign_keys IS on (db.ts), so pins.boundMemberId ON DELETE CASCADE would
    // already clear this member's re-enroll PINs when the member row is deleted
    // below. This explicit delete is harmless (belt-and-suspenders / clarity).
    getDb().prepare(`DELETE FROM pins WHERE boundMemberId = ?`).run(id)
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
      `SELECT id, name, driveFolderId, sharedDriveId, description, archived, createdAt,
              quotaBytes, storageBytes, storageScannedAt
         FROM projects
        ORDER BY archived ASC, createdAt DESC`
    ).all()
    return { projects: rows }
  })

  app.post<{ Body: {
    name?: string
    driveFolderId?: string
    sharedDriveId?: string
    description?: string
    quotaBytes?: number | null
  } }>(
    '/api/admin/projects',
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim()
      const driveFolderId = (req.body?.driveFolderId ?? '').trim()
      const sharedDriveId = (req.body?.sharedDriveId ?? '').trim()
      if (!name) {
        return reply.code(400).send({ error: 'name is required' })
      }
      // A project is identified by its Google Drive folder. We still write a
      // synthetic `drive:<folderId>` into the legacy NOT NULL UNIQUE `repoUrl`
      // column so the constraint holds without a schema rebuild; `driveFolderId`
      // is the canonical key the locks / history / allowlist routes match on.
      if (!driveFolderId) {
        return reply.code(400).send({ error: 'A Google Drive folder id is required' })
      }
      const repoUrl = `drive:${driveFolderId}`
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
          `INSERT INTO projects (name, repoUrl, driveFolderId, sharedDriveId, description, createdAt, quotaBytes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(name, repoUrl, driveFolderId, sharedDriveId || null, (req.body?.description ?? '').trim(), Date.now(), quota)
        logAudit({
          actorId: req.member!.id,
          actorLabel: req.member!.displayName,
          action: 'project.create',
          target: `project:${result.lastInsertRowid}`,
          detail: `drive:${driveFolderId}`,
        })
        return { id: result.lastInsertRowid, success: true }
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return reply.code(409).send({
            error: 'That Google Drive folder is already registered as a project',
          })
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
    const row = getDb().prepare(
      `SELECT driveFolderId FROM projects WHERE id = ?`
    ).get(id) as { driveFolderId: string | null } | undefined
    if (!row) return reply.code(404).send({ error: 'Project not found' })
    const result = getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    if (result.changes === 0) return reply.code(404).send({ error: 'Project not found' })
    if (row.driveFolderId) {
      getDb().prepare(`DELETE FROM locks WHERE projectKey = ?`).run(row.driveFolderId)
      getDb().prepare(`DELETE FROM publish_log WHERE projectKey = ?`).run(row.driveFolderId)
      getDb().prepare(`DELETE FROM part_numbers WHERE projectKey = ?`).run(row.driveFolderId)
    }
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'project.delete',
      target: `project:${id}`,
    })
    return { success: true }
  })

  // ── Problem reports ────────────────────────────────────────────────
  // Reports submitted from the desktop "Report" button (POST /api/issues).
  // Open ones float to the top; resolve/delete to triage.
  app.get('/api/admin/issues', async () => {
    const issues = getDb().prepare(
      `SELECT id, memberId, reporterName, message, appVersion, platform, status, createdAt
         FROM issue_reports
        ORDER BY (status = 'open') DESC, createdAt DESC
        LIMIT 500`
    ).all()
    return { issues }
  })

  app.patch<{ Params: { id: string }, Body: { status?: string } }>(
    '/api/admin/issues/:id',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' })
      const status = req.body?.status === 'resolved' ? 'resolved' : 'open'
      const r = getDb().prepare(`UPDATE issue_reports SET status = ? WHERE id = ?`).run(status, id)
      if (r.changes === 0) return reply.code(404).send({ error: 'Report not found' })
      logAudit({
        actorId: req.member!.id,
        actorLabel: req.member!.displayName,
        action: 'issue.update',
        target: `issue:${id}`,
        detail: `status=${status}`,
      })
      return { ok: true }
    },
  )

  app.delete<{ Params: { id: string } }>('/api/admin/issues/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' })
    const r = getDb().prepare(`DELETE FROM issue_reports WHERE id = ?`).run(id)
    if (r.changes > 0) {
      logAudit({
        actorId: req.member!.id,
        actorLabel: req.member!.displayName,
        action: 'issue.delete',
        target: `issue:${id}`,
      })
    }
    return { ok: true }
  })

  // ── Container logs ─────────────────────────────────────────────────
  //
  // Admin-only snapshot endpoint that reads the last N lines of a
  // container's stdout/stderr via Docker's Unix socket. Two
  // containers expected in the standard docker-compose stack:
  // 'framecad-server' (this Node app). Adding new ones is a matter of
  // letting them through the allowlist below.
  //
  // Requires /var/run/docker.sock to be bind-mounted into this
  // container's filesystem — see docker-compose.yml. We hard-allowlist
  // the container names so a hijacked admin token can't read logs of
  // unrelated containers on the same Docker daemon (defence-in-depth;
  // the socket gives broader powers in theory but we only expose what
  // we need).
  const LOG_ALLOWLIST = new Set(['framecad-server'])
  app.get<{
    Params: { name: string }
    Querystring: { tail?: string }
  }>(
    '/api/admin/logs/:name',
    async (req, reply) => {
      const name = req.params.name
      if (!LOG_ALLOWLIST.has(name)) {
        return reply.code(400).send({
          error: `Container "${name}" is not in the log-readable allowlist.`,
        })
      }
      const tail = Math.max(
        1,
        Math.min(2000, Number.parseInt(req.query.tail ?? '500', 10) || 500),
      )
      try {
        const { fetchContainerLogs } = await import('../dockerLogs.js')
        const lines = await fetchContainerLogs(name, tail)
        return { container: name, tail, lines }
      } catch (err) {
        return reply.code(502).send({
          error: (err as Error).message || 'Docker socket unreachable',
        })
      }
    },
  )

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
    googleSharedDriveIds?: string
    /** GitHub Personal Access Token used by the server to create repos
     *  on behalf of admins. Empty string clears it. Audit logs only
     *  record set/clear, never the value. */
    gitHubPat?: string
    // v12 policy knobs — all range-validated below, see migration v12
    // for the rationale and defaults.
    maxFileSizeMb?: number
    blockedExtensions?: string[]
    quotaGraceHours?: number
  } }>('/api/admin/team', async (req, reply) => {
    const updates: string[] = []
    const values: Array<string | number | null> = []
    let patChanged: 'set' | 'cleared' | null = null
    for (const field of [
      'name', 'gitHubOrg', 'projectPrefix', 'welcomeMessage', 'gitHubPat',
      'googleSharedDriveIds',
    ] as const) {
      if (typeof req.body?.[field] === 'string') {
        const raw = req.body[field]!.trim()
        if (field === 'gitHubPat') {
          // Empty string = clear the token. Light-touch validation:
          // GitHub PATs are alphanum + underscore + dash, with a
          // ghp_/ghs_/github_pat_ prefix on classic / fine-grained.
          // We don't enforce a strict format because GitHub has changed
          // the shape twice; just refuse whitespace + obvious bad chars.
          if (raw && !/^[A-Za-z0-9_-]+$/.test(raw)) {
            return reply.code(400).send({
              error: 'GitHub PAT must contain only letters, digits, underscore, and hyphen — no whitespace.',
            })
          }
          updates.push(`gitHubPat = ?`)
          values.push(raw || null)
          patChanged = raw ? 'set' : 'cleared'
        } else if (field === 'googleSharedDriveIds') {
          const ids = raw
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
          for (const id of ids) {
            if (!/^[A-Za-z0-9_-]+$/.test(id)) {
              return reply.code(400).send({
                error: `Google Shared Drive ID "${id}" is invalid. Use comma-separated Drive IDs only.`,
              })
            }
          }
          updates.push(`${field} = ?`)
          values.push(Array.from(new Set(ids)).join(','))
        } else {
          updates.push(`${field} = ?`)
          values.push(raw)
        }
      }
    }

    // v12 policy knobs. Range-validate each before persisting.
    const maxSizeReq = req.body?.maxFileSizeMb
    if (typeof maxSizeReq === 'number') {
      if (!Number.isInteger(maxSizeReq) || maxSizeReq < 10 || maxSizeReq > 2048) {
        return reply.code(400).send({
          error: 'maxFileSizeMb must be an integer between 10 and 2048.',
        })
      }
      updates.push('maxFileSizeMb = ?')
      values.push(maxSizeReq)
    }
    if (Array.isArray(req.body?.blockedExtensions)) {
      const cleaned: string[] = []
      for (const ext of req.body!.blockedExtensions!) {
        if (typeof ext !== 'string') continue
        const lower = ext.trim().replace(/^\./, '').toLowerCase()
        if (!lower) continue
        // No dots, slashes, or anything that isn't a plausible
        // filename extension. Refuse anything weird before it
        // becomes a future support headache.
        if (!/^[a-z0-9]+$/.test(lower)) {
          return reply.code(400).send({
            error: `blockedExtensions: "${ext}" is not a valid extension (alphanumeric only, no dots or slashes).`,
          })
        }
        if (!cleaned.includes(lower)) cleaned.push(lower)
      }
      updates.push('blockedExtensionsJson = ?')
      values.push(JSON.stringify(cleaned))
    }
    const graceReq = req.body?.quotaGraceHours
    if (typeof graceReq === 'number') {
      if (!Number.isInteger(graceReq) || graceReq < 0 || graceReq > 168) {
        return reply.code(400).send({
          error: 'quotaGraceHours must be an integer between 0 and 168 (one week).',
        })
      }
      updates.push('quotaGraceHours = ?')
      values.push(graceReq)
    }
    if (updates.length === 0) return { success: true }
    updates.push('updatedAt = ?')
    // INTEGER column — push the number, not String(Date.now()). The
    // earlier String() coerced it via SQLite's relaxed type affinity
    // to TEXT in that cell, breaking numeric comparisons downstream
    // (any code doing `team.updatedAt > someMs` would silently
    // string-compare).
    values.push(Date.now())
    getDb()
      .prepare(`UPDATE team SET ${updates.join(', ')} WHERE id = 1`)
      .run(...values)
    // Strip the PAT value from the audit-log detail — we want to know
    // WHEN it was set or cleared, never WHAT it was set to. The
    // `patChanged` flag captured above is the breadcrumb.
    const safeDetail = { ...req.body }
    if ('gitHubPat' in safeDetail) {
      safeDetail.gitHubPat = patChanged === 'set' ? '<set>' : '<cleared>'
    }
    logAudit({
      actorId: req.member!.id,
      actorLabel: req.member!.displayName,
      action: 'team.update',
      detail: JSON.stringify(safeDetail),
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

  // ── DESTRUCTIVE: reset the whole server ────────────────────────────
  //
  // Wipes every table (members, devices, projects, pins, audit, team
  // settings) and re-bootstraps a fresh setup PIN. Intended for
  // testing the first-launch flow repeatedly without manually
  // `docker compose down && rm -rf data && docker compose up`.
  //
  // Triple-confirmation lives in the UI; here we just require the
  // caller to POST the literal string "RESET" as the `confirm` body
  // field. Belt-and-braces — the UI sends it, but if someone hand-
  // crafts a curl, they have to do it on purpose.
  app.post<{ Body: { confirm?: string } }>(
    '/api/admin/dev-reset',
    async (req, reply) => {
      // DESTRUCTIVE + irreversible (wipes the audit trail too). Gate it behind
      // an explicit env opt-in so a production deployment can't reach it even
      // with a valid admin token (or a hijacked one). Off by default.
      if (process.env.FRAMECAD_DEV_RESET !== '1') {
        return reply.code(404).send({ error: 'Not found.' })
      }
      if (req.body?.confirm !== 'RESET') {
        return reply.code(400).send({
          error: 'Refusing to reset without confirm="RESET" in the body.',
        })
      }
      const callerId = req.member?.id ?? null
      const callerLabel = req.member?.displayName ?? 'unknown'

      const db = getDb()
      // Truncate in dependency order. SQLite has no TRUNCATE; DELETE
      // is functionally identical for our purposes. We also clear
      // sqlite_sequence so AUTOINCREMENT counters restart at 1, which
      // makes the post-reset state look like a fresh install rather
      // than "members id 47…".
      db.transaction(() => {
        db.prepare('DELETE FROM audit_events').run()
        db.prepare('DELETE FROM devices').run()
        db.prepare('DELETE FROM pins').run()
        // locks + publish_log cascade off members, but part_numbers.memberId and
        // issue_reports.memberId are ON DELETE SET NULL, so those rows would
        // SURVIVE the member delete with stale projectKeys while sqlite_sequence
        // is cleared (project ids restart at 1) — a re-registered folder could
        // then hit resurrected part-number claims, and old reports linger. Delete
        // them explicitly so "fresh install" is actually fresh.
        db.prepare('DELETE FROM locks').run()
        db.prepare('DELETE FROM publish_log').run()
        db.prepare('DELETE FROM part_numbers').run()
        db.prepare('DELETE FROM issue_reports').run()
        db.prepare('DELETE FROM members').run()
        db.prepare('DELETE FROM projects').run()
        // Reset the singleton team row to defaults rather than
        // deleting it — migrate() seeds it on insert and we don't
        // want to re-trigger that path. Easier to UPDATE in place.
        // The policy columns (maxFileSizeMb, blockedExtensionsJson,
        // quotaGraceHours, and the now-vestigial lfs* columns) are
        // NOT NULL — setting them to NULL throws SQLITE_CONSTRAINT and
        // rolls back the entire reset. Restore them to their schema
        // defaults instead so a reset returns to a true fresh-install
        // state.
        db.prepare(
          `UPDATE team SET name = 'My Team', gitHubOrg = '', projectPrefix = '',
                            welcomeMessage = '', setupComplete = 0,
                            lfsUrl = NULL, gitHubPat = NULL,
                            googleSharedDriveIds = '',
                            maxFileSizeMb = 256, lfsAutotrackThresholdMb = 50,
                            blockedExtensionsJson = '["mp4","mov","avi","mkv","wmv","webm","m4v","flv","mpg","mpeg","3gp","mp3","wav","flac","aac","m4a","ogg","opus","rar","7z","tar","gz","tgz","bz2","xz","txz","iso","lz","lzma","z","exe","msi","dll","dmg","pkg","app","apk","deb","rpm","bat","cmd","com","ps1","sh","run","bin","url","webloc","desktop"]',
                            lfsTokenTtlMinutes = 15,
                            quotaGraceHours = 24, updatedAt = ?
                      WHERE id = 1`
        ).run(Date.now())
        db.prepare(`DELETE FROM sqlite_sequence`).run()
      })()

      // Re-issue the bootstrap admin PIN. SETUP_PIN.txt gets rewritten
      // and the banner re-prints to logs, so an operator who lost the
      // response can still find the new PIN the usual way.
      const { maybeBootstrapAdminPin } = await import('../bootstrap.js')
      const pin = await maybeBootstrapAdminPin(req.log)

      // First entry in the freshly-empty audit log marks the reset
      // itself. actorId is null because the deleting admin is gone;
      // the label preserves their displayName for the human-readable
      // trail.
      logAudit({
        actorId: null,
        actorLabel: `${callerLabel} (deleted by reset)`,
        action: 'server.reset',
        detail: `prior actor id ${callerId}`,
      })

      return {
        success: true,
        // Send the new PIN back so the UI can show it inline instead
        // of forcing the operator to read docker logs again.
        setupPin: pin?.code ?? null,
      }
    },
  )

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

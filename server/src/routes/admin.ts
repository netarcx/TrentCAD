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
import { getDb, logAudit, type Role } from '../db.js'
import { requireAdmin, issuePin, revokePin } from '../auth.js'

const VALID_ROLES: Role[] = ['admin', 'mentor', 'student']

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
  } }>('/api/admin/pins', async (req, reply) => {
    const role = req.body?.role as Role | undefined
    if (!role || !VALID_ROLES.includes(role)) {
      return reply.code(400).send({ error: `role must be one of ${VALID_ROLES.join(', ')}` })
    }
    const pin = issuePin({
      role,
      displayName: req.body?.displayName?.trim() || null,
      githubUsername: req.body?.githubUsername?.trim() || null,
      createdBy: req.member!.id,
      ttlMs: req.body?.ttlMs === null ? null : (req.body?.ttlMs ?? undefined),
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
      `SELECT code, role, displayName, githubUsername, expiresAt, createdAt
         FROM pins
        WHERE consumedAt IS NULL
          AND (expiresAt IS NULL OR expiresAt > ?)
        ORDER BY createdAt DESC`
    ).all(now)
    return { pins: rows }
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

  app.patch<{
    Params: { id: string }
    Body: { role?: string; status?: string; displayName?: string }
  }>('/api/admin/members/:id', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid member id' })

    const updates: string[] = []
    const values: Array<string | number> = []
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

  app.post<{ Body: { name?: string; repoUrl?: string; description?: string } }>(
    '/api/admin/projects',
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim()
      const repoUrl = (req.body?.repoUrl ?? '').trim()
      if (!name || !repoUrl) {
        return reply.code(400).send({ error: 'name and repoUrl are required' })
      }
      try {
        const result = getDb().prepare(
          `INSERT INTO projects (name, repoUrl, description, createdAt)
           VALUES (?, ?, ?, ?)`
        ).run(name, repoUrl, (req.body?.description ?? '').trim(), Date.now())
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

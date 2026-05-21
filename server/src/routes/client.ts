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
import { requireDevice } from '../auth.js'

interface TeamRow {
  name: string
  gitHubOrg: string
  projectPrefix: string
  welcomeMessage: string
  updatedAt: number
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
        !req.url.startsWith('/api/projects')) return
    await requireDevice(req, reply)
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
      updatedAt: team.updatedAt,
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
    // Students with a per-member allowlist only see those project IDs.
    // Admins and mentors always see the full registry — they need to
    // be able to add a student to a project, which requires seeing
    // the project. Members with an empty allowlist see everything,
    // since "no allowlist" means "no restriction." A non-empty
    // allowlist on a non-admin role is a strict filter.
    const member = req.member!
    const rows = getDb().prepare(
      `SELECT id, name, repoUrl, description, createdAt
         FROM projects
        WHERE archived = 0
        ORDER BY createdAt DESC`
    ).all() as Array<Omit<ProjectRow, 'archived'>>

    if (member.role === 'student' && member.allowedProjectIds.length > 0) {
      const allowed = new Set(member.allowedProjectIds)
      return { projects: rows.filter(p => allowed.has(p.id)) }
    }
    return { projects: rows }
  })
}

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
import { config } from '../config.js'
import { lfsEnabled, mintLfsToken } from '../lfs.js'
import { scanProjectStorage } from '../storage.js'

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
        !req.url.startsWith('/api/projects') &&
        !req.url.startsWith('/api/lfs/')) return
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
      // Empty string when LFS isn't configured on this server — clients
      // detect that and fall back to whatever LFS URL the project's
      // `.lfsconfig` already specifies (i.e. GitHub LFS for the few
      // projects that were created before self-hosting).
      lfsUrl: config.lfsServerUrl ?? '',
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
        `SELECT id, name, quotaBytes, storageBytes FROM projects WHERE id = ?`
      ).get(projectId) as {
        id: number
        name: string
        quotaBytes: number | null
        storageBytes: number
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
      // cached value rather than blocking the token issue.
      let currentBytes = project.storageBytes
      try {
        currentBytes = await scanProjectStorage(projectId)
        getDb().prepare(
          `UPDATE projects SET storageBytes = ?, storageScannedAt = ? WHERE id = ?`
        ).run(currentBytes, Date.now(), projectId)
      } catch { /* keep cached value */ }

      const overQuota = project.quotaBytes !== null
        && currentBytes >= project.quotaBytes

      const { token, expiresAt } = mintLfsToken({
        memberId: m.id,
        displayName: m.displayName,
        projectId,
        writable: !overQuota,
      })

      return {
        token,
        expiresAt,
        url: config.lfsServerUrl,
        projectId,
        writable: !overQuota,
        quota: {
          used: currentBytes,
          limit: project.quotaBytes,  // null = unlimited
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

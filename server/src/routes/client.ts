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
  githubOrg: string
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
    return {
      member: req.member,
      device: req.device,
    }
  })

  app.get('/api/team', async () => {
    const team = getDb().prepare(`SELECT * FROM team WHERE id = 1`).get() as TeamRow
    return {
      name: team.name,
      githubOrg: team.githubOrg,
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

  app.get('/api/projects', async () => {
    const rows = getDb().prepare(
      `SELECT id, name, repoUrl, description, createdAt
         FROM projects
        WHERE archived = 0
        ORDER BY createdAt DESC`
    ).all() as Array<Omit<ProjectRow, 'archived'>>
    return { projects: rows }
  })
}

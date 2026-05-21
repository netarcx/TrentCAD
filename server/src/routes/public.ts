/**
 * Routes that don't require authentication.
 *
 * - `GET  /api/health` — liveness probe.
 * - `POST /api/enroll` — exchange a PIN for a bearer token + initial
 *   team snapshot. The ONLY way a client gets a token in the first
 *   place; everything else lives behind `requireDevice`.
 */

import type { FastifyInstance } from 'fastify'
import { getDb, logAudit, type Role, type MemberStatus } from '../db.js'
import { consumePin, generateToken, hashToken } from '../auth.js'

interface EnrollBody {
  pin?: string
  /** Display name to show in the admin UI. Falls back to the PIN's
   *  pre-filled value (when an admin issued a "PIN for Jane Smith"). */
  displayName?: string
  /** Local hostname / "Trent's laptop" — purely descriptive. */
  deviceLabel?: string
  /** Optional GitHub username; falls back to the PIN's pre-bind value. */
  githubUsername?: string
}

interface TeamRow {
  id: number
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

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok', name: 'framecad-server' }))

  app.post<{ Body: EnrollBody }>('/api/enroll', async (req, reply) => {
    const body = req.body ?? {}
    const pin = (body.pin ?? '').trim().toUpperCase()
    if (!pin) {
      return reply.code(400).send({ error: 'Missing PIN' })
    }

    // Burn the PIN atomically. Returns null on unknown / consumed / expired.
    const pinRow = consumePin(pin)
    if (!pinRow) {
      return reply.code(401).send({ error: 'PIN is invalid, already used, or expired' })
    }

    const db = getDb()
    const now = Date.now()

    // Resolve display name + GitHub username. Caller-supplied values win,
    // PIN-baked-in values are fallbacks. If neither, we use a placeholder
    // the admin can edit from the web UI later.
    const displayName =
      (body.displayName ?? '').trim() ||
      pinRow.displayName ||
      'Unnamed member'
    const githubUsername =
      (body.githubUsername ?? '').trim() ||
      pinRow.githubUsername ||
      null

    // If a member with the same GitHub username already exists, reuse
    // that record — same person enrolling a second device. Otherwise
    // create a fresh member row. The admin can clean up duplicates
    // from the web UI if a bare displayName collides.
    let member: MemberRow | undefined
    if (githubUsername) {
      member = db.prepare(
        `SELECT * FROM members WHERE LOWER(githubUsername) = LOWER(?)`
      ).get(githubUsername) as MemberRow | undefined
    }
    if (!member) {
      const result = db.prepare(
        `INSERT INTO members (displayName, githubUsername, role, status, joinedAt)
         VALUES (?, ?, ?, 'active', ?)`
      ).run(displayName, githubUsername, pinRow.role, now)
      member = db.prepare(
        `SELECT * FROM members WHERE id = ?`
      ).get(result.lastInsertRowid as number) as MemberRow
    } else {
      // Reusing an existing record. Bump the role to the PIN's role
      // ONLY if it's higher — i.e. an admin-issued mentor PIN upgrades a
      // student, but consuming a student PIN never demotes a mentor.
      const rank: Record<Role, number> = { student: 0, mentor: 1, admin: 2 }
      if (rank[pinRow.role] > rank[member.role]) {
        db.prepare(`UPDATE members SET role = ? WHERE id = ?`)
          .run(pinRow.role, member.id)
        member.role = pinRow.role
      }
      if (member.status !== 'active') {
        db.prepare(`UPDATE members SET status = 'active' WHERE id = ?`).run(member.id)
        member.status = 'active'
      }
    }

    // Mint the device row + bearer token. Token is shown ONCE (in the
    // response) and never logged; only its argon2id hash hits disk.
    const token = generateToken()
    const tokenHash = await hashToken(token)
    const deviceLabel = (body.deviceLabel ?? '').trim() || 'device'
    const deviceResult = db.prepare(
      `INSERT INTO devices (memberId, label, tokenHash, createdAt, lastSeenAt)
       VALUES (?, ?, ?, ?, ?)`
    ).run(member.id, deviceLabel, tokenHash, now, now)

    const team = db.prepare(`SELECT * FROM team WHERE id = 1`).get() as TeamRow

    logAudit({
      actorId: member.id,
      actorLabel: member.displayName,
      action: 'enroll',
      target: `device:${deviceResult.lastInsertRowid}`,
      detail: `pin=${pinRow.code} role=${pinRow.role}`,
    })

    return {
      token,
      device: { id: deviceResult.lastInsertRowid as number, label: deviceLabel },
      member: {
        id: member.id,
        displayName: member.displayName,
        githubUsername: member.githubUsername,
        role: member.role,
      },
      team: {
        name: team.name,
        githubOrg: team.githubOrg,
        projectPrefix: team.projectPrefix,
        welcomeMessage: team.welcomeMessage,
      },
    }
  })
}

/**
 * Routes that don't require authentication.
 *
 * - `GET  /api/health` — liveness probe.
 * - `POST /api/enroll` — exchange a PIN for a bearer token + initial
 *   team snapshot. The ONLY way a client gets a token in the first
 *   place; everything else lives behind `requireDevice`.
 */

import type { FastifyInstance } from 'fastify'
import {
  getDb,
  logAudit,
  parseCapabilities,
  parseAllowedProjectIds,
  type Role,
  type MemberStatus,
  type MemberCapabilities,
} from '../db.js'
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
  /** Desktop's running FrameCAD version (e.g. "3.0.3"). Stored on the
   *  device row so the admin UI can flag outdated clients without
   *  waiting for the first authed heartbeat. */
  clientVersion?: string
}

interface TeamRow {
  id: number
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
  capabilities: string | null
  allowedProjectIds: string | null
  autoOpenProjectId: number | null
  kioskMode: number
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
    // Capabilities + allowlist + auto-open come from the PIN row. The
    // admin baked them in at PIN-issue time; we copy them onto the
    // member row so they survive subsequent enrollments of additional
    // devices for the same person (those don't re-consume a PIN).
    const pinCaps = parseCapabilities(pinRow.capabilities)
    const pinAllowlist = parseAllowedProjectIds(pinRow.allowedProjectIds)
    const pinAutoOpen = pinRow.autoOpenProjectId
    const pinKiosk = (pinRow as { kioskMode?: number }).kioskMode === 1 && pinAutoOpen !== null

    if (!member) {
      const result = db.prepare(
        `INSERT INTO members (displayName, githubUsername, role, status, joinedAt,
                              capabilities, allowedProjectIds, autoOpenProjectId, kioskMode)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      ).run(
        displayName,
        githubUsername,
        pinRow.role,
        now,
        JSON.stringify(pinCaps),
        JSON.stringify(pinAllowlist),
        pinAutoOpen,
        pinKiosk ? 1 : 0,
      )
      member = db.prepare(
        `SELECT * FROM members WHERE id = ?`
      ).get(result.lastInsertRowid as number) as MemberRow
    } else {
      // Reusing an existing record. Bump the role to the PIN's role
      // ONLY if it's higher — i.e. an admin-issued mentor PIN upgrades a
      // student, but consuming a student PIN never demotes a mentor.
      // Capabilities follow the same "upgrade-only" rule (an existing
      // member never LOSES caps from a fresh enrollment); the explicit
      // way to lock down an existing member is the admin web UI.
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
      // OR-merge capabilities so re-enrolling can only widen them.
      const existingCaps = parseCapabilities(member.capabilities)
      const mergedCaps: MemberCapabilities = {
        createProject: existingCaps.createProject || pinCaps.createProject,
        browseTeamProjects: existingCaps.browseTeamProjects || pinCaps.browseTeamProjects,
        openProject: existingCaps.openProject || pinCaps.openProject,
        manufacturingView: existingCaps.manufacturingView || pinCaps.manufacturingView,
      }
      // Merge project allowlists (union). If either was empty (= "all"),
      // we'd want to keep that — but our convention is empty = none, so
      // straight union is correct.
      const existingAllowlist = parseAllowedProjectIds(member.allowedProjectIds)
      const mergedAllowlist = Array.from(new Set([...existingAllowlist, ...pinAllowlist]))
      // Auto-open: keep the existing one if set; only overwrite when the
      // member had none and the PIN provides one.
      const mergedAutoOpen = member.autoOpenProjectId ?? pinAutoOpen
      // Kiosk mode: OR-merge so a kiosk PIN can promote an existing
      // non-kiosk member into kiosk mode, but a non-kiosk re-enroll
      // never accidentally drops someone out of kiosk. Locked to the
      // mergedAutoOpen value — kiosk without a project is meaningless.
      const existingKiosk = member.kioskMode === 1
      const mergedKiosk = (existingKiosk || pinKiosk) && mergedAutoOpen !== null
      db.prepare(
        `UPDATE members
            SET capabilities = ?, allowedProjectIds = ?, autoOpenProjectId = ?,
                kioskMode = ?
          WHERE id = ?`
      ).run(
        JSON.stringify(mergedCaps),
        JSON.stringify(mergedAllowlist),
        mergedAutoOpen,
        mergedKiosk ? 1 : 0,
        member.id,
      )
      member.capabilities = JSON.stringify(mergedCaps)
      member.allowedProjectIds = JSON.stringify(mergedAllowlist)
      member.autoOpenProjectId = mergedAutoOpen
      member.kioskMode = mergedKiosk ? 1 : 0
    }

    // Mint the device row + bearer token. Token is shown ONCE (in the
    // response) and never logged; only its argon2id hash hits disk.
    const token = generateToken()
    const tokenHash = await hashToken(token)
    const deviceLabel = (body.deviceLabel ?? '').trim() || 'device'
    const clientVersion =
      ((body.clientVersion ?? '').replace(/^v/i, '').slice(0, 32).trim()) || null
    const deviceResult = db.prepare(
      `INSERT INTO devices (memberId, label, tokenHash, createdAt, lastSeenAt, clientVersion)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(member.id, deviceLabel, tokenHash, now, now, clientVersion)

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
        capabilities: parseCapabilities(member.capabilities),
        allowedProjectIds: parseAllowedProjectIds(member.allowedProjectIds),
        autoOpenProjectId: member.autoOpenProjectId,
        kioskMode: member.kioskMode === 1 && member.autoOpenProjectId !== null,
      },
      team: {
        name: team.name,
        gitHubOrg: team.gitHubOrg,
        projectPrefix: team.projectPrefix,
        welcomeMessage: team.welcomeMessage,
      },
    }
  })
}

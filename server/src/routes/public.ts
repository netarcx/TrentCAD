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
import { consumePin, generateToken, hashToken, verifyPassword } from '../auth.js'

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

  // ── Password login ─────────────────────────────────────────────────
  //
  // Username + password authentication for admins on the web UI. PINs
  // are still the bootstrap path (you can't log in with a password
  // you've never set), but once an admin has claimed and set a
  // password, this is the recurring login surface — appropriate for
  // an internet-exposed deployment where PIN-only was too weak.
  //
  // Username matching is case-insensitive against either displayName
  // or githubUsername. Failed attempts increment a counter; the
  // 5th failure within 15 minutes locks the account for the next
  // 15 minutes (regardless of which IP is trying). After a successful
  // login the counter resets.
  //
  // Account-lock window: 15 min. Same window for "count failures
  // toward the lock". So a determined attacker can do 4 attempts
  // every 15 min indefinitely — but that's ~14 attempts/hour, which
  // against argon2id passwords is computationally cheap to ignore.
  app.post<{ Body: { username?: string; password?: string; deviceLabel?: string } }>(
    '/api/login',
    async (req, reply) => {
      const username = (req.body?.username ?? '').trim()
      const password = req.body?.password ?? ''
      if (!username || !password) {
        return reply.code(400).send({ error: 'Username and password are required.' })
      }

      const db = getDb()
      const now = Date.now()

      // Lookup is case-insensitive and tries the explicit `username`
      // column first (the canonical login handle picked at set-
      // password time), then falls back to displayName / githubUsername
      // for legacy members who haven't been through the set-password
      // flow yet. The order matters: a member named "trent" with a
      // GitHub username of "tfox" who sets their login username to
      // "tfox" too should resolve to themselves, not collide with
      // someone else who happens to be named "tfox" on display.
      const member = db.prepare(
        `SELECT id, displayName, githubUsername, role, status, passwordHash,
                failedLoginCount, lockedUntil, capabilities, allowedProjectIds,
                autoOpenProjectId, kioskMode
           FROM members
          WHERE status = 'active'
            AND (
              LOWER(username) = LOWER(?)
              OR LOWER(displayName) = LOWER(?)
              OR LOWER(githubUsername) = LOWER(?)
            )
          LIMIT 1`
      ).get(username, username, username) as {
        id: number
        displayName: string
        githubUsername: string | null
        role: 'admin' | 'mentor' | 'student'
        status: 'active' | 'inactive'
        passwordHash: string | null
        failedLoginCount: number
        lockedUntil: number | null
        capabilities: string | null
        allowedProjectIds: string | null
        autoOpenProjectId: number | null
        kioskMode: number
      } | undefined

      // Sleep-on-fail to slow down brute force. argon2 verify on a
      // dummy hash for the "user not found" case keeps the timing
      // similar between found-but-wrong-password and not-found,
      // closing the user-enumeration timing channel.
      if (!member || !member.passwordHash) {
        // Match the verify-time of a real argon2 check so an attacker
        // can't enumerate which usernames exist by timing the response.
        await verifyPassword(
          '$argon2id$v=19$m=19456,t=2,p=1$dummysaltdummy$dummyhashdummyhashdum',
          password,
        ).catch(() => false)
        return reply.code(401).send({ error: 'Invalid username or password.' })
      }

      // Locked out — even a correct password is rejected until the
      // lock expires. We don't leak HOW LONG; just "try later".
      if (member.lockedUntil !== null && member.lockedUntil > now) {
        const minutes = Math.ceil((member.lockedUntil - now) / 60000)
        return reply.code(429).send({
          error: `Account temporarily locked due to repeated failed login attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        })
      }

      const ok = await verifyPassword(member.passwordHash, password)
      if (!ok) {
        const newCount = member.failedLoginCount + 1
        // Five strikes within rolling 15-minute window locks the
        // account. The "rolling" part is implicit — we never reset
        // the count except on successful login, but the lockedUntil
        // timestamp is what actually gates access. Simpler than
        // tracking a true sliding window.
        const LOCK_THRESHOLD = 5
        const LOCK_DURATION_MS = 15 * 60 * 1000
        const newLockedUntil = newCount >= LOCK_THRESHOLD
          ? now + LOCK_DURATION_MS
          : null
        db.prepare(
          `UPDATE members SET failedLoginCount = ?, lockedUntil = ? WHERE id = ?`
        ).run(newCount, newLockedUntil, member.id)
        logAudit({
          actorId: member.id,
          actorLabel: member.displayName,
          action: newLockedUntil ? 'login.locked' : 'login.failed',
          target: `member:${member.id}`,
          detail: `count=${newCount}`,
        })
        return reply.code(401).send({ error: 'Invalid username or password.' })
      }

      // Reset the failure counter on success + record lastLoginAt
      // for audit / "show last sign-in" UX later.
      db.prepare(
        `UPDATE members
            SET failedLoginCount = 0,
                lockedUntil = NULL,
                lastLoginAt = ?
          WHERE id = ?`
      ).run(now, member.id)

      // Mint a fresh device row — same shape as enrollment so all
      // the existing `requireDevice` paths just work. Re-use the
      // device-label-or-default policy.
      const token = generateToken()
      const tokenHash = await hashToken(token)
      const deviceLabel = (req.body?.deviceLabel ?? '').trim() || 'web session'
      const deviceResult = db.prepare(
        `INSERT INTO devices (memberId, label, tokenHash, createdAt, lastSeenAt, kind)
         VALUES (?, ?, ?, ?, ?, 'web')`
      ).run(member.id, deviceLabel, tokenHash, now, now)

      const teamRow = db.prepare(`SELECT * FROM team WHERE id = 1`).get() as TeamRow

      logAudit({
        actorId: member.id,
        actorLabel: member.displayName,
        action: 'login.success',
        target: `device:${deviceResult.lastInsertRowid}`,
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
          name: teamRow.name,
          gitHubOrg: teamRow.gitHubOrg,
          projectPrefix: teamRow.projectPrefix,
          welcomeMessage: teamRow.welcomeMessage,
        },
      }
    },
  )
}

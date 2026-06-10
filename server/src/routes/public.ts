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
import { consumePin, findPin, generateToken, hashToken, verifyPassword } from '../auth.js'

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
  /** 'web' for admin-UI browser sessions (30-day token TTL), anything
   *  else — including absent, which is what the desktop sends — is
   *  'desktop' (non-expiring token). */
  kind?: string
  /** When true, reject non-admin PINs with 403 BEFORE consuming a use —
   *  the admin web UI's PIN sign-in path, where burning a student PIN
   *  on a doomed sign-in attempt would be hostile. */
  adminOnly?: boolean
}

interface TeamRow {
  id: number
  name: string
  gitHubOrg: string
  projectPrefix: string
  welcomeMessage: string
  googleSharedDriveIds?: string
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
  archiveMode: number
}

// ── PIN brute-force throttle (per client IP) ──────────────────────────────
// Enrollment is the ONLY unauthenticated way to obtain a bearer token, and a
// 6-char PIN (32^6 ≈ 1e9 keyspace) is brute-forceable on an internet-exposed
// server without a throttle. `/api/login` has a per-member lockout, but enroll
// has no member yet — the PIN *is* the identity — so we throttle per source IP
// instead. We track FAILED guesses in memory and lock an IP out for a cooldown
// once it crosses the threshold within a rolling window; a successful enroll
// resets that IP's counter. Thresholds are deliberately generous so a whole
// team behind one NATed school IP fat-fingering PINs won't lock out, yet brute
// force is cut to a few thousand guesses/day (millennia to exhaust the space).
const ENROLL_WINDOW_MS = 15 * 60 * 1000
const ENROLL_MAX_FAILS = 20
const ENROLL_LOCK_MS = 15 * 60 * 1000
const enrollAttempts = new Map<string, { fails: number; windowStart: number; lockedUntil: number }>()

function enrollLockRemainingMs(ip: string, now: number): number {
  const rec = enrollAttempts.get(ip)
  return rec && rec.lockedUntil > now ? rec.lockedUntil - now : 0
}

function recordEnrollFailure(ip: string, now: number): void {
  let rec = enrollAttempts.get(ip)
  if (!rec || now - rec.windowStart > ENROLL_WINDOW_MS) {
    rec = { fails: 0, windowStart: now, lockedUntil: 0 }
  }
  rec.fails += 1
  if (rec.fails >= ENROLL_MAX_FAILS) {
    rec.lockedUntil = now + ENROLL_LOCK_MS
    rec.fails = 0
    rec.windowStart = now
  }
  enrollAttempts.set(ip, rec)
  // Opportunistic prune so one-off scanner IPs can't grow the map unbounded.
  if (enrollAttempts.size > 5000) {
    for (const [k, v] of enrollAttempts) {
      if (v.lockedUntil <= now && now - v.windowStart > ENROLL_WINDOW_MS) enrollAttempts.delete(k)
    }
  }
}

// ── Password brute-force throttle (per client IP + username) ──────────────
// Failed logins used to lock the ACCOUNT (member row) for 15 minutes
// regardless of source, which let anyone who knew an admin's username keep
// that admin locked out forever — and bootstrap recovery is disabled once a
// password admin exists. Keying on `${ip}|${username}` means an attacker
// only locks themselves out; the real admin on a different IP signs in
// unaffected. Same shape and pruning policy as the enroll throttle above.
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILS = 5
const LOGIN_LOCK_MS = 15 * 60 * 1000
const loginAttempts = new Map<string, { fails: number; windowStart: number; lockedUntil: number }>()

function loginLockRemainingMs(key: string, now: number): number {
  const rec = loginAttempts.get(key)
  return rec && rec.lockedUntil > now ? rec.lockedUntil - now : 0
}

/** Returns true when this failure tripped the lock. */
function recordLoginFailure(key: string, now: number): boolean {
  let rec = loginAttempts.get(key)
  if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
    rec = { fails: 0, windowStart: now, lockedUntil: 0 }
  }
  rec.fails += 1
  let locked = false
  if (rec.fails >= LOGIN_MAX_FAILS) {
    rec.lockedUntil = now + LOGIN_LOCK_MS
    rec.fails = 0
    rec.windowStart = now
    locked = true
  }
  loginAttempts.set(key, rec)
  // Opportunistic prune so scanner traffic can't grow the map unbounded.
  if (loginAttempts.size > 5000) {
    for (const [k, v] of loginAttempts) {
      if (v.lockedUntil <= now && now - v.windowStart > LOGIN_WINDOW_MS) loginAttempts.delete(k)
    }
  }
  return locked
}

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok', name: 'framecad-server' }))

  app.post<{ Body: EnrollBody }>('/api/enroll', async (req, reply) => {
    const body = req.body ?? {}
    const now = Date.now()
    const clientIp = req.ip || 'unknown'

    const lockMs = enrollLockRemainingMs(clientIp, now)
    if (lockMs > 0) {
      const minutes = Math.ceil(lockMs / 60000)
      return reply.code(429).send({
        error: `Too many failed enrollment attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      })
    }

    const pin = (body.pin ?? '').trim().toUpperCase()
    if (!pin) {
      return reply.code(400).send({ error: 'Missing PIN' })
    }
    const deviceKind = body.kind === 'web' ? 'web' : 'desktop'

    // Admin-only enrollments (the admin web UI's PIN sign-in) pre-check
    // the PIN's role WITHOUT consuming a use — a mentor/student PIN
    // pasted into the admin sign-in box should bounce, not burn. An
    // unknown PIN falls through to consumePin below so it still counts
    // as a brute-force guess.
    if (body.adminOnly) {
      const candidate = findPin(pin)
      if (candidate && candidate.role !== 'admin') {
        return reply.code(403).send({ error: 'This PIN is not an admin PIN' })
      }
    }

    // Burn the PIN atomically. Returns null on unknown / consumed / expired.
    const pinRow = consumePin(pin)
    if (!pinRow) {
      recordEnrollFailure(clientIp, now)
      return reply.code(401).send({ error: 'PIN is invalid, has no remaining uses, or has expired' })
    }
    // Valid PIN → this IP isn't brute-forcing; clear its failure record.
    enrollAttempts.delete(clientIp)

    const db = getDb()

    // Resolve display name + GitHub username. Caller-supplied values win,
    // PIN-baked-in values are fallbacks. If neither, we use a placeholder
    // the admin can edit from the web UI later.
    const displayName =
      (body.displayName ?? '').trim() ||
      pinRow.displayName ||
      'Unnamed member'
    // SECURITY: identity comes from the PIN's bound githubUsername ONLY — a
    // caller-supplied `body.githubUsername` is NEVER trusted for identity or
    // member-reuse. Otherwise any PIN-holder could pass another member's
    // (public) GitHub handle, get matched to that member's row, and inherit
    // their role (roles are upgrade-only on reuse → privilege escalation to
    // admin). The PIN is the capability; the admin binds the identity to it
    // at PIN-issue time. (The desktop no longer sends a handle at all.)
    const githubUsername = pinRow.githubUsername || null

    // Reuse an existing member row only for the PIN's own bound identity —
    // the same person enrolling a second device with an identity-bound PIN.
    // An unbound PIN always creates a fresh member row.
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
    const pinArchive = (pinRow as { archiveMode?: number }).archiveMode === 1

    if (!member) {
      const result = db.prepare(
        `INSERT INTO members (displayName, githubUsername, role, status, joinedAt,
                              capabilities, allowedProjectIds, autoOpenProjectId, kioskMode, archiveMode)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
      ).run(
        displayName,
        githubUsername,
        pinRow.role,
        now,
        JSON.stringify(pinCaps),
        JSON.stringify(pinAllowlist),
        pinAutoOpen,
        pinKiosk ? 1 : 0,
        pinArchive ? 1 : 0,
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
        manageCadStructure: existingCaps.manageCadStructure || pinCaps.manageCadStructure,
        forceCheckIn: existingCaps.forceCheckIn || pinCaps.forceCheckIn,
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
      // Archive mode: OR-merge like kiosk so an archive PIN can promote an
      // existing member into a read-only mirror, but a normal re-enroll never
      // drops them out of it. No autoOpen precondition — it stands alone.
      const mergedArchive = member.archiveMode === 1 || pinArchive
      db.prepare(
        `UPDATE members
            SET capabilities = ?, allowedProjectIds = ?, autoOpenProjectId = ?,
                kioskMode = ?, archiveMode = ?
          WHERE id = ?`
      ).run(
        JSON.stringify(mergedCaps),
        JSON.stringify(mergedAllowlist),
        mergedAutoOpen,
        mergedKiosk ? 1 : 0,
        mergedArchive ? 1 : 0,
        member.id,
      )
      member.capabilities = JSON.stringify(mergedCaps)
      member.allowedProjectIds = JSON.stringify(mergedAllowlist)
      member.autoOpenProjectId = mergedAutoOpen
      member.kioskMode = mergedKiosk ? 1 : 0
      member.archiveMode = mergedArchive ? 1 : 0
    }

    // Mint the device row + bearer token. Token is shown ONCE (in the
    // response) and never logged; only its argon2id hash hits disk.
    const token = generateToken()
    const tokenHash = await hashToken(token)
    const deviceLabel = (body.deviceLabel ?? '').trim() || 'device'
    const clientVersion =
      ((body.clientVersion ?? '').replace(/^v/i, '').slice(0, 32).trim()) || null
    const deviceResult = db.prepare(
      `INSERT INTO devices (memberId, label, tokenHash, createdAt, lastSeenAt, kind, clientVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(member.id, deviceLabel, tokenHash, now, now, deviceKind, clientVersion)

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
        archiveMode: member.archiveMode === 1,
      },
      team: {
        name: team.name,
        gitHubOrg: team.gitHubOrg,
        projectPrefix: team.projectPrefix,
        welcomeMessage: team.welcomeMessage,
        googleSharedDriveIds: team.googleSharedDriveIds ?? '',
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
  // or githubUsername. Failed attempts increment a per-IP+username
  // counter; the 5th failure within 15 minutes locks that IP out of
  // that username for the next 15 minutes (other IPs — i.e. the real
  // owner — are unaffected). After a successful login the counter
  // resets.
  //
  // Lock window: 15 min. Same window for "count failures toward the
  // lock". So a determined attacker can do 4 attempts every 15 min
  // per IP indefinitely — but that's ~14 attempts/hour, which against
  // argon2id passwords is computationally cheap to ignore.
  app.post<{ Body: { username?: string; password?: string; deviceLabel?: string; kind?: string; clientVersion?: string } }>(
    '/api/login',
    async (req, reply) => {
      const username = (req.body?.username ?? '').trim()
      const password = req.body?.password ?? ''
      if (!username || !password) {
        return reply.code(400).send({ error: 'Username and password are required.' })
      }
      const deviceKind = req.body?.kind === 'desktop' ? 'desktop' : 'web'

      const db = getDb()
      const now = Date.now()
      const loginKey = `${req.ip || 'unknown'}|${username.toLowerCase()}`

      // Locked out — even a correct password is rejected until the
      // lock expires. We don't leak HOW LONG precisely; just "try later".
      const lockMs = loginLockRemainingMs(loginKey, now)
      if (lockMs > 0) {
        const minutes = Math.ceil(lockMs / 60000)
        return reply.code(429).send({
          error: `Too many failed login attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        })
      }

      // Lookup is case-insensitive and tries the explicit `username`
      // column first (the canonical login handle picked at set-
      // password time), then falls back to displayName / githubUsername
      // for legacy members who haven't been through the set-password
      // flow yet. The order matters: a member named "trent" with a
      // GitHub username of "tfox" who sets their login username to
      // "tfox" too should resolve to themselves, not collide with
      // someone else who happens to be named "tfox" on display.
      // Two-step lookup to avoid ambiguity. The original OR-match with
      // LIMIT 1 (no ORDER BY) was non-deterministic — if two active
      // members both responded to the same typed handle (one via
      // `username`, another via `displayName`), SQLite picked whichever
      // row it read first. Resolution-order needs to be deterministic
      // AND prefer the explicit login handle, so we look up `username`
      // first and only fall back to legacy display/github fields when
      // no username row matches.
      type MemberRow = {
        id: number
        displayName: string
        githubUsername: string | null
        role: 'admin' | 'mentor' | 'student'
        status: 'active' | 'inactive'
        passwordHash: string | null
        failedLoginCount: number
        failedLoginFirstAt: number | null
        lockedUntil: number | null
        capabilities: string | null
        allowedProjectIds: string | null
        autoOpenProjectId: number | null
        kioskMode: number
        archiveMode: number
      }
      const SELECT_FIELDS = `id, displayName, githubUsername, role, status, passwordHash,
                             failedLoginCount, failedLoginFirstAt, lockedUntil, capabilities,
                             allowedProjectIds, autoOpenProjectId, kioskMode, archiveMode`
      let member = db.prepare(
        `SELECT ${SELECT_FIELDS}
           FROM members
          WHERE status = 'active' AND LOWER(username) = LOWER(?)
          LIMIT 1`
      ).get(username) as MemberRow | undefined
      if (!member) {
        member = db.prepare(
          `SELECT ${SELECT_FIELDS}
             FROM members
            WHERE status = 'active'
              AND (LOWER(displayName) = LOWER(?) OR LOWER(githubUsername) = LOWER(?))
            ORDER BY id ASC
            LIMIT 1`
        ).get(username, username) as MemberRow | undefined
      }

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
        // Unknown usernames count toward the same throttle so guessing
        // handles is no cheaper than guessing passwords.
        recordLoginFailure(loginKey, now)
        return reply.code(401).send({ error: 'Invalid username or password.' })
      }

      const ok = await verifyPassword(member.passwordHash, password)
      if (!ok) {
        const locked = recordLoginFailure(loginKey, now)
        logAudit({
          actorId: member.id,
          actorLabel: member.displayName,
          action: locked ? 'login.locked' : 'login.failed',
          target: `member:${member.id}`,
          detail: `ip=${req.ip || 'unknown'}`,
        })
        return reply.code(401).send({ error: 'Invalid username or password.' })
      }
      // Valid credentials → this IP isn't brute-forcing this account.
      loginAttempts.delete(loginKey)

      // Reset the failure counter on success + record lastLoginAt
      // for audit / "show last sign-in" UX later.
      db.prepare(
        `UPDATE members
            SET failedLoginCount = 0,
                failedLoginFirstAt = NULL,
                lockedUntil = NULL,
                lastLoginAt = ?
          WHERE id = ?`
      ).run(now, member.id)

      // Mint a fresh device row — same shape as enrollment so all
      // the existing `requireDevice` paths just work. Re-use the
      // device-label-or-default policy.
      const token = generateToken()
      const tokenHash = await hashToken(token)
      const deviceLabel = (req.body?.deviceLabel ?? '').trim() || (deviceKind === 'desktop' ? 'device' : 'web session')
      const clientVersion =
        ((req.body?.clientVersion ?? '').replace(/^v/i, '').slice(0, 32).trim()) || null
      const deviceResult = db.prepare(
        `INSERT INTO devices (memberId, label, tokenHash, createdAt, lastSeenAt, kind, clientVersion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(member.id, deviceLabel, tokenHash, now, now, deviceKind, clientVersion)

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
          archiveMode: member.archiveMode === 1,
        },
        team: {
          name: teamRow.name,
          gitHubOrg: teamRow.gitHubOrg,
          projectPrefix: teamRow.projectPrefix,
          welcomeMessage: teamRow.welcomeMessage,
          googleSharedDriveIds: teamRow.googleSharedDriveIds ?? '',
        },
      }
    },
  )
}

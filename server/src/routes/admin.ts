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
import { effectiveLfsUrl } from './client.js'

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
    kioskMode?: boolean
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
      kioskMode: !!req.body?.kioskMode,
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
              capabilities, allowedProjectIds, autoOpenProjectId, kioskMode
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
      kioskMode: number
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
              capabilities, allowedProjectIds, autoOpenProjectId, kioskMode
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
    if ('kioskMode' in (req.body ?? {})) {
      // Coerce to 0/1 for SQLite. The trigger that ties kiosk to
      // autoOpenProjectId !== null lives at read time (findDeviceByToken
      // + /api/me + /api/admin/members all gate it), so we don't try
      // to enforce a multi-column invariant inside the UPDATE.
      updates.push('kioskMode = ?')
      values.push(req.body!.kioskMode ? 1 : 0)
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
              quotaBytes, storageBytes, storageScannedAt,
              remoteStatus, remoteCheckedAt
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

  // Check whether a project's GitHub repo still exists. HEAD against
  // `https://github.com/<org>/<repo>` returns 200 when the repo is
  // public and reachable, 404 when deleted or made private (we treat
  // both the same — from the team's perspective, "can't reach it"
  // means "needs cleanup"). Caches the result on the project row so
  // subsequent admin-page renders don't re-hit GitHub.
  //
  // Doesn't try to authenticate — public 200 vs 404 is enough signal
  // and avoids needing GitHub credentials on the server. If the repo
  // is private and someone hits this endpoint, it'll show "missing"
  // even though it exists; that's a known limitation and the admin
  // can ignore it for private repos.
  app.post<{ Params: { id: string } }>(
    '/api/admin/projects/:id/check-remote',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid project id' })
      const row = getDb().prepare(
        `SELECT id, repoUrl FROM projects WHERE id = ?`
      ).get(id) as { id: number; repoUrl: string } | undefined
      if (!row) return reply.code(404).send({ error: 'Project not found' })

      // Normalise the URL to its github.com/owner/repo form. We strip
      // the trailing .git, any trailing slash, and any auth prefix
      // (https://user:token@github.com/...) so the HEAD request goes
      // through the public, cache-friendly path.
      const url = row.repoUrl
        .trim()
        .replace(/\.git$/i, '')
        .replace(/\/+$/, '')
        .replace(/https?:\/\/[^/]*@/, 'https://')

      // SSRF defence: only probe URLs that resolve to github.com.
      // An admin could in principle set repoUrl to an internal URL
      // (intentionally or by typo); fetching with default redirect-
      // follow would then let an attacker who controls a repoUrl
      // probe the server's internal network. We don't need to
      // support arbitrary git hosts here — the entire FrameCAD
      // workflow is GitHub-based.
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return reply.code(400).send({ error: 'Project repoUrl is not a valid URL.' })
      }
      if (parsed.hostname.toLowerCase() !== 'github.com') {
        return reply.code(400).send({
          error: 'check-remote only supports github.com URLs. If you need self-hosted git support, file a feature request.',
        })
      }

      let status: 'ok' | 'missing' | 'error' = 'error'
      let detail: string | null = null
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 5000)
        try {
          // `redirect: 'manual'` so a malicious 30x can't redirect us
          // off github.com to an internal host. We treat any redirect
          // as "I don't know" rather than following it.
          const res = await fetch(url, {
            method: 'HEAD',
            signal: controller.signal,
            redirect: 'manual',
          })
          if (res.status === 200) status = 'ok'
          else if (res.status === 404 || res.status === 401) status = 'missing'
          else { status = 'error'; detail = `HTTP ${res.status}` }
        } finally {
          clearTimeout(timer)
        }
      } catch (err) {
        status = 'error'
        detail = (err as Error).message || 'network error'
      }

      // Only persist the 'ok' / 'missing' verdicts; 'error' (network
      // hiccup, GitHub down, etc.) shouldn't overwrite a previously-
      // confirmed 'ok' state. Refresh the timestamp regardless so the
      // admin sees when we last looked.
      if (status === 'ok' || status === 'missing') {
        getDb().prepare(
          `UPDATE projects SET remoteStatus = ?, remoteCheckedAt = ? WHERE id = ?`
        ).run(status, Date.now(), id)
      } else {
        getDb().prepare(
          `UPDATE projects SET remoteCheckedAt = ? WHERE id = ?`
        ).run(Date.now(), id)
      }

      logAudit({
        actorId: req.member!.id,
        actorLabel: req.member!.displayName,
        action: 'project.check-remote',
        target: `project:${id}`,
        detail: `status=${status}${detail ? ` (${detail})` : ''}`,
      })

      return { status, detail, checkedAt: Date.now() }
    },
  )

  // Generate a shell script the admin runs on their dev machine to
  // migrate a project's existing GitHub-LFS objects over to the
  // self-hosted LFS server. We don't run git on the team server
  // itself — that'd require cloning the repo + having GitHub
  // credentials at the server level, which is a much bigger lift.
  // Instead we hand the admin the exact commands so they can do it
  // from a workstation that already has the repo cloned + the LFS
  // server reachable.
  //
  // The endpoint mints a fresh LFS JWT and embeds it in the script so
  // the admin doesn't need to wrangle authentication separately. The
  // token is the standard 15-minute one — long enough for `git lfs
  // push` of a typical robot's worth of objects, short enough that a
  // leaked script copy is useless after that window.
  app.post<{ Params: { id: string } }>(
    '/api/admin/projects/:id/migrate-lfs',
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) {
        return reply.code(400).send({ error: 'Invalid project id' })
      }
      const project = getDb().prepare(
        `SELECT id, name, repoUrl FROM projects WHERE id = ?`
      ).get(id) as { id: number; name: string; repoUrl: string } | undefined
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' })
      }

      const { lfsEnabled, mintLfsToken } = await import('../lfs.js')
      const { config } = await import('../config.js')
      if (!lfsEnabled() || !config.lfsServerUrl) {
        return reply.code(503).send({
          error: 'Self-hosted LFS is not configured on this server.',
        })
      }

      const { token } = mintLfsToken({
        memberId: req.member!.id,
        displayName: req.member!.displayName,
        projectId: project.id,
        writable: true,
      })
      const lfsEndpoint = `${config.lfsServerUrl.replace(/\/+$/, '')}/framecad/${project.id}`
      // Defence-in-depth: the lfsUrl validator on PATCH /api/admin/team
      // should already block bad URLs from reaching here, but if an
      // old DB row was set before the validator existed (or the env
      // var fallback is wonky), refuse to template a script with an
      // unsafe URL rather than handing the admin something that could
      // execute arbitrary shell when pasted.
      if (!/^https?:\/\/[^\s"'<>`$]+$/.test(config.lfsServerUrl)) {
        return reply.code(500).send({
          error: 'LFS server URL is malformed — ask whoever runs the server to fix it in Team Settings.',
        })
      }
      // Sanitize project name + repoUrl for safe inclusion in shell /
      // PowerShell script comments. Comments are only "safe" until a
      // newline ends the comment — a name with embedded \r\n could
      // smuggle commands onto the next line. Strip any newline /
      // CR / backtick / `$()` shell-meta sequences proactively.
      const scriptSafe = (s: string): string => s
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[`$]/g, '?')
        .slice(0, 200)
      const safeName = scriptSafe(project.name)
      const safeRepoUrl = scriptSafe(project.repoUrl)

      // POSIX + Windows-PowerShell variants. We send both so the
      // admin can paste whichever matches their shell without
      // having to translate quoting / continuation chars by hand.
      const posixScript = [
        '#!/usr/bin/env bash',
        'set -e',
        '# Migrate this project\'s LFS objects from GitHub LFS to the',
        '# self-hosted server. Run from inside a fresh clone of the',
        '# repo — fetch all LFS objects from origin, then push them',
        '# to the team\'s LFS endpoint with an admin-minted JWT.',
        `# Project: ${safeName}`,
        `# Repo:    ${safeRepoUrl}`,
        '',
        '# 1. Fetch every LFS object from GitHub.',
        'git lfs fetch --all origin',
        '',
        '# 2. Push them to our LFS server, authenticating via the',
        '#    short-lived JWT below (~15 min lifetime; if it expires',
        '#    before the push completes, hit the Migrate LFS button',
        '#    again to get a fresh script).',
        `git -c "http.${lfsEndpoint}/.extraheader=Authorization: Bearer ${token}" \\`,
        `      lfs push --all "${lfsEndpoint}"`,
      ].join('\n')

      const powershellScript = [
        '# PowerShell variant of the migrate-LFS script.',
        `# Project: ${safeName}`,
        `# Repo:    ${safeRepoUrl}`,
        '',
        'git lfs fetch --all origin',
        `git -c "http.${lfsEndpoint}/.extraheader=Authorization: Bearer ${token}" lfs push --all "${lfsEndpoint}"`,
      ].join('\n')

      logAudit({
        actorId: req.member!.id,
        actorLabel: req.member!.displayName,
        action: 'project.migrate-lfs.script',
        target: `project:${id}`,
      })

      return {
        projectId: project.id,
        projectName: project.name,
        repoUrl: project.repoUrl,
        lfsEndpoint,
        tokenLifetimeMinutes: 15,
        scripts: {
          posix: posixScript,
          powershell: powershellScript,
        },
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
    const lfsUrl = effectiveLfsUrl()
    return {
      setupComplete: team.setupComplete === 1,
      teamInfoSet: team.name.trim().length > 0 && team.gitHubOrg.trim().length > 0,
      lfsConfigured: !!lfsUrl,
      lfsUrl,
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

  // Test reachability of the LFS server from the *team server's*
  // network position, not the browser's. The wizard previously did
  // a browser-side fetch, which fails for two reasons in any real
  // deployment: the URL is usually only reachable from the LAN where
  // the team server lives (not the admin's laptop), and Giftless
  // doesn't return CORS headers anyway. Server-side fetch is correct.
  app.post<{ Body: { url?: string } }>(
    '/api/admin/lfs/test',
    async (req, reply) => {
      const url = (req.body?.url ?? '').trim().replace(/\/+$/, '')
      if (!url) {
        return reply.code(400).send({ error: 'url is required' })
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        // Hit `<url>/objects/batch` with a minimal POST — Giftless
        // responds 400 (bad body) or 401 (no auth) when it's alive
        // and 5xx / network-error when it's not. We treat anything
        // < 500 as "reachable" because it proves the HTTP server is
        // there and serving the LFS protocol.
        const res = await fetch(`${url}/objects/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/vnd.git-lfs+json' },
          body: '{}',
          signal: controller.signal,
        })
        return {
          reachable: res.status < 500,
          status: res.status,
        }
      } catch (err) {
        return {
          reachable: false,
          error: (err as Error).message || 'Network error',
        }
      } finally {
        clearTimeout(timer)
      }
    },
  )

  // ── Team config ────────────────────────────────────────────────────

  app.patch<{ Body: {
    name?: string
    gitHubOrg?: string
    projectPrefix?: string
    welcomeMessage?: string
    lfsUrl?: string
  } }>('/api/admin/team', async (req, reply) => {
    const updates: string[] = []
    const values: string[] = []
    for (const field of [
      'name', 'gitHubOrg', 'projectPrefix', 'welcomeMessage', 'lfsUrl',
    ] as const) {
      if (typeof req.body?.[field] === 'string') {
        const raw = req.body[field]!.trim()
        if (field === 'lfsUrl') {
          // The lfsUrl flows into shell-script templates (the migrate-
          // LFS endpoint) and into clients' `git -c lfs.url=…` configs.
          // Both are injection-prone if the value contains whitespace,
          // quotes, or angle brackets. Validate strictly here so a
          // bad URL never reaches those downstream consumers.
          if (raw && !/^https?:\/\/[^\s"'<>`$]+$/.test(raw)) {
            return reply.code(400).send({
              error: 'LFS URL must be a plain http:// or https:// URL with no quotes, spaces, or shell metacharacters.',
            })
          }
          // Strip trailing slashes on lfsUrl so giftless's `/objects/...`
          // resolves correctly regardless of how the admin typed it.
          updates.push(`${field} = ?`)
          values.push(raw.replace(/\/+$/, ''))
        } else {
          updates.push(`${field} = ?`)
          values.push(raw)
        }
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

  // ── DESTRUCTIVE: reset the whole server ────────────────────────────
  //
  // Wipes every table (members, devices, projects, pins, audit, team
  // settings) and re-bootstraps a fresh setup PIN. Intended for
  // testing the first-launch flow repeatedly without manually
  // `docker compose down && rm -rf data && docker compose up`.
  //
  // We do NOT delete the LFS object store directory — that's
  // separate (and giftless writes there, not us). Operator deletes
  // it manually if they want a true clean slate.
  //
  // Triple-confirmation lives in the UI; here we just require the
  // caller to POST the literal string "RESET" as the `confirm` body
  // field. Belt-and-braces — the UI sends it, but if someone hand-
  // crafts a curl, they have to do it on purpose.
  app.post<{ Body: { confirm?: string } }>(
    '/api/admin/dev-reset',
    async (req, reply) => {
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
        db.prepare('DELETE FROM members').run()
        db.prepare('DELETE FROM projects').run()
        // Reset the singleton team row to defaults rather than
        // deleting it — migrate() seeds it on insert and we don't
        // want to re-trigger that path. Easier to UPDATE in place.
        db.prepare(
          `UPDATE team SET name = 'My Team', gitHubOrg = '', projectPrefix = '',
                            welcomeMessage = '', setupComplete = 0, updatedAt = ?
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

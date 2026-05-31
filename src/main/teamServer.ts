/**
 * Desktop-side client for the self-hosted team server (see `/server/`).
 *
 * Replaces the old `coordination.ts` (which cloned a GitHub repo and
 * managed members.json there). The team server speaks HTTP + JSON; we
 * keep a stale-while-revalidate snapshot of what it told us so the UI
 * works offline and so a quick role check doesn't pay a network
 * round-trip.
 *
 * Persistence: serverUrl + bearer token live in `framecad-app.json`
 * under `teamServer`. The team / members / projects / me snapshot is
 * cached only in memory and a one-shot disk file so a cold-boot still
 * has *something* to show before the first refresh lands.
 *
 * The renderer reads this through three thin IPC handlers
 * (`team-get-snapshot`, `team-refresh`, `team-enroll`, `team-sign-out`,
 * `team-admin-ui-url`); see `ipc.ts`. The local REST API on 42129
 * also reads from this module so the SolidWorks add-in's existing
 * `/api/coord-state` keeps working without add-in code changes.
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { app } from 'electron'
import type {
  EnrollResult,
  MyMember,
  ProjectEntry,
  TeamConfig,
  TeamMember,
  TeamPolicies,
  TeamSnapshot,
} from '@shared/types'
import { DEFAULT_TEAM_POLICIES } from '@shared/types'
import { getTeamServerSettings, setTeamServerSettings } from './config'

// ── In-memory state ─────────────────────────────────────────────────

interface InMemoryState {
  serverUrl: string | null
  token: string | null
  me: MyMember | null
  team: TeamConfig | null
  members: TeamMember[]
  projects: ProjectEntry[]
  lastSyncAt: number | null
  error: string | null
}

const state: InMemoryState = {
  serverUrl: null,
  token: null,
  me: null,
  team: null,
  members: [],
  projects: [],
  lastSyncAt: null,
  error: null,
}

// Listeners notified whenever the snapshot changes — used by the
// renderer (push subscription) and by REST so /api/coord-state can
// just read from `state` without polling.
type SnapshotListener = (snapshot: TeamSnapshot) => void
const listeners = new Set<SnapshotListener>()

function broadcast(): void {
  const snap = currentSnapshot()
  for (const l of listeners) {
    try { l(snap) } catch { /* noop */ }
  }
}

export function onSnapshot(cb: SnapshotListener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// ── Snapshot accessors ─────────────────────────────────────────────

export function currentSnapshot(): TeamSnapshot {
  return {
    enrolled: !!state.token && !!state.me,
    serverUrl: state.serverUrl,
    me: state.me,
    team: state.team,
    members: state.members,
    projects: state.projects,
    lastSyncAt: state.lastSyncAt,
    error: state.error,
  }
}

// ── Persistence ─────────────────────────────────────────────────────

function snapshotCachePath(): string {
  return path.join(app.getPath('userData'), 'team-snapshot.json')
}

/**
 * Load the persisted enrollment + last-known snapshot from disk.
 * Called once at app startup. Doesn't hit the network; the renderer
 * triggers a refresh after the window is up.
 */
export async function loadFromDisk(): Promise<void> {
  const stored = await getTeamServerSettings()
  if (stored?.serverUrl && stored.token) {
    state.serverUrl = stored.serverUrl
    state.token = stored.token
  }
  // Snapshot file is best-effort. It's an optimisation to show
  // members / projects before the first fetch, not a source of truth.
  try {
    const raw = await fs.readFile(snapshotCachePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TeamSnapshot>
    if (parsed.me) state.me = parsed.me
    if (parsed.team) state.team = parsed.team
    if (Array.isArray(parsed.members)) state.members = parsed.members
    if (Array.isArray(parsed.projects)) state.projects = parsed.projects
    if (typeof parsed.lastSyncAt === 'number') state.lastSyncAt = parsed.lastSyncAt
  } catch { /* no cache yet — first launch */ }
  broadcast()
}

async function persistSnapshot(): Promise<void> {
  try {
    await fs.writeFile(snapshotCachePath(), JSON.stringify(currentSnapshot()), 'utf-8')
  } catch { /* best-effort */ }
}

async function persistEnrollment(): Promise<void> {
  await setTeamServerSettings(
    state.serverUrl && state.token
      ? { serverUrl: state.serverUrl, token: state.token }
      : null,
  )
}

// ── HTTP helper ─────────────────────────────────────────────────────

async function fetchTeamApi<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  if (!state.serverUrl) throw new Error('Not enrolled with a team server')
  const url = state.serverUrl.replace(/\/+$/, '') + path
  const headers: Record<string, string> = {}
  if (state.token) headers.Authorization = `Bearer ${state.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  // Send our running version on every request so the team server can
  // surface outdated desktops in the admin UI. Free piggyback — the
  // server reads this in `requireDevice` and persists it on the
  // device row alongside lastSeenAt.
  headers['X-Client-Version'] = app.getVersion()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000)
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    })
    let data: unknown = null
    try { data = await res.json() } catch { /* may be empty / non-JSON */ }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : null) ?? `HTTP ${res.status}`
      const err = new Error(msg) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    return data as T
  } finally {
    clearTimeout(timeout)
  }
}

// ── Public surface ──────────────────────────────────────────────────

export async function enroll(args: {
  serverUrl: string
  pin: string
  deviceLabel?: string
  /** User-typed display name (step 2 of the wizard). Server falls
   *  back to the PIN's pre-baked name if this is empty. */
  displayName?: string
  /** GitHub login from the wizard's "Sign in to GitHub" step. Server
   *  falls back to the PIN's pre-baked githubUsername if empty. */
  githubUsername?: string
}): Promise<EnrollResult> {
  const cleanUrl = args.serverUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(cleanUrl)) {
    return { success: false, error: 'Server URL must start with http:// or https://' }
  }
  const cleanPin = args.pin.trim().toUpperCase()
  if (cleanPin.length !== 6) {
    return { success: false, error: 'PIN must be 6 characters' }
  }

  // Stash url first so fetchTeamApi can use it.
  const previous = { ...state }
  state.serverUrl = cleanUrl
  state.token = null
  try {
    const data = await fetchTeamApi<{
      token: string
      member: MyMember
      team: TeamConfig
    }>('/api/enroll', {
      method: 'POST',
      body: {
        pin: cleanPin,
        deviceLabel: args.deviceLabel?.trim() || undefined,
        displayName: args.displayName?.trim() || undefined,
        githubUsername: args.githubUsername?.trim() || undefined,
        clientVersion: app.getVersion(),
      },
    })
    state.token = data.token
    state.me = data.member
    state.team = data.team
    state.error = null
    await persistEnrollment()
    // Pull the rest of the snapshot so the welcome screen has the
    // project registry without a second user gesture.
    await refresh().catch(() => { /* enrollment itself was good */ })
    return { success: true, snapshot: currentSnapshot() }
  } catch (err) {
    // Roll back any partial state so a failed enroll doesn't leave
    // us pointing at the wrong URL with no token.
    state.serverUrl = previous.serverUrl
    state.token = previous.token
    state.me = previous.me
    state.team = previous.team
    state.members = previous.members
    state.projects = previous.projects
    state.lastSyncAt = previous.lastSyncAt
    return { success: false, error: (err as Error).message }
  }
}

export async function loginDevice(args: {
  serverUrl: string
  username: string
  password: string
  deviceLabel?: string
}): Promise<EnrollResult> {
  const cleanUrl = args.serverUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(cleanUrl)) {
    return { success: false, error: 'Server URL must start with http:// or https://' }
  }

  const previous = { ...state }
  state.serverUrl = cleanUrl
  state.token = null
  try {
    const data = await fetchTeamApi<{
      token: string
      member: MyMember
      team: TeamConfig
    }>('/api/login', {
      method: 'POST',
      body: {
        username: args.username.trim(),
        password: args.password,
        deviceLabel: args.deviceLabel?.trim() || undefined,
        kind: 'desktop',
        clientVersion: app.getVersion(),
      },
    })
    state.token = data.token
    state.me = data.member
    state.team = data.team
    state.error = null
    await persistEnrollment()
    await refresh().catch(() => {})
    return { success: true, snapshot: currentSnapshot() }
  } catch (err) {
    state.serverUrl = previous.serverUrl
    state.token = previous.token
    state.me = previous.me
    state.team = previous.team
    state.members = previous.members
    state.projects = previous.projects
    state.lastSyncAt = previous.lastSyncAt
    return { success: false, error: (err as Error).message }
  }
}

export async function refresh(): Promise<TeamSnapshot> {
  if (!state.token) {
    state.error = 'Not enrolled'
    return currentSnapshot()
  }
  try {
    // Fire the four reads in parallel; with the server on a LAN this
    // is ~50ms total instead of 200ms serial.
    const [me, team, members, projects] = await Promise.all([
      fetchTeamApi<{ member: MyMember }>('/api/me').then(d => d.member),
      fetchTeamApi<TeamConfig>('/api/team'),
      fetchTeamApi<{ members: TeamMember[] }>('/api/members').then(d => d.members),
      fetchTeamApi<{ projects: ProjectEntry[] }>('/api/projects').then(d => d.projects),
    ])
    // Legacy team servers (pre-caps) omit `capabilities`/`allowedProjectIds`/
    // `autoOpenProjectId`. Default to full access so existing deployments
    // keep working until the server is upgraded — fail-open is correct
    // here because the server is the source of truth for restrictions.
    state.me = {
      ...me,
      capabilities: me.capabilities ?? {
        createProject: true,
        browseTeamProjects: true,
        openProject: true,
        manufacturingView: true,
      },
      allowedProjectIds: me.allowedProjectIds ?? [],
      autoOpenProjectId: me.autoOpenProjectId ?? null,
      kioskMode: !!me.kioskMode,
    }
    state.team = team
    state.members = members
    state.projects = projects
    state.lastSyncAt = Date.now()
    state.error = null
    void persistSnapshot()
    broadcast()
  } catch (err) {
    const e = err as Error & { status?: number }
    // 401 means our token's no good — the admin probably revoked our
    // device. Clear EVERY snapshot field so the welcome screen flips
    // cleanly back to the enroll card instead of carrying stale
    // member / project data across the role transition for one render.
    if (e.status === 401) {
      state.token = null
      state.me = null
      state.team = null
      state.members = []
      state.projects = []
      state.lastSyncAt = null
      // Keep state.serverUrl so the enroll form can default to the
      // last server they used.
      void persistEnrollment()
      void fs.rm(snapshotCachePath(), { force: true })
      state.error = 'Your device was removed from the team. Re-enroll to continue.'
    } else {
      state.error = e.message
    }
    broadcast()
  }
  return currentSnapshot()
}

export async function signOut(): Promise<void> {
  // Best-effort: tell the server to revoke our device row before we
  // throw away the token locally. If the network's down or the server
  // already revoked us, swallow the error — the local sign-out has to
  // succeed either way. Done BEFORE clearing local state so we still
  // have the token to authenticate the DELETE.
  if (state.token && state.serverUrl) {
    try {
      await fetchTeamApi('/api/me/device', { method: 'DELETE', timeoutMs: 3000 })
    } catch { /* nothing actionable */ }
  }
  state.serverUrl = null
  state.token = null
  state.me = null
  state.team = null
  state.members = []
  state.projects = []
  state.lastSyncAt = null
  state.error = null
  await persistEnrollment()
  try { await fs.rm(snapshotCachePath(), { force: true }) } catch { /* ignore */ }
  broadcast()
}

export function adminUiUrl(): string | null {
  return state.serverUrl ? state.serverUrl.replace(/\/+$/, '') + '/#/sign-in' : null
}

/**
 * Return the team's tunable policies (file-size cap, blocked
 * extensions, LFS token TTL, grace window). Falls back to
 * DEFAULT_TEAM_POLICIES when:
 *   - the desktop isn't enrolled (standalone mode), or
 *   - the team server is on an older version that doesn't return
 *     a `policies` block in /api/team.
 *
 * Individual missing fields fall back per-field, so a partial
 * server response can't blank a single value into the default
 * (e.g. server returns just maxFileSizeMb → we still use the
 * defaults for the other four).
 */
export function getPolicies(): TeamPolicies {
  const p = state.team?.policies
  if (!p) return DEFAULT_TEAM_POLICIES
  return {
    maxFileSizeMb: p.maxFileSizeMb ?? DEFAULT_TEAM_POLICIES.maxFileSizeMb,
    lfsAutotrackThresholdMb:
      p.lfsAutotrackThresholdMb ?? DEFAULT_TEAM_POLICIES.lfsAutotrackThresholdMb,
    // Honor an explicit empty array — an admin may have intentionally
    // cleared the blocklist. Only fall back to defaults when the
    // field is missing entirely (older server response shape).
    blockedExtensions: Array.isArray(p.blockedExtensions)
      ? p.blockedExtensions
      : DEFAULT_TEAM_POLICIES.blockedExtensions,
    lfsTokenTtlMinutes: p.lfsTokenTtlMinutes ?? DEFAULT_TEAM_POLICIES.lfsTokenTtlMinutes,
    quotaGraceHours: p.quotaGraceHours ?? DEFAULT_TEAM_POLICIES.quotaGraceHours,
  }
}

/**
 * Cheap health probe of the team server. Hits `/api/health` (an
 * unauthenticated GET that doesn't read the DB) with a short timeout
 * so the renderer can render a "team server reachable" status dot
 * without blocking on a slow network. Returns:
 *   - 'reachable'    : got HTTP 200 from /api/health
 *   - 'unreachable'  : connection refused, DNS fail, timeout, non-2xx
 *   - 'not-enrolled' : no server URL stored — the dot should be hidden
 */
export async function pingTeamServer(): Promise<'reachable' | 'unreachable' | 'not-enrolled'> {
  if (!state.serverUrl) return 'not-enrolled'
  const url = state.serverUrl.replace(/\/+$/, '') + '/api/health'
  const controller = new AbortController()
  // 4s is short enough that a hung server doesn't make the status dot
  // feel laggy, long enough to forgive a school WiFi handshake.
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    return res.ok ? 'reachable' : 'unreachable'
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

// ── LFS helpers ─────────────────────────────────────────────────────

/**
 * Look up which team-registered project corresponds to a given
 * GitHub remote URL. Returns null if either we're not enrolled, the
 * remote isn't on the snapshot, or the team server hasn't told us an
 * LFS URL (in which case we leave .lfsconfig alone and the project
 * falls back to GitHub LFS).
 *
 * Normalisation aims to make any equivalent way of pointing at the
 * same GitHub repo compare equal:
 *   - `https://github.com/Org/Repo.git`
 *   - `https://github.com/org/repo`
 *   - `http://github.com/org/repo/`
 *   - `https://x-access-token:TOKEN@github.com/org/repo.git`
 *   - `git@github.com:org/repo.git`  (ssh form)
 *
 * If a registered repo can't be matched against the actual git
 * remote URL the working tree has, the publish guard incorrectly
 * concludes the project is unregistered and either refuses the
 * push or routes LFS objects to GitHub — exactly the failure mode
 * the routing logic exists to prevent. So this needs to be liberal.
 */
export function lookupProjectByRemote(
  remote: string,
): { projectId: number; lfsUrl: string } | null {
  if (!state.team?.lfsUrl) return null
  const norm = (s: string): string => {
    let t = s.trim()
    // Convert `git@host:owner/repo` → `https://host/owner/repo` so
    // SSH-style remotes match HTTPS-stored projects.
    const ssh = t.match(/^git@([^:]+):(.+)$/i)
    if (ssh) t = `https://${ssh[1]}/${ssh[2]}`
    // Strip any embedded user-info (`https://x-access-token:TKN@host/...`)
    t = t.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
    // Normalise scheme to lowercase + drop trailing `.git` + slashes.
    t = t.replace(/^https?:\/\//i, m => m.toLowerCase())
    t = t.replace(/\.git$/i, '')
    t = t.replace(/\/+$/, '')
    return t.toLowerCase()
  }
  const want = norm(remote)
  const match = state.projects.find(p => norm(p.repoUrl) === want)
  if (!match) return null
  return { projectId: match.id, lfsUrl: state.team.lfsUrl }
}

/**
 * Mint a fresh short-lived JWT for talking to the LFS server about
 * this project. The desktop calls this immediately before every
 * `git lfs ...` invocation; 15-minute TTL is plenty for one push,
 * and re-minting per-op means a quota change on the server takes
 * effect on the next operation (no stale "writable" tokens).
 *
 * Returns null if LFS isn't configured (the team server returned
 * 503 or the snapshot has no lfsUrl). Callers fall back to GitHub
 * LFS in that case — the existing flows still work.
 */
export async function getLfsToken(projectId: number): Promise<{
  token: string
  url: string
  writable: boolean
  quota: {
    used: number
    limit: number | null
    grace?: 'ok' | 'in-grace' | 'expired'
    graceStartedAt?: number | null
  }
} | null> {
  if (!state.token || !state.team?.lfsUrl) return null
  try {
    return await fetchTeamApi<{
      token: string
      url: string
      writable: boolean
      quota: {
        used: number
        limit: number | null
        grace?: 'ok' | 'in-grace' | 'expired'
        graceStartedAt?: number | null
      }
    }>('/api/lfs/token', {
      method: 'POST',
      body: { projectId },
      timeoutMs: 6000,
    })
  } catch {
    return null
  }
}

// ── Drive-backend locks ─────────────────────────────────────────────
// Check-out/check-in for Google Drive projects lives on the team
// server (Drive has no `git lfs lock` equivalent). `projectKey` is the
// Drive folder id; the desktop reads it from the project's
// drive-manifest.json. See server migration v15 + client.ts.

export interface DriveLock {
  filePath: string
  ownerMemberId: number
  ownerName: string
  lockedAt: number
}

/** All active locks for a Drive project. Empty when not enrolled. */
export async function listDriveLocks(projectKey: string): Promise<DriveLock[]> {
  if (!state.token) return []
  const data = await fetchTeamApi<{ locks: DriveLock[] }>(
    `/api/projects/${encodeURIComponent(projectKey)}/locks`,
    { timeoutMs: 6000 },
  )
  return data.locks ?? []
}

/** Acquire a lock (check out). Throws with the holder's name on 409. */
export async function acquireDriveLock(projectKey: string, filePath: string): Promise<void> {
  await fetchTeamApi(
    `/api/projects/${encodeURIComponent(projectKey)}/locks`,
    { method: 'POST', body: { filePath }, timeoutMs: 6000 },
  )
}

/** Release a lock (check in). `force` lets a mentor/admin break someone
 *  else's lock; the server enforces who's allowed to. */
export async function releaseDriveLock(
  projectKey: string,
  filePath: string,
  force = false,
): Promise<void> {
  await fetchTeamApi(
    `/api/projects/${encodeURIComponent(projectKey)}/locks`,
    { method: 'DELETE', body: { filePath, force }, timeoutMs: 6000 },
  )
}

/**
 * Desktop-side client for the self-hosted team server (see `/server/`).
 *
 * The team server speaks HTTP + JSON; we
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
  /** True after the server revoked this device (a 401 on refresh) — distinct
   *  from "never enrolled". The renderer must NOT grant standalone-admin to a
   *  revoked device (otherwise a removed student flips to full admin UI). */
  revoked: boolean
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
  revoked: false,
}

// Bumped whenever enrollment identity changes. In-flight refreshes capture the
// value and drop their result if sign-out/re-login happened before they finish.
let stateGeneration = 0

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
    revoked: state.revoked,
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
  stateGeneration += 1
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
    // A successful enroll IS proof the device is welcome again — don't leave
    // the revoked flag (from a prior 401) set when the follow-up refresh
    // fails transiently, or the renderer keeps gating a legitimate device.
    state.revoked = false
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
  stateGeneration += 1
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
    state.revoked = false // fresh login — mirror the enroll success path
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

/**
 * Keep the team display name synced with the signed-in Google account, so all
 * attribution (comments, releases, publishes, drawing title blocks, lock owner)
 * reflects who's actually signed in — not a free-typed enroll-time nickname.
 * Best-effort: runs after every refresh, only acts on a mismatch, and retries
 * on the next refresh if the server is briefly unreachable. Lazy-imports
 * google-auth to avoid a load-order cycle.
 */
async function syncDisplayNameFromGoogle(): Promise<void> {
  try {
    if (!state.token || !state.me) return
    const ga = await import('./google-auth')
    const status = await ga.googleAuthStatus()
    if (!status.signedIn) return
    const googleName = (status.name || status.email || '').trim()
    if (!googleName || state.me.displayName === googleName) return
    await fetchTeamApi('/api/me/display-name', {
      method: 'PATCH',
      body: { displayName: googleName },
      timeoutMs: 6000,
    })
    state.me.displayName = googleName
    broadcast()
  } catch { /* best-effort; the next refresh retries */ }
}

export async function refresh(): Promise<TeamSnapshot> {
  const tokenAtStart = state.token
  const generationAtStart = stateGeneration
  if (!tokenAtStart) {
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
    if (state.token !== tokenAtStart || stateGeneration !== generationAtStart) {
      return currentSnapshot()
    }
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
        manageCadStructure: true,
        forceCheckIn: true,
      },
      allowedProjectIds: me.allowedProjectIds ?? [],
      autoOpenProjectId: me.autoOpenProjectId ?? null,
      kioskMode: !!me.kioskMode,
      // FAIL-SAFE: unlike the caps above (fail-open for legacy servers), a
      // missing archiveMode must NEVER turn an ordinary client into a
      // read-only mirror. Default false; only an explicit true flips it.
      archiveMode: !!me.archiveMode,
    }
    state.team = team
    state.members = members
    state.projects = projects
    state.lastSyncAt = Date.now()
    state.error = null
    state.revoked = false // a successful refresh means our token is good again
    void persistSnapshot()
    broadcast()
    // Keep the team display name synced with the signed-in Google account.
    void syncDisplayNameFromGoogle()
  } catch (err) {
    if (state.token !== tokenAtStart || stateGeneration !== generationAtStart) {
      return currentSnapshot()
    }
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
      state.revoked = true // don't let the renderer grant standalone-admin

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
  stateGeneration += 1
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
 * extensions, grace window). Falls back to DEFAULT_TEAM_POLICIES when:
 *   - the desktop isn't enrolled (standalone mode), or
 *   - the team server is on an older version that doesn't return
 *     a `policies` block in /api/team.
 *
 * Individual missing fields fall back per-field, so a partial
 * server response can't blank a single value into the default
 * (e.g. server returns just maxFileSizeMb → we still use the
 * defaults for the rest).
 */
export function getPolicies(): TeamPolicies {
  const p = state.team?.policies
  if (!p) return DEFAULT_TEAM_POLICIES
  return {
    maxFileSizeMb: p.maxFileSizeMb ?? DEFAULT_TEAM_POLICIES.maxFileSizeMb,
    // Honor an explicit empty array — an admin may have intentionally
    // cleared the blocklist. Only fall back to defaults when the
    // field is missing entirely (older server response shape).
    blockedExtensions: Array.isArray(p.blockedExtensions)
      ? p.blockedExtensions
      : DEFAULT_TEAM_POLICIES.blockedExtensions,
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

// ── Drive-backend locks ─────────────────────────────────────────────
// Check-out/check-in for Google Drive projects lives on the team
// server. `projectKey` is the
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

/**
 * Claim a part number from the team server so two clients can't take the
 * same one. Returns `{ ok:true }` when the number is now reserved for this
 * file, or `{ ok:false, reassigned:true, nextCounter }` on a collision so the
 * caller can format the next candidate and re-claim. THROWS when not enrolled
 * or the server is unreachable — the caller treats that as "work offline" and
 * keeps a provisional number to reconcile later.
 */
export async function claimPartNumber(
  projectKey: string,
  body: { partNumber: string; scope: string; counter: number; filePath?: string },
): Promise<{ ok: boolean; reassigned: boolean; nextCounter?: number }> {
  if (!state.token) throw new Error('Not enrolled with a team server')
  return await fetchTeamApi(
    `/api/projects/${encodeURIComponent(projectKey)}/part-numbers/claim`,
    { method: 'POST', body, timeoutMs: 6000 },
  )
}

/**
 * Submit an in-app problem report to the team server (it lands in the admin
 * Reports page + optionally a chat webhook). The app version rides along
 * automatically as the X-Client-Version
 * header. Throws on a network/server error; returns a friendly message when the
 * device isn't enrolled (reporting needs a team server to send to).
 */
export async function reportIssue(
  message: string,
  platform: string,
): Promise<{ success: boolean; id?: number; error?: string }> {
  if (!state.token) {
    return { success: false, error: 'Enroll with your team server first — then the Report button can send this to your admin.' }
  }
  const data = await fetchTeamApi<{ ok: boolean; id: number }>(
    '/api/issues',
    { method: 'POST', body: { message, platform }, timeoutMs: 8000 },
  )
  return { success: true, id: data.id }
}

// --- Drive publish history (replaces `git log` for Drive projects) ---

/** One publish event from the team server, shaped like a HistoryEntry. */
export interface DrivePublishEntry {
  hash: string
  message: string
  author: string
  date: string
  files: string[]
}

/** Recent publishes for a Drive project, newest first. Empty when not
 *  enrolled or the server is unreachable (History just shows nothing). */
export async function listDrivePublishHistory(
  projectKey: string,
  limit = 100,
): Promise<DrivePublishEntry[]> {
  if (!state.token) return []
  const data = await fetchTeamApi<{ entries: DrivePublishEntry[] }>(
    `/api/projects/${encodeURIComponent(projectKey)}/history?limit=${limit}`,
    { timeoutMs: 6000 },
  )
  return data.entries ?? []
}

// The publish dialogs (desktop Toolbar + SolidWorks add-in) promise "leave
// blank for a random label" — this is where that label is minted, so both
// surfaces get it from the one chokepoint that records history.
const LABEL_ADJECTIVES = ['swift', 'bold', 'tidy', 'brave', 'calm', 'keen', 'spry', 'deft', 'sly', 'zesty', 'noble', 'merry', 'lucid', 'sturdy', 'quick']
const LABEL_NOUNS = ['falcon', 'gearbox', 'piston', 'bracket', 'sprocket', 'chassis', 'rivet', 'flange', 'camshaft', 'spindle', 'gusset', 'bearing', 'pulley', 'truss', 'anvil']
function randomPublishLabel(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]
  return `${pick(LABEL_ADJECTIVES)}-${pick(LABEL_NOUNS)}-${Math.floor(Math.random() * 900 + 100)}`
}

/** Record a publish so it shows in History. Best effort — a failure here
 *  must never fail the publish itself, so callers ignore rejections. */
export async function recordDrivePublish(
  projectKey: string,
  message: string,
  files: string[],
): Promise<void> {
  if (!state.token) return
  const label = message.trim() || randomPublishLabel()
  await fetchTeamApi(
    `/api/projects/${encodeURIComponent(projectKey)}/history`,
    { method: 'POST', body: { message: label, files }, timeoutMs: 6000 },
  )
}

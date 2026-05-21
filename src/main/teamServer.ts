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
  ProjectEntry,
  TeamConfig,
  TeamMember,
  TeamSnapshot,
} from '@shared/types'
import { getTeamServerSettings, setTeamServerSettings } from './config'

// ── In-memory state ─────────────────────────────────────────────────

interface InMemoryState {
  serverUrl: string | null
  token: string | null
  me: TeamMember | null
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
      member: TeamMember
      team: TeamConfig
    }>('/api/enroll', {
      method: 'POST',
      body: {
        pin: cleanPin,
        deviceLabel: args.deviceLabel?.trim() || undefined,
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

export async function refresh(): Promise<TeamSnapshot> {
  if (!state.token) {
    state.error = 'Not enrolled'
    return currentSnapshot()
  }
  try {
    // Fire the four reads in parallel; with the server on a LAN this
    // is ~50ms total instead of 200ms serial.
    const [me, team, members, projects] = await Promise.all([
      fetchTeamApi<{ member: TeamMember }>('/api/me').then(d => d.member),
      fetchTeamApi<TeamConfig>('/api/team'),
      fetchTeamApi<{ members: TeamMember[] }>('/api/members').then(d => d.members),
      fetchTeamApi<{ projects: ProjectEntry[] }>('/api/projects').then(d => d.projects),
    ])
    state.me = me
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

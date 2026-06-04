/**
 * Archive mode — turn this machine into a read-only local mirror.
 *
 * When the team server enrolls a device with the `archiveMode` flag, the
 * desktop never opens a project for editing. Instead this module keeps a
 * local copy of every project on the member's allowlist (whatever the team
 * snapshot hands back) continuously up to date, and the device can never
 * upload — publish + check-out are blocked client- and server-side.
 *
 * It is deliberately independent of the single open-project flow in
 * `drive-project.ts`: it drives the directory-parameterized Drive engine
 * primitives (`downloadProject` / `syncRemote`) against one mirror dir per
 * project, so it can mirror many projects at once without ever touching the
 * "current" open project.
 *
 * Update detection is cheap: poll each project's publish history (limit=1)
 * and only run a sync when the newest publish id changes. A periodic full
 * safety sync catches direct-to-Drive edits that were never recorded in the
 * server's publish log.
 */
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ArchiveProjectStatus, ArchiveStatus, ProjectEntry } from '@shared/types'
import { downloadProject, syncRemote } from './drive'
import { loadManifest } from './drive-manifest'
import { currentSnapshot, listDrivePublishHistory, refresh as refreshTeam } from './teamServer'
import { getArchiveRoot } from './config'

// Poll cadence for the "did anyone publish?" check. Kept under the 5-minute
// mark so a freshly-published change lands on the mirror quickly.
const POLL_MS = 60_000
// Force a full sync of each project at least this often, regardless of the
// publish log — catches edits made straight to Drive (no publish recorded).
const FULL_SYNC_MS = 60 * 60_000
// Don't flood the renderer with a push on every byte of progress.
const BROADCAST_THROTTLE_MS = 500

let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let ticking = false
let getWin: (() => BrowserWindow | null) | null = null
let archiveRoot = ''
let lastTickAt: number | null = null
let lastBroadcastAt = 0

const statuses = new Map<string, ArchiveProjectStatus>()
/** Newest publish id we've already mirrored, per project key. */
const lastSeenHash = new Map<string, string>()
/** When we last ran a full safety sync, per project key. */
const lastFullSyncAt = new Map<string, number>()

/** Project-name → filesystem-safe folder leaf. The Drive folder id is
 *  appended by the caller so two same-named projects never collide. */
function sanitize(name: string): string {
  return (name || 'project')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'project'
}

function mirrorDir(p: ProjectEntry): string {
  return path.join(archiveRoot, `${sanitize(p.name)}-${p.driveFolderId}`)
}

function ensureStatus(p: ProjectEntry): ArchiveProjectStatus {
  const key = p.driveFolderId!
  let st = statuses.get(key)
  if (!st) {
    st = {
      projectKey: key,
      name: p.name,
      localPath: mirrorDir(p),
      state: 'pending',
      lastSyncAt: null,
      fileCount: 0,
      percent: 0,
      lastError: null,
    }
    statuses.set(key, st)
  } else {
    // Keep the display name + path fresh if the project was renamed.
    st.name = p.name
    st.localPath = mirrorDir(p)
  }
  return st
}

export function getStatus(): ArchiveStatus {
  return {
    active: running,
    archiveRoot,
    lastTickAt,
    projects: [...statuses.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function broadcast(force = false): void {
  const now = Date.now()
  if (!force && now - lastBroadcastAt < BROADCAST_THROTTLE_MS) return
  lastBroadcastAt = now
  const win = getWin?.()
  if (win && !win.isDestroyed()) win.webContents.send('archive-status', getStatus())
}

/** Start (or restart) the mirror loop. Idempotent: re-calling while running
 *  just refreshes the window accessor and re-resolves the archive root. */
export async function start(getMainWindow: () => BrowserWindow | null): Promise<void> {
  getWin = getMainWindow
  archiveRoot = await getArchiveRoot()
  if (running) { broadcast(true); return }
  running = true
  broadcast(true)
  void tick()
}

export function stop(): void {
  running = false
  if (timer) { clearTimeout(timer); timer = null }
  broadcast(true)
}

/** Relocate the archive root and re-run from the new location. Existing
 *  mirrors at the old root are left in place (the admin can delete them). */
export async function restartWithRoot(getMainWindow: () => BrowserWindow | null): Promise<void> {
  stop()
  statuses.clear()
  lastSeenHash.clear()
  lastFullSyncAt.clear()
  await start(getMainWindow)
}

/** Force an immediate poll/sync pass (the "Sync now" button). */
export async function syncNow(): Promise<void> {
  if (!running) return
  await tick(true)
}

function schedule(): void {
  if (!running) return
  timer = setTimeout(() => void tick(), POLL_MS)
}

async function tick(immediate = false): Promise<void> {
  if (!running) return
  if (ticking) return // a pass is already in flight; the timer will catch up
  ticking = true
  if (timer) { clearTimeout(timer); timer = null }
  try {
    // Pull a fresh team snapshot first so the mirror tracks newly-assigned
    // projects, allowlist edits, and — importantly — an admin turning the
    // archive flag back OFF (which broadcasts → stop() via the ipc snapshot
    // hook). Best-effort: offline just falls back to the cached snapshot.
    try { await refreshTeam() } catch { /* offline — use cached snapshot */ }
    if (!running) return // a refresh may have cleared the archive flag

    lastTickAt = Date.now()
    const snap = currentSnapshot()
    const projects = (snap.projects ?? []).filter(
      (p): p is ProjectEntry & { driveFolderId: string } => !!p.driveFolderId,
    )
    // Drop status rows for projects that left the allowlist.
    const live = new Set(projects.map(p => p.driveFolderId))
    for (const k of [...statuses.keys()]) if (!live.has(k)) statuses.delete(k)
    for (const p of projects) ensureStatus(p)
    broadcast(true)

    // Serialize: one project at a time bounds Drive concurrency and keeps
    // the status readout legible.
    for (const p of projects) {
      if (!running) break
      await syncOne(p, immediate)
    }
  } catch {
    // Never let the loop die — the next tick retries.
  } finally {
    ticking = false
    broadcast(true)
    schedule()
  }
}

async function syncOne(
  p: ProjectEntry & { driveFolderId: string },
  immediate: boolean,
): Promise<void> {
  const key = p.driveFolderId
  const st = ensureStatus(p)
  const dir = st.localPath

  let firstTime = false
  try {
    firstTime = (await loadManifest(dir)) === null
  } catch {
    firstTime = true
  }

  // Decide whether a sync is warranted.
  let needsSync = firstTime
  if (!firstTime) {
    try {
      const hist = await listDrivePublishHistory(key, 1)
      const top = hist[0]?.hash ?? ''
      if (top && lastSeenHash.get(key) !== top) needsSync = true
    } catch {
      // Offline / server unreachable — skip the cheap check; the periodic
      // full sync below still eventually refreshes.
    }
    const sinceFull = Date.now() - (lastFullSyncAt.get(key) ?? 0)
    if (immediate || sinceFull > FULL_SYNC_MS) needsSync = true
  }

  if (!needsSync) {
    if (st.state === 'pending') st.state = 'idle'
    return
  }

  // First-time downloads need the Shared Drive id from the project entry —
  // the local manifest that would otherwise carry it doesn't exist yet.
  if (firstTime && !p.sharedDriveId) {
    st.state = 'error'
    st.lastError =
      'The team server didn’t provide a Shared Drive id for this project. Upgrade the server, then retry.'
    return
  }

  st.state = 'syncing'
  st.percent = 0
  st.lastError = null
  broadcast(true)

  try {
    if (firstTime) {
      await downloadProject(key, p.sharedDriveId!, dir, prog => {
        st.percent = prog.percent
        broadcast()
      })
    } else {
      // lockedByMe omitted: an archive box never holds a check-out lock, so
      // the rename-reconcile has nothing to protect.
      await syncRemote(dir, prog => {
        st.percent = prog.percent
        broadcast()
      })
    }

    // Refresh derived fields from the manifest the sync just wrote.
    try {
      const m = await loadManifest(dir)
      if (m) st.fileCount = Object.keys(m.files).length
    } catch { /* leave the previous count */ }
    st.lastSyncAt = Date.now()
    st.percent = 100
    st.state = 'idle'
    lastFullSyncAt.set(key, Date.now())

    // Remember the newest publish id so the cheap check can short-circuit
    // until the next publish.
    try {
      const hist = await listDrivePublishHistory(key, 1)
      lastSeenHash.set(key, hist[0]?.hash ?? '')
    } catch { /* leave it; next tick retries */ }
  } catch (err) {
    st.state = 'error'
    st.lastError = (err as Error).message
  } finally {
    broadcast(true)
  }
}

/**
 * Global "is the app talking to its main process right now" tracker.
 *
 * Wraps every method on `window.api` so each invocation increments a
 * pending counter on entry and decrements on settle. UI components can
 * subscribe to the counter to render an always-visible activity bar /
 * status text — so a long clone, sync, or publish never looks like a
 * freeze, and a quick getStatus() doesn't flicker the bar.
 *
 * Design choices:
 *
 * - **Grace period.** Calls that finish in under 300 ms never set the
 *   "busy" flag. Most reads (getStatus, getRecentProjects, getThumbnail)
 *   complete well under that — without the delay the indicator would
 *   flash every few seconds for no useful signal.
 *
 * - **Skip event subscriptions.** Methods whose names start with `on…`
 *   (onFileChange, onPublishProgress, etc.) register listeners that
 *   never settle; wrapping them as if they were normal IPC calls
 *   would leak "busy" forever.
 *
 * - **Friendly labels.** Each tracked op gets a human-readable name so
 *   the status bar can say "Publishing…" instead of "publish". Anything
 *   we haven't bothered to label falls back to "Working…".
 *
 * - **Wrap once.** wrapWindowApi() is idempotent (sets a sentinel flag
 *   on the api object) — safe to call from main.tsx and from any
 *   defensive re-init that might happen during a hot reload.
 */

type BusyState = {
  busy: boolean
  /** Human-friendly label for the longest-running tracked op, or null when idle. */
  label: string | null
  /** Raw count of in-flight calls — exposed for debugging. */
  count: number
}

type Listener = (state: BusyState) => void

const FRIENDLY_LABELS: Record<string, string> = {
  joinProject: 'Cloning project',
  createProject: 'Creating project',
  openProject: 'Opening project',
  closeProject: 'Closing project',
  sync: 'Syncing',
  publish: 'Publishing',
  checkOut: 'Checking out',
  checkIn: 'Checking in',
  forceCheckIn: 'Releasing lock',
  createNewPart: 'Creating part',
  createNewAssembly: 'Creating assembly',
  createSubsystem: 'Creating subsystem',
  generateDocument: 'Generating document',
  scanLargeFiles: 'Scanning files',
  checkManifestIntegrity: 'Checking manifest',
  renormalizeAll: 'Re-normalizing files',
  teamEnroll: 'Enrolling with team server',
  teamLoginDevice: 'Signing in to team server',
  teamRefresh: 'Syncing team info',
  teamSignOut: 'Signing out of team server',
  teamPingServer: 'Checking team server',
  syncCots: 'Syncing COTS library',
  triggerBatchExport: 'Queuing exports',
  bulkUpdateMeta: 'Saving changes',
  gitResetup: 'Re-initialising git',
  resetAllAppState: 'Resetting',
  createProgressTag: 'Tagging',
}

const GRACE_MS = 300

// Tracks each in-flight call's friendly label so we can surface the
// *active* op's name rather than the most recently started one when
// multiple overlap (common when a click triggers a chain of reads).
const inFlight = new Map<symbol, string>()

const listeners = new Set<Listener>()
let graceTimer: number | null = null
let visible = false

function currentState(): BusyState {
  // Pick the label most likely to matter to the user — the first
  // tracked op (oldest in-flight). If nothing is tracked but we still
  // have generic in-flight calls, fall back to a generic label.
  const labels = Array.from(inFlight.values())
  const label = labels.find(l => l && l !== 'Working…') ?? labels[0] ?? null
  return {
    busy: visible,
    label: visible ? label ?? 'Working…' : null,
    count: inFlight.size,
  }
}

function notify(): void {
  const state = currentState()
  for (const l of listeners) {
    try { l(state) } catch { /* listener bugs shouldn't break the rest */ }
  }
}

function startOp(label: string): symbol {
  const id = Symbol(label)
  inFlight.set(id, label)
  // Only schedule the visibility flip on the first concurrent op —
  // subsequent ones just add their label.
  if (inFlight.size === 1 && !visible) {
    graceTimer = window.setTimeout(() => {
      graceTimer = null
      if (inFlight.size > 0) {
        visible = true
        notify()
      }
    }, GRACE_MS)
  }
  return id
}

function endOp(id: symbol): void {
  inFlight.delete(id)
  if (inFlight.size === 0) {
    if (graceTimer !== null) {
      window.clearTimeout(graceTimer)
      graceTimer = null
    }
    if (visible) {
      visible = false
      notify()
    }
  } else if (visible) {
    // Label might have changed (oldest op completed) — refresh.
    notify()
  }
}

export function onApiBusy(cb: Listener): () => void {
  listeners.add(cb)
  cb(currentState())
  return () => { listeners.delete(cb) }
}

export function wrapWindowApi(): void {
  const win = window as unknown as { api?: Record<string, unknown> & { __busyWrapped?: boolean } }
  const api = win.api
  if (!api || api.__busyWrapped) return
  for (const key of Object.keys(api)) {
    // `on*` returns the unsubscribe function and never settles. Don't
    // wrap or we'd leak a busy slot for the lifetime of the listener.
    if (key.startsWith('on')) continue
    const orig = api[key]
    if (typeof orig !== 'function') continue
    const label = FRIENDLY_LABELS[key] ?? 'Working…'
    ;(api as Record<string, unknown>)[key] = function (...args: unknown[]) {
      const opId = startOp(label)
      let result: unknown
      try {
        result = (orig as (...a: unknown[]) => unknown).apply(api, args)
      } catch (sync) {
        endOp(opId)
        throw sync
      }
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).finally(() => endOp(opId))
      }
      endOp(opId)
      return result
    }
  }
  api.__busyWrapped = true
}

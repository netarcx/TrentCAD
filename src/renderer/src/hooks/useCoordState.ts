import { useEffect, useState } from 'react'
import type { CoordinationState } from '@shared/types'

/**
 * Singleton cache + stale-while-revalidate fetcher for the coordination
 * repo state. Replaces the previous pattern where every settings panel
 * (Members, Projects, TeamSettings) called `syncCoordinationRepo()` on
 * its own mount — that triggered a `git fetch && git pull` every time
 * the user clicked a tab, which is slow even when nothing has changed
 * upstream.
 *
 * Semantics:
 *
 * - **First read**: if the cache is empty, fetches synchronously
 *   (heavy `syncCoordinationRepo` so we know the data is fresh).
 * - **Subsequent reads**: serve the cached value immediately. If the
 *   cache is older than {@link STALE_AFTER_MS}, kick off a background
 *   sync so the next render gets fresh data, but don't block the UI.
 * - **Mutations**: every write helper here invalidates the cache and
 *   triggers a forced re-sync, so the next read reflects the change.
 *
 * The cache is intentionally module-scoped (lives across component
 * mounts and unmounts) — that's the whole point. It's reset on
 * `disconnectCoordinationRepo` and on app-state factory reset.
 */

type Listener = (state: CoordinationState | null) => void

const STALE_AFTER_MS = 30_000

let cache: CoordinationState | null = null
let lastSyncAt = 0
let pendingFetch: Promise<CoordinationState> | null = null
const listeners = new Set<Listener>()

function broadcast(state: CoordinationState | null): void {
  for (const l of listeners) {
    try { l(state) } catch { /* listener bugs shouldn't break the rest */ }
  }
}

/**
 * Forces a fresh sync against the remote. Returns the new state.
 * Multiple concurrent calls share the same in-flight promise so we
 * never issue overlapping `git pull`s.
 */
export async function forceRefreshCoordState(): Promise<CoordinationState> {
  if (pendingFetch) return pendingFetch
  pendingFetch = window.api.syncCoordinationRepo()
    .then(state => {
      cache = state
      lastSyncAt = Date.now()
      broadcast(state)
      return state
    })
    .finally(() => { pendingFetch = null })
  return pendingFetch
}

/**
 * Cheap read — uses the cached state directly. Falls back to a
 * lightweight `getCoordinationState` (which reads the LOCAL clone
 * without fetching from origin) if cache is cold. Use this when a
 * mutation has just succeeded and you want the new local state
 * reflected without paying for a full network sync.
 */
export async function readCachedCoordState(): Promise<CoordinationState> {
  if (cache) return cache
  if (pendingFetch) return pendingFetch
  const state = await window.api.getCoordinationState()
  cache = state
  lastSyncAt = Date.now()
  broadcast(state)
  return state
}

/**
 * Drop the cache. Called from the App-level disconnect handler so the
 * next read forces a fresh fetch instead of serving stale data from a
 * repo we're no longer connected to.
 */
export function invalidateCoordState(): void {
  cache = null
  lastSyncAt = 0
  broadcast(null)
}

/**
 * React hook for components that want to render the coordination state.
 *
 * - First mount with empty cache: kicks off a sync; `loading` is true
 *   until it returns.
 * - First mount with fresh cache: returns immediately with `loading=false`.
 * - First mount with stale cache: returns cached data immediately, then
 *   refreshes in the background. UI shows cached values without flicker;
 *   `loading` stays false unless the user explicitly forces a refresh.
 *
 * Components that mutate the team (approve / add / remove / etc.) should
 * await {@link forceRefreshCoordState} after the IPC succeeds so every
 * mounted consumer re-renders with the new data.
 */
export function useCoordState(): {
  state: CoordinationState | null
  loading: boolean
  refresh: () => Promise<CoordinationState>
} {
  const [state, setState] = useState<CoordinationState | null>(cache)
  const [loading, setLoading] = useState(cache === null && pendingFetch === null)

  useEffect(() => {
    listeners.add(setState)

    if (cache === null) {
      // Cold cache: must wait for the sync.
      setLoading(true)
      forceRefreshCoordState()
        .catch(() => { /* keep cache=null; component shows empty state */ })
        .finally(() => setLoading(false))
    } else if (Date.now() - lastSyncAt > STALE_AFTER_MS) {
      // Stale-while-revalidate: render cached now, refresh quietly.
      // Don't flip `loading` — the user sees data instantly.
      forceRefreshCoordState().catch(() => { /* background failure is non-fatal */ })
    }

    return () => { listeners.delete(setState) }
  }, [])

  return {
    state,
    loading,
    refresh: () => {
      setLoading(true)
      return forceRefreshCoordState().finally(() => setLoading(false))
    },
  }
}

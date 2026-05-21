import { useEffect, useState } from 'react'
import type { TeamSnapshot } from '@shared/types'

/**
 * Renderer-side accessor for the cached team-server snapshot.
 *
 * Subscribes to push notifications from the main process (`team-snapshot`)
 * so any successful refresh that happens elsewhere (background timer,
 * post-enrollment auto-pull, REST handler in another window) updates
 * every mounted consumer immediately. No periodic polling required.
 *
 * Hook returns:
 *   - `snapshot` — current cached state from main; null while the
 *     initial async fetch is in flight (typically <50ms).
 *   - `refresh()` — force the main process to re-fetch from the server.
 *   - `signOut()` — drop the local token + cache; flips `enrolled` to
 *     false synchronously through the next snapshot push.
 */
export function useTeam(): {
  snapshot: TeamSnapshot | null
  refresh: () => Promise<void>
  signOut: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    // Prime with whatever the cache currently holds.
    window.api.teamGetSnapshot()
      .then(snap => { if (!cancelled) setSnapshot(snap) })
      .catch(() => { /* main process not ready yet — push will catch up */ })

    // Stay subscribed to future updates.
    const unsubscribe = window.api.onTeamSnapshot(snap => {
      if (!cancelled) setSnapshot(snap)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return {
    snapshot,
    refresh: async () => { await window.api.teamRefresh() },
    signOut: async () => { await window.api.teamSignOut() },
  }
}

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
 * Three boolean states callers care about:
 *
 *   - `loading=true`   → IPC priming hasn't returned yet. UI should
 *                        not commit to "enrolled" vs "standalone";
 *                        show a spinner or just delay any role-driven
 *                        rendering. Lasts <50ms in practice.
 *   - `enrolled=true`  → user has a working token; `snapshot.me` is set.
 *   - `enrolled=false` (loading=false) → standalone mode (full admin
 *                        on the desktop, welcome screen shows the
 *                        Enroll card).
 *
 * The loading distinction matters because right after `loadFromDisk`
 * finishes, a persisted-enrolled user still has `snapshot === null`
 * for the brief window between mount and the first IPC reply. Treating
 * that as "not enrolled" would flicker the welcome screen into
 * standalone mode for a frame or two.
 */
export function useTeam(): {
  snapshot: TeamSnapshot | null
  loading: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    // Prime with whatever the cache currently holds.
    window.api.teamGetSnapshot()
      .then(snap => {
        if (cancelled) return
        setSnapshot(snap)
        setLoading(false)
      })
      .catch(() => {
        // Main process not ready yet — push will catch up. Drop the
        // loading flag so the UI doesn't sit on a spinner forever.
        if (!cancelled) setLoading(false)
      })

    // Stay subscribed to future updates.
    const unsubscribe = window.api.onTeamSnapshot(snap => {
      if (cancelled) return
      setSnapshot(snap)
      setLoading(false)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return {
    snapshot,
    loading,
    refresh: async () => { await window.api.teamRefresh() },
    signOut: async () => { await window.api.teamSignOut() },
  }
}

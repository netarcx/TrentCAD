import { useEffect, useState } from 'react'
import { onApiBusy } from '../lib/apiBusy'

/**
 * React hook that returns the global "FrameCAD is doing something"
 * state. Drives the top progress stripe and the status-bar activity
 * label so the user can always tell whether a long op is alive or the
 * UI has wedged.
 */
export function useApiBusy(): { busy: boolean; label: string | null } {
  const [state, setState] = useState<{ busy: boolean; label: string | null }>({
    busy: false,
    label: null,
  })
  useEffect(() => onApiBusy(s => setState({ busy: s.busy, label: s.label })), [])
  return state
}

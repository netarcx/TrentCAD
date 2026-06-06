import { useApiBusy } from '../hooks/useApiBusy'
import type { JSX } from 'react'

/**
 * Persistent activity indicator that sits at the very top of the
 * window. Renders an animated stripe whenever ANY IPC call has been
 * in flight for longer than the grace period (300ms) — so the user
 * can always tell whether FrameCAD is busy or genuinely frozen.
 *
 * Mounted at the App root, outside the routed views, so a long clone
 * or sync remains visible whether the user is on the welcome screen,
 * inside a project, or in the shop-floor manufacturing view.
 *
 * The current operation name (e.g. "Cloning project") is also surfaced
 * by the status bar at the bottom — this stripe is the always-visible
 * proof-of-life, the status bar is the "what is it doing" detail.
 */
export default function BusyStripe(): JSX.Element | null {
  const { busy, label } = useApiBusy()
  if (!busy) return null
  return (
    <div className="busy-stripe" role="status" aria-live="polite" aria-label={label ?? 'Working'}>
      <div className="busy-stripe-bar" />
    </div>
  )
}

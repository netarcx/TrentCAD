import { useState, type FormEvent } from 'react'
import { ArrowLeft } from 'lucide-react'

interface Props {
  onBack: () => void
  onEnrolled: () => void
}

/**
 * Replaces the old TeamSetup. Two fields (server URL + 6-char PIN),
 * one button. On success, the team snapshot pushes through the
 * teamServer module and the App-level useTeam re-renders to the
 * enrolled state; the caller calls `onEnrolled()` to navigate out of
 * this screen.
 *
 * Errors come back as plain strings from the IPC layer — invalid PIN,
 * unreachable server, role mismatch, etc. — and surface inline.
 */
export default function TeamEnroll({ onBack, onEnrolled }: Props): JSX.Element {
  const [serverUrl, setServerUrl] = useState('')
  const [pin, setPin] = useState('')
  const [deviceLabel, setDeviceLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.teamEnroll({
        serverUrl: serverUrl.trim(),
        pin: pin.trim().toUpperCase(),
        deviceLabel: deviceLabel.trim() || undefined,
      })
      if (!result.success) {
        setError(result.error || 'Could not enroll with that PIN.')
        return
      }
      onEnrolled()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-screen">
      <button className="toolbar-btn back-btn" onClick={onBack}>
        <ArrowLeft size={16} /> Back
      </button>
      <h1>Enroll with your team</h1>
      <p className="subtitle">
        Your admin will give you a 6-character PIN and the server URL.
      </p>
      <form className="setup-form" onSubmit={submit}>
        <div className="form-group">
          <label>Team server URL</label>
          <input
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            placeholder="http://team-server.local:42130"
            disabled={busy}
            autoFocus
            spellCheck={false}
          />
          <span className="form-hint">Whatever your admin shared — usually a LAN address.</span>
        </div>
        <div className="form-group">
          <label>Enrollment PIN</label>
          <input
            value={pin}
            onChange={e => setPin(e.target.value.replace(/[^A-Z2-9]/gi, '').toUpperCase().slice(0, 6))}
            placeholder="ABCDEF"
            maxLength={6}
            disabled={busy}
            spellCheck={false}
            style={{ fontFamily: 'SF Mono, Consolas, monospace', letterSpacing: '3px', textTransform: 'uppercase' }}
          />
          <span className="form-hint">Single-use. Burns the moment you click Enroll.</span>
        </div>
        <div className="form-group">
          <label>This device's name (optional)</label>
          <input
            value={deviceLabel}
            onChange={e => setDeviceLabel(e.target.value)}
            placeholder="e.g. Trent's laptop"
            disabled={busy}
          />
          <span className="form-hint">Shown in the admin web UI's device list.</span>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="actions">
          <button type="button" className="toolbar-btn" onClick={onBack} disabled={busy}>Cancel</button>
          <button
            type="submit"
            className="toolbar-btn primary"
            disabled={busy || pin.length !== 6 || !serverUrl.trim()}
          >
            {busy ? 'Enrolling…' : 'Enroll'}
          </button>
        </div>
      </form>
    </div>
  )
}

import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import { setSession, type AuthedMember } from '../auth'

interface EnrollResponse {
  token: string
  member: AuthedMember
  device: { id: number; label: string }
  team: { name: string }
}

export default function SignIn() {
  const [pin, setPin] = useState('')
  const [label, setLabel] = useState('Admin browser')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    const clean = pin.trim().toUpperCase()
    if (clean.length !== 6) {
      setError('PIN must be 6 characters')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api<EnrollResponse>('POST', '/api/enroll', {
        pin: clean,
        deviceLabel: label.trim() || 'Admin browser',
      })
      if (res.member.role !== 'admin') {
        // Non-admin enrollments can't manage anything via this UI.
        // Burn the freshly-minted token so the device row gets cleaned
        // up via lastSeenAt aging-out, then refuse the login.
        setError('That PIN is for a non-admin role. This web UI is admin-only.')
        return
      }
      setSession(res.token, res.member)
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <div className="signin-card">
        <h1>FrameCAD Team Server</h1>
        <div className="sub">Enter an admin enrollment PIN to sign in</div>
        <form onSubmit={submit}>
          <label>PIN</label>
          <input
            className="pin-input"
            value={pin}
            onChange={e => setPin(e.target.value.replace(/[^A-Z2-9]/gi, '').toUpperCase().slice(0, 6))}
            placeholder="ABCDEF"
            autoFocus
            maxLength={6}
            spellCheck={false}
          />
          <label>This browser's label</label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Admin browser"
          />
          {error && <div className="error">{error}</div>}
          <button className="primary" type="submit" disabled={busy || pin.length !== 6}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

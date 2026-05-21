import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import { setSession, type AuthedMember } from '../auth'

interface AuthResponse {
  token: string
  member: AuthedMember
  device: { id: number; label: string }
  team: { name: string }
}

type Mode = 'password' | 'pin' | 'set-password'

/**
 * Two-mode sign-in for the admin web UI:
 *
 *  - `password`: returning admin types username + password.
 *  - `pin`: first-time PIN claim (or a fresh device for an existing
 *    account). After successful claim, if the member has no password
 *    yet, snap to `set-password` so they leave the screen with a
 *    real account.
 *  - `set-password`: a forced step right after first PIN claim. Two
 *    fields (new + confirm) and a Save button.
 *
 * Once a password is set, future sign-ins use `password` mode.
 * Password mode is the default landing because PIN-only authentication
 * is too weak for an internet-exposed deployment — see the rationale
 * in server/src/db.ts migration v9.
 */
export default function SignIn() {
  const [mode, setMode] = useState<Mode>('password')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  // password mode
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [staySignedIn, setStaySignedIn] = useState(false)

  // pin mode
  const [pin, setPin] = useState('')
  const [pinLabel, setPinLabel] = useState('Admin browser')

  // set-password mode
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // Carries the post-PIN auth state so we can stash the token AFTER
  // the password is set — otherwise a user who bails out of step 2
  // would walk away with an admin device but no password (the very
  // thing we're trying to prevent).
  const [pendingSession, setPendingSession] = useState<AuthResponse | null>(null)

  async function submitPassword(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api<AuthResponse>('POST', '/api/login', {
        username: username.trim(),
        password,
        deviceLabel: 'Web session',
      })
      if (res.member.role !== 'admin') {
        setError('Only admin accounts can sign in to this web UI.')
        return
      }
      setSession(res.token, res.member, staySignedIn)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitPin(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    const clean = pin.trim().toUpperCase()
    if (clean.length !== 6) {
      setError('PIN must be 6 characters.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api<AuthResponse>('POST', '/api/enroll', {
        pin: clean,
        deviceLabel: pinLabel.trim() || 'Admin browser',
      })
      if (res.member.role !== 'admin') {
        setError('That PIN is for a non-admin role. This web UI is admin-only.')
        return
      }
      // Stash the response in memory only — we don't store the token
      // anywhere persistent until the user finishes setting a password.
      // The api helper would normally pick up the token from
      // localStorage; for this one-call step we pass the token via
      // the Authorization header explicitly inside the set-password
      // submit handler.
      setPendingSession(res)
      setMode('set-password')
      // Carry over a sensible username default for the eventual
      // login-form switch: GitHub username if set, else displayName.
      setUsername((res.member.githubUsername || res.member.displayName).toLowerCase())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitNewPassword(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy || !pendingSession) return
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      // We have a token but haven't committed it to storage yet. Use
      // the raw fetch path with the bearer header so the api helper
      // doesn't pick up a missing localStorage token + fail.
      const res = await fetch('/api/me/set-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${pendingSession.token}`,
        },
        body: JSON.stringify({ newPassword }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      // Now commit the session and navigate — same as the password
      // login success path.
      setSession(pendingSession.token, pendingSession.member, staySignedIn)
      navigate('/', { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <div className="signin-card">
        <h1>FrameCAD Team Server</h1>

        {mode === 'password' && (
          <>
            <div className="sub">Sign in with your admin account</div>
            <form onSubmit={submitPassword}>
              <label>Username</label>
              <input
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="your name or GitHub username"
                autoFocus
                autoComplete="username"
                spellCheck={false}
              />
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 10,
                  fontWeight: 400,
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={staySignedIn}
                  onChange={e => setStaySignedIn(e.target.checked)}
                />
                Stay signed in on this browser
              </label>
              {error && <div className="error">{error}</div>}
              <button
                className="primary"
                type="submit"
                disabled={busy || !username.trim() || !password}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            <div className="hint" style={{ marginTop: 14, textAlign: 'center' }}>
              <button
                type="button"
                className="link"
                onClick={() => { setMode('pin'); setError(null) }}
              >
                First time? Sign in with a PIN
              </button>
            </div>
          </>
        )}

        {mode === 'pin' && (
          <>
            <div className="sub">First-time setup — paste your admin PIN</div>
            <form onSubmit={submitPin}>
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
                value={pinLabel}
                onChange={e => setPinLabel(e.target.value)}
                placeholder="Admin browser"
              />
              {error && <div className="error">{error}</div>}
              <button className="primary" type="submit" disabled={busy || pin.length !== 6}>
                {busy ? 'Signing in…' : 'Continue'}
              </button>
            </form>
            <div className="hint" style={{ marginTop: 14, textAlign: 'center' }}>
              <button
                type="button"
                className="link"
                onClick={() => { setMode('password'); setError(null) }}
              >
                I already have an account
              </button>
            </div>
          </>
        )}

        {mode === 'set-password' && (
          <>
            <div className="sub">
              Welcome, {pendingSession?.member.displayName}. Set a password for
              future sign-ins. Username will be <strong>{username}</strong>.
            </div>
            <form onSubmit={submitNewPassword}>
              <label>New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
              <label>Confirm password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
              <div className="hint" style={{ marginTop: 6 }}>
                Minimum 10 characters with both letters and at least one number.
              </div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 10,
                  fontWeight: 400,
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={staySignedIn}
                  onChange={e => setStaySignedIn(e.target.checked)}
                />
                Stay signed in on this browser
              </label>
              {error && <div className="error">{error}</div>}
              <button
                className="primary"
                type="submit"
                disabled={busy || newPassword.length < 10 || !confirmPassword}
              >
                {busy ? 'Saving…' : 'Save & sign in'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

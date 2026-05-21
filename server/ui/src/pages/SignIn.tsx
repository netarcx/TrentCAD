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
 *  - `set-password`: a forced step right after first PIN claim.
 *    Three fields (username + new password + confirm) and a Save
 *    button. The username chosen here becomes the canonical login
 *    handle stored in the `members.username` column.
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
  // Username chosen at first-set time. Default seeded from
  // displayName / githubUsername when the PIN claim resolves, but
  // editable — display names have spaces / capitals that won't
  // satisfy the server's [a-z0-9._-]{3,30} rule.
  const [chosenUsername, setChosenUsername] = useState('')
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
      // Seed a username default from GitHub (if set) or display
      // name. Strip anything outside [a-z0-9._-] so the suggestion
      // already passes the server's validation rule — saves the
      // user from having to clean it up themselves.
      const seed = (res.member.githubUsername || res.member.displayName)
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, 30)
      setChosenUsername(seed)
      // Also pre-fill the "Username" field they'll see on the
      // password-mode login screen after this flow.
      setUsername(seed)
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
    const cleanUsername = chosenUsername.trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,30}$/.test(cleanUsername)) {
      setError('Username must be 3-30 characters, letters/digits/dot/hyphen/underscore only.')
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
        body: JSON.stringify({ newPassword, username: cleanUsername }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      // Server may have upgraded the displayName from "Unnamed
      // member" → the chosen username on first set-password. The
      // pendingSession.member object snapshotted at PIN-claim time
      // is now stale — reflect the fresh state by refetching /api/me
      // before we commit the session, otherwise the sidebar shows
      // the stale "Unnamed member" until the next page refresh.
      let freshMember = pendingSession.member
      try {
        const meRes = await fetch('/api/me', {
          headers: { 'Authorization': `Bearer ${pendingSession.token}` },
        })
        if (meRes.ok) {
          const me = await meRes.json() as { member: AuthedMember }
          if (me?.member) freshMember = me.member
        }
      } catch { /* network blip — keep the snapshot we already have */ }
      // Now commit the session and navigate — same as the password
      // login success path. Also stash the username on the login
      // form so a quick sign-out / sign-in round-trip doesn't make
      // the user re-type it.
      setUsername(cleanUsername)
      setSession(pendingSession.token, freshMember, staySignedIn)
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
            <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
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
            </fieldset>
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
            <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
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
            </fieldset>
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
              Welcome, {pendingSession?.member.displayName}. Pick a
              username and password for future sign-ins.
            </div>
            <form onSubmit={submitNewPassword}>
            <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
              <label>Username</label>
              <input
                value={chosenUsername}
                onChange={e =>
                  setChosenUsername(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9._-]/g, '')
                      .slice(0, 30),
                  )
                }
                placeholder="e.g. tfox"
                autoComplete="username"
                spellCheck={false}
                autoFocus
              />
              <div className="hint" style={{ marginTop: 6 }}>
                3-30 characters. Letters, digits, dot, hyphen, underscore.
                This is what you'll type at the sign-in screen.
              </div>
              <label>New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password"
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
                disabled={
                  busy
                  || newPassword.length < 10
                  || !confirmPassword
                  || !/^[a-z0-9._-]{3,30}$/.test(chosenUsername)
                }
              >
                {busy ? 'Saving…' : 'Save & sign in'}
              </button>
            </fieldset>
            </form>
          </>
        )}

        {/* Desktop installer download. Visible on every sign-in mode
            so anyone who lands on the admin URL by accident (a student
            looking for the desktop app) has a one-click path to the
            latest installer. Points at the upstream GitHub releases
            page, which auto-redirects to whichever release tag is
            current. */}
        <div className="hint" style={{ marginTop: 22, textAlign: 'center', borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          Looking for the desktop app?{' '}
          <a
            href="https://github.com/netarcx/framecad/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
          >
            Download FrameCAD Desktop
          </a>
        </div>
      </div>
    </div>
  )
}

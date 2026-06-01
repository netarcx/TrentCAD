import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, Check } from 'lucide-react'
import { parseEnrollLink, type EnrollLinkParts } from '../lib/parseEnrollLink'
import type { GlobalAdminConfig } from '@shared/types'

interface Props {
  onBack: () => void
  onEnrolled: () => void
  /** Used to pick up `defaultServerUrl` baked into the build via
   *  FRAMECAD_DEFAULT_SERVER_URL. When set, a user pasting just a
   *  bare PIN (no full link) still completes. */
  globalAdmin?: GlobalAdminConfig
}

type Mode = 'pin' | 'signin'
type Step = 'paste' | 'profile' | 'submit'

/**
 * Apple-style enrollment wizard. Three steps:
 *
 *  1. **Paste link** — single input. Admin handed the user a URL like
 *     `http://server-host:42130/enroll/ABCDEF`. We parse out the
 *     server URL + PIN automatically; the user doesn't type either.
 *     If the build has FRAMECAD_DEFAULT_SERVER_URL baked in, pasting
 *     just the 6-char PIN also works.
 *
 *  2. **Your name** — display name is prefilled with the OS username
 *     (best-effort) so the average case is a single Enter keypress.
 *     The Google Drive backend authenticates against Google directly,
 *     so no GitHub sign-in step is needed here.
 *
 *  3. **Submit** — spinner while `teamEnroll` runs, success → caller.
 */
export default function TeamEnroll({ onBack, onEnrolled, globalAdmin }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('pin')
  const [step, setStep] = useState<Step>('paste')
  const [linkInput, setLinkInput] = useState('')
  const [parsed, setParsed] = useState<EnrollLinkParts | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [deviceLabel, setDeviceLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sign-in mode state
  const [siServerUrl, setSiServerUrl] = useState(globalAdmin?.defaultServerUrl ?? '')
  const [siUsername, setSiUsername] = useState('')
  const [siPassword, setSiPassword] = useState('')

  // Re-parse on every keystroke. Cheap operation; gives instant
  // feedback under the input.
  useEffect(() => {
    if (!linkInput.trim()) { setParsed(null); return }
    setParsed(parseEnrollLink(linkInput, globalAdmin?.defaultServerUrl))
  }, [linkInput, globalAdmin?.defaultServerUrl])

  // Prefill name + device label from the OS as a starting point.
  // Best-effort — empty strings are fine if either IPC fails.
  useEffect(() => {
    void window.api.getOsUsername().then(u => { if (u) setDisplayName(u) }).catch(() => null)
    void window.api.getOsHostname().then(h => { if (h) setDeviceLabel(h) }).catch(() => null)
  }, [])

  async function submitEnroll(): Promise<void> {
    if (!parsed) return
    setBusy(true)
    setError(null)
    setStep('submit')
    try {
      const result = await window.api.teamEnroll({
        serverUrl: parsed.serverUrl,
        pin: parsed.pin,
        deviceLabel: deviceLabel.trim() || undefined,
        displayName: displayName.trim() || undefined,
      })
      if (!result.success) {
        setError(result.error || 'Could not enroll with that PIN.')
        setStep('profile')
        return
      }
      onEnrolled()
    } catch (err) {
      setError((err as Error).message)
      setStep('profile')
    } finally {
      setBusy(false)
    }
  }

  async function submitSignIn(): Promise<void> {
    setBusy(true)
    setError(null)
    setStep('submit')
    try {
      const result = await window.api.teamLoginDevice({
        serverUrl: siServerUrl.trim(),
        username: siUsername.trim(),
        password: siPassword,
        deviceLabel: deviceLabel.trim() || undefined,
      })
      if (!result.success) {
        setError(result.error || 'Could not sign in.')
        setStep('paste')
        return
      }
      onEnrolled()
    } catch (err) {
      setError((err as Error).message)
      setStep('paste')
    } finally {
      setBusy(false)
    }
  }

  // Hint shown under the link input. Three cases: nothing typed yet,
  // a valid parsed link (show what we'll connect to), or an
  // unrecognised input.
  const linkHint = useRef<HTMLDivElement | null>(null)
  function renderLinkHint(): JSX.Element | null {
    if (!linkInput.trim()) return null
    if (parsed) {
      // Strip the protocol prefix in the chip so the user reads
      // "host:port" rather than the full scheme noise.
      const host = parsed.serverUrl.replace(/^https?:\/\//i, '')
      return (
        <div className="enroll-link-chip enroll-link-chip-ok">
          <Check size={14} strokeWidth={2} />
          <span>Connecting to <strong>{host}</strong> · PIN <span className="mono">{parsed.pin}</span></span>
        </div>
      )
    }
    // Looks like a bare PIN with no default URL configured. Surface
    // a focused hint rather than the generic "didn't recognise that".
    const looksLikePin = /^[A-HJ-NP-Z2-9]{6}$/i.test(linkInput.trim())
    return (
      <div className="enroll-link-chip enroll-link-chip-err">
        {looksLikePin
          ? 'That looks like just the code. Paste the full link your admin gave you — it includes the server address too.'
          : "Doesn't look like a valid enrollment link. It should look like http://server:42130/enroll/ABCDEF."}
      </div>
    )
  }

  return (
    <div className="setup-screen">
      <button className="toolbar-btn back-btn" onClick={onBack} disabled={busy}>
        <ArrowLeft size={16} /> Back
      </button>

      <div className="enroll-wizard">
        {mode === 'pin' && (
          <div className="enroll-step-dots" aria-label={`Step ${step === 'paste' ? 1 : step === 'profile' ? 2 : 3} of 3`}>
            <span className={`enroll-step-dot${step === 'paste' ? ' active' : ' done'}`} />
            <span className={`enroll-step-dot${step === 'profile' ? ' active' : step === 'submit' ? ' done' : ''}`} />
            <span className={`enroll-step-dot${step === 'submit' ? ' active' : ''}`} />
          </div>
        )}

        {step === 'paste' && mode === 'pin' && (
          <div className="enroll-step">
            <h1>Sync with your team</h1>
            <p className="subtitle">
              Your admin gave you a link. Paste it below.
            </p>
            <input
              className="enroll-link-input"
              value={linkInput}
              onChange={e => setLinkInput(e.target.value)}
              onPaste={e => {
                // Snap the parsed state on paste so the chip updates
                // before the next render tick — slightly snappier
                // than waiting for the controlled-input round-trip.
                const text = e.clipboardData.getData('text')
                if (text) {
                  setLinkInput(text)
                  setParsed(parseEnrollLink(text, globalAdmin?.defaultServerUrl))
                }
              }}
              placeholder="http://your-team.local:42130/enroll/ABCDEF"
              autoFocus
              spellCheck={false}
            />
            {renderLinkHint()}
            <div className="actions">
              <button className="toolbar-btn" onClick={onBack}>Cancel</button>
              <button
                className="toolbar-btn primary"
                disabled={!parsed}
                onClick={() => { setStep('profile'); setError(null) }}
              >
                Continue
              </button>
            </div>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <button
                className="toolbar-btn link-btn"
                onClick={() => { setMode('signin'); setError(null) }}
                style={{ fontSize: 13, opacity: 0.8 }}
              >
                Already have an account? Sign in instead
              </button>
            </div>
          </div>
        )}

        {step === 'paste' && mode === 'signin' && (
          <div className="enroll-step">
            <h1>Sign in</h1>
            <p className="subtitle">
              Use your existing account to add this device.
            </p>
            <div className="form-group">
              <label>Team server</label>
              <input
                className="enroll-link-input"
                value={siServerUrl}
                onChange={e => setSiServerUrl(e.target.value)}
                placeholder="http://your-team.local:42130"
                autoFocus
                spellCheck={false}
              />
            </div>
            <div className="form-group">
              <label>Username</label>
              <input
                className="enroll-link-input"
                value={siUsername}
                onChange={e => setSiUsername(e.target.value)}
                placeholder="your username"
                spellCheck={false}
                autoComplete="username"
              />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input
                className="enroll-link-input"
                type="password"
                value={siPassword}
                onChange={e => setSiPassword(e.target.value)}
                placeholder="your password"
                autoComplete="current-password"
                onKeyDown={e => {
                  if (e.key === 'Enter' && siServerUrl.trim() && siUsername.trim() && siPassword) {
                    void submitSignIn()
                  }
                }}
              />
            </div>
            {error && <div className="form-error">{error}</div>}
            <div className="actions">
              <button className="toolbar-btn" onClick={onBack} disabled={busy}>Cancel</button>
              <button
                className="toolbar-btn primary"
                disabled={busy || !siServerUrl.trim() || !siUsername.trim() || !siPassword}
                onClick={() => void submitSignIn()}
                style={{ minWidth: 120 }}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <button
                className="toolbar-btn link-btn"
                onClick={() => { setMode('pin'); setError(null) }}
                style={{ fontSize: 13, opacity: 0.8 }}
              >
                Have a PIN? Enroll with PIN instead
              </button>
            </div>
          </div>
        )}

        {step === 'profile' && parsed && (
          <div className="enroll-step">
            <h1>Almost there</h1>
            <p className="subtitle">
              Connecting to <strong>{parsed.serverUrl.replace(/^https?:\/\//i, '')}</strong>.
              Tell us who you are.
            </p>
            <div className="form-group">
              <label>Your name</label>
              <input
                className="enroll-link-input"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Jane Smith"
                autoFocus
                spellCheck={false}
                onKeyDown={e => {
                  if (e.key === 'Enter' && displayName.trim()) {
                    void submitEnroll()
                  }
                }}
              />
            </div>
            <div className="form-group">
              <label>This device (optional)</label>
              <input
                className="enroll-link-input"
                value={deviceLabel}
                onChange={e => setDeviceLabel(e.target.value)}
                placeholder="e.g. Trent's laptop"
                spellCheck={false}
              />
              <span className="form-hint">Shown to admins in the web UI's device list.</span>
            </div>

            {error && <div className="form-error">{error}</div>}

            <div className="actions">
              <button
                className="toolbar-btn"
                onClick={() => setStep('paste')}
                disabled={busy}
              >
                Back
              </button>
              {/* Enrollment needs only a display name — the Google Drive
                  backend authenticates against Google directly, and locks
                  live on the team server, so there's no GitHub sign-in
                  gate here. */}
              <button
                className="toolbar-btn primary"
                onClick={() => void submitEnroll()}
                disabled={busy || !displayName.trim()}
                style={{ minWidth: 120 }}
                title={displayName.trim()
                  ? 'Finish enrollment'
                  : 'Enter your name to finish'}
              >
                {busy ? 'Enrolling…' : 'Finish'}
              </button>
            </div>
          </div>
        )}

        {step === 'submit' && (
          <div className="enroll-step">
            <h1>{mode === 'signin' ? 'Signing in…' : 'Enrolling…'}</h1>
            <p className="subtitle">Shaking hands with the team server.</p>
            <div className="enroll-spinner-row">
              <span className="loading-spinner" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

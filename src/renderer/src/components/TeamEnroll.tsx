import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft, Check, ExternalLink } from 'lucide-react'
import { parseEnrollLink, type EnrollLinkParts } from '../lib/parseEnrollLink'
import type { GitHubAuthStatus, GlobalAdminConfig } from '@shared/types'

interface Props {
  onBack: () => void
  onEnrolled: () => void
  /** Used to pick up `defaultServerUrl` baked into the build via
   *  FRAMECAD_DEFAULT_SERVER_URL. When set, a user pasting just a
   *  bare PIN (no full link) still completes. */
  globalAdmin?: GlobalAdminConfig
}

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
 *  2. **Your name + GitHub sign-in** — display name is prefilled with
 *     the OS username (best-effort) so the average case is a single
 *     Enter keypress. GitHub sign-in is a step rather than the
 *     legacy lazy-on-push prompt — when GitHub becomes a hard
 *     requirement later, just hide the Skip button.
 *
 *  3. **Submit** — spinner while `teamEnroll` runs, success → caller.
 */
export default function TeamEnroll({ onBack, onEnrolled, globalAdmin }: Props): JSX.Element {
  const [step, setStep] = useState<Step>('paste')
  const [linkInput, setLinkInput] = useState('')
  const [parsed, setParsed] = useState<EnrollLinkParts | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [deviceLabel, setDeviceLabel] = useState('')
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus | null>(null)
  const [signInPending, setSignInPending] = useState(false)
  const [signInHint, setSignInHint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  // When the user enters step 2, snapshot the GitHub auth status so
  // we can show "signed in" vs "sign in needed" without making them
  // wait for a poll.
  useEffect(() => {
    if (step !== 'profile') return
    void window.api.githubAuthStatus().then(setAuthStatus).catch(() => null)
  }, [step])

  // While sign-in is pending, poll every 3 s for up to ~2 min so the
  // wizard auto-advances when the browser/terminal flow completes.
  // Pattern lifted from the pre-rewrite ProjectSetup.tsx; same
  // 120 s ceiling so an abandoned sign-in doesn't poll forever.
  useEffect(() => {
    if (!signInPending) return
    let cancelled = false
    const start = Date.now()
    const id = setInterval(async () => {
      if (cancelled || Date.now() - start > 120_000) {
        setSignInPending(false)
        return
      }
      try {
        const status = await window.api.githubAuthStatus()
        if (cancelled) return
        setAuthStatus(status)
        if (status.loggedIn) {
          setSignInPending(false)
          setSignInHint(`✓ Signed in as ${status.username}`)
        }
      } catch { /* try again next tick */ }
    }, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [signInPending])

  async function startGitHubLogin(): Promise<void> {
    setError(null)
    setSignInHint(null)
    try {
      const result = await window.api.githubLogin()
      if (result.launched) {
        setSignInPending(true)
        setSignInHint('Sign-in opened in a new window. Finish there — we\'ll detect it automatically.')
      } else if (result.error?.startsWith('MANUAL_SIGNIN_REQUIRED:')) {
        // Mac/Linux: we couldn't spawn a terminal; user runs the
        // command themselves. Show the instructions inline.
        setSignInPending(true)
        setSignInHint(result.error.slice('MANUAL_SIGNIN_REQUIRED:'.length))
      } else {
        setSignInHint(result.error || 'Could not launch GitHub sign-in.')
      }
    } catch (err) {
      setSignInHint((err as Error).message)
    }
  }

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
        githubUsername: authStatus?.loggedIn ? authStatus.username : undefined,
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
        <div className="enroll-step-dots" aria-label={`Step ${step === 'paste' ? 1 : step === 'profile' ? 2 : 3} of 3`}>
          <span className={`enroll-step-dot${step === 'paste' ? ' active' : ' done'}`} />
          <span className={`enroll-step-dot${step === 'profile' ? ' active' : step === 'submit' ? ' done' : ''}`} />
          <span className={`enroll-step-dot${step === 'submit' ? ' active' : ''}`} />
        </div>

        {step === 'paste' && (
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
                  if (e.key === 'Enter' && displayName.trim() && !signInPending) {
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

            <div className="enroll-github-row">
              <label>GitHub sign-in</label>
              {authStatus?.loggedIn ? (
                <div className="enroll-github-status enroll-github-status-ok">
                  <Check size={14} strokeWidth={2} />
                  <span>Signed in as <strong>@{authStatus.username}</strong></span>
                </div>
              ) : signInPending ? (
                <div className="enroll-github-status enroll-github-status-pending">
                  Waiting for sign-in to complete…
                </div>
              ) : (
                <button
                  type="button"
                  className="toolbar-btn primary"
                  onClick={startGitHubLogin}
                  disabled={authStatus?.ghCliAvailable === false}
                >
                  <ExternalLink size={14} strokeWidth={2} />
                  <span style={{ marginLeft: 4 }}>Sign in with GitHub</span>
                </button>
              )}
              {signInHint && <div className="enroll-github-hint">{signInHint}</div>}
              {authStatus?.ghCliAvailable === false && (
                <div className="enroll-github-hint" style={{ lineHeight: 1.5 }}>
                  <strong>GitHub CLI isn't installed on this machine.</strong>{' '}
                  FrameCAD uses <span className="mono">gh</span> to handle GitHub
                  sign-in. Install it first, then come back here:
                  <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                    <li>
                      <strong>Windows:</strong>{' '}
                      <span className="mono">winget install --id GitHub.cli</span>
                      {' '}(or{' '}
                      <a
                        href="https://cli.github.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                      >cli.github.com</a>
                      {' '}for the installer)
                    </li>
                    <li>
                      <strong>macOS:</strong>{' '}
                      <span className="mono">brew install gh</span>
                    </li>
                    <li>
                      <strong>Linux:</strong>{' '}
                      see{' '}
                      <a
                        href="https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
                        target="_blank"
                        rel="noopener noreferrer"
                      >install_linux.md</a>
                    </li>
                  </ul>
                  After install, restart FrameCAD so it picks up the new
                  <span className="mono"> gh</span> on your PATH.
                </div>
              )}
              {!authStatus?.loggedIn && authStatus?.ghCliAvailable !== false && (
                <div className="enroll-github-hint">
                  GitHub sign-in is required so FrameCAD can clone your team's
                  private repos and identify your check-outs to teammates.
                </div>
              )}
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
              {/* Finish is disabled until GitHub sign-in succeeds.
                  Was previously skippable, but private-repo support
                  + auditability mean we need a real GitHub identity
                  on every device. Users without `gh` installed see
                  the install-instructions hint above instead of a
                  dead-end. */}
              <button
                className="toolbar-btn primary"
                onClick={() => void submitEnroll()}
                disabled={busy || !displayName.trim() || !authStatus?.loggedIn}
                style={{ minWidth: 120 }}
                title={authStatus?.loggedIn
                  ? 'Finish enrollment with your GitHub account'
                  : 'Sign in with GitHub first — required for private-repo access'}
              >
                {busy ? 'Enrolling…' : 'Finish'}
              </button>
            </div>
          </div>
        )}

        {step === 'submit' && (
          <div className="enroll-step">
            <h1>Enrolling…</h1>
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

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import { clearSession } from '../auth'

interface Team {
  name: string
  gitHubOrg: string
  projectPrefix: string
  welcomeMessage: string
  lfsUrl: string
}

// Reasonable client-side validation for the LFS URL. Catches the
// common mistakes (no scheme, trailing whitespace, weird characters)
// before the network call. Server runs the same check + strips
// trailing slashes on save, so this is just for instant feedback.
const LFS_URL_REGEX = /^https?:\/\/[^\s"'<>]+$/

export default function TeamSettings() {
  const navigate = useNavigate()
  const [team, setTeam] = useState<Team>({
    name: '', gitHubOrg: '', projectPrefix: '', welcomeMessage: '', lfsUrl: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Reset flow has three stages: closed → confirm-1 → confirm-2 →
  // post-reset (showing the new PIN before kicking back to sign-in).
  const [resetStage, setResetStage] = useState<'closed' | 'confirm1' | 'confirm2' | 'done'>('closed')
  const [resetTyped, setResetTyped] = useState('')
  const [newSetupPin, setNewSetupPin] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    api<Team>('GET', '/api/team')
      .then(setTeam)
      .catch(err => setError((err as ApiError).message))
  }, [])

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      // Mirror the server's `.replace(/\/+$/, '')` on lfsUrl so the
      // user sees the cleaned value reflected back into the field
      // immediately after save without having to refetch.
      const payload = { ...team, lfsUrl: team.lfsUrl.trim().replace(/\/+$/, '') }
      if (payload.lfsUrl && !LFS_URL_REGEX.test(payload.lfsUrl)) {
        setError('LFS URL must be a plain http:// or https:// URL (no quotes, spaces, or angle brackets).')
        return
      }
      await api('PATCH', '/api/admin/team', payload)
      setTeam(payload)
      setStatus('Saved. Connected clients pick this up on their next sync.')
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Team Settings</h1>
      <div className="sub">Server-wide configuration that every client sees.</div>

      {error && <div className="error">{error}</div>}
      {status && <div className="success">{status}</div>}

      <div className="card">
        <h3>Identity</h3>
        <label>Team name</label>
        <input value={team.name} onChange={e => setTeam({ ...team, name: e.target.value })} placeholder="FRC Team 2129" />

        <label>Welcome message</label>
        <textarea
          rows={3}
          value={team.welcomeMessage}
          onChange={e => setTeam({ ...team, welcomeMessage: e.target.value })}
          placeholder="Optional message shown on the FrameCAD welcome screen"
        />
      </div>

      <div className="card">
        <h3>GitHub Browse</h3>
        <div className="hint">
          When set, members see a "Browse Projects" button on the welcome
          screen listing repos in this org that match the prefix. New
          projects use the prefix automatically.
        </div>
        <label>GitHub organization</label>
        <input value={team.gitHubOrg} onChange={e => setTeam({ ...team, gitHubOrg: e.target.value })} placeholder="netarcx" />

        <label>Project name prefix</label>
        <input value={team.projectPrefix} onChange={e => setTeam({ ...team, projectPrefix: e.target.value })} placeholder="framecad-" />
      </div>

      <div className="card">
        <h3>Self-hosted LFS</h3>
        <div className="hint">
          The URL desktop clients use to reach the Giftless container. Must
          be reachable from the team's machines on the school network — a
          LAN IP or DNS name, not <span className="mono">localhost</span>.
          Leave blank to fall back to GitHub LFS (not recommended; eats
          your GitHub LFS quota).
        </div>
        <label>LFS URL</label>
        <input
          value={team.lfsUrl}
          onChange={e => setTeam({ ...team, lfsUrl: e.target.value })}
          placeholder="http://framecad.school.local:42131"
          spellCheck={false}
          autoCapitalize="off"
        />
        {team.lfsUrl && /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(team.lfsUrl) && (
          <div className="hint" style={{ color: 'var(--red)', marginTop: 6 }}>
            Heads up: localhost / 127.0.0.1 only works on the same machine as
            the server. Use the host's LAN IP or DNS name so students' Windows
            boxes can reach it.
          </div>
        )}
      </div>

      <div style={{ marginTop: 18 }}>
        <button className="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {/* ── Danger zone ─────────────────────────────────────────────
          Server reset. Wipes every member, device, PIN, project, and
          team setting, then re-issues a fresh bootstrap PIN so the
          operator can re-test the setup wizard. Intended for
          development; leaving it permanently visible is a deliberate
          choice — admins are trusted and the three-stage gate
          (collapse → type RESET → confirm warning → action) is
          enough friction to prevent accidents. */}
      <div className="card danger-zone">
        <h3>Danger zone</h3>
        <div className="hint">
          Reset every member, device, PIN, project, and team setting back to
          a fresh-install state. Useful while testing the first-launch flow.
          Does <strong>not</strong> delete the LFS object store — wipe
          <span className="mono"> ./data/lfs-objects/ </span> by hand if you
          need a true clean slate.
        </div>

        {resetStage === 'closed' && (
          <button
            className="secondary danger"
            onClick={() => { setResetStage('confirm1'); setResetTyped(''); setError(null) }}
          >
            Reset server…
          </button>
        )}

        {resetStage === 'confirm1' && (
          <div style={{ marginTop: 8 }}>
            <div className="hint" style={{ color: 'var(--red)', marginBottom: 6 }}>
              This will delete <strong>every</strong> member, device, PIN,
              and project on this server. You'll be signed out and the
              first-launch setup will start over.
            </div>
            <label>Type <span className="mono">RESET</span> to continue</label>
            <input
              value={resetTyped}
              onChange={e => setResetTyped(e.target.value)}
              placeholder="RESET"
              autoFocus
            />
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button
                className="secondary danger"
                onClick={() => setResetStage('confirm2')}
                disabled={resetTyped !== 'RESET'}
              >
                I understand — continue
              </button>
              <button className="link" onClick={() => setResetStage('closed')}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {resetStage === 'confirm2' && (
          <div style={{ marginTop: 8 }}>
            <div className="hint" style={{ color: 'var(--red)', marginBottom: 6 }}>
              Last chance. Click the red button to wipe the database.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="secondary danger"
                disabled={resetting}
                onClick={async () => {
                  setResetting(true)
                  setError(null)
                  try {
                    const res = await api<{ setupPin: string | null }>(
                      'POST', '/api/admin/dev-reset', { confirm: 'RESET' }
                    )
                    setNewSetupPin(res.setupPin)
                    setResetStage('done')
                  } catch (err) {
                    setError((err as ApiError).message)
                    setResetStage('closed')
                  } finally {
                    setResetting(false)
                  }
                }}
              >
                {resetting ? 'Resetting…' : 'Yes, wipe everything'}
              </button>
              <button className="link" onClick={() => setResetStage('closed')} disabled={resetting}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {resetStage === 'done' && (
          <div className="success" style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 8 }}>
              Server reset. Your old session is invalid; sign in again with
              the new setup PIN below.
            </div>
            {newSetupPin ? (
              <>
                <span className="tag" style={{ fontSize: 18 }}>{newSetupPin}</span>
                <div className="hint" style={{ marginTop: 6 }}>
                  Also saved to <span className="mono">./data/SETUP_PIN.txt</span> and printed to logs.
                </div>
              </>
            ) : (
              <div className="hint">
                Check <span className="mono">./data/SETUP_PIN.txt</span> or the server logs for the new PIN.
              </div>
            )}
            <button
              className="primary"
              style={{ marginTop: 12 }}
              onClick={() => {
                clearSession()
                navigate('/sign-in', { replace: true })
              }}
            >
              Sign in with new PIN
            </button>
          </div>
        )}
      </div>
    </>
  )
}

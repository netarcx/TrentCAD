import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import { clearSession } from '../auth'
import { getStoredTheme, setStoredTheme, type ThemeChoice } from '../theme'

interface TeamPolicies {
  maxFileSizeMb: number
  blockedExtensions: string[]
  quotaGraceHours: number
}

interface Team {
  name: string
  gitHubOrg: string
  projectPrefix: string
  welcomeMessage: string
  googleSharedDriveIds: string
  hasGitHubPat: boolean
  policies?: TeamPolicies
}

export default function TeamSettings() {
  const navigate = useNavigate()
  const [team, setTeam] = useState<Team>({
    name: '', gitHubOrg: '', projectPrefix: '', welcomeMessage: '',
    googleSharedDriveIds: '',
    hasGitHubPat: false,
  })
  // PAT input is write-only — server never echoes the value back. The
  // input shows "" by default; the user can leave it blank to keep
  // the existing token or type a new one to replace it.
  const [patInput, setPatInput] = useState('')
  // Policy form state. Numeric fields are kept as STRINGS in form
  // state so an empty input doesn't snap to 0 (which would fail
  // validation but also confuse the user — cursor jumping, value
  // reappearing). Conversion to number happens at save time inside
  // the validation block. blockedExtensions stays a CSV in the
  // textarea; parsed on save.
  const [policyForm, setPolicyForm] = useState({
    maxFileSizeMb: '256',
    blockedExtensionsCsv: '',
    quotaGraceHours: '24',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Per-admin GitHub PAT — separate from the team-level token, used
  // when this admin probes / creates repos so their own scope (incl.
  // SSO + per-repo access) covers things the team token might miss.
  const [hasMyGhPat, setHasMyGhPat] = useState(false)
  const [myPatInput, setMyPatInput] = useState('')
  // Theme picker — client-only setting, persisted to localStorage.
  // The choice 'system' follows the OS prefers-color-scheme.
  const [theme, setThemeState] = useState<ThemeChoice>(getStoredTheme())
  // Reset flow has three stages: closed → confirm-1 → confirm-2 →
  // post-reset (showing the new PIN before kicking back to sign-in).
  const [resetStage, setResetStage] = useState<'closed' | 'confirm1' | 'confirm2' | 'done'>('closed')
  const [resetTyped, setResetTyped] = useState('')
  const [newSetupPin, setNewSetupPin] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    // Personal PAT status — independent fetch since /api/team is
    // team-wide and we need the calling admin's own gitHubPat flag.
    api<{ member: { hasGitHubPat?: boolean } }>('GET', '/api/me')
      .then(r => setHasMyGhPat(!!r.member.hasGitHubPat))
      .catch(() => { /* silent — non-fatal */ })

    api<Team>('GET', '/api/team')
      .then(t => {
        setTeam(t)
        // Hydrate the policy form from the server response. Use
        // sensible defaults for any missing field (older server
        // versions that don't return policies).
        if (t.policies) {
          setPolicyForm({
            maxFileSizeMb: String(t.policies.maxFileSizeMb ?? 256),
            blockedExtensionsCsv: (t.policies.blockedExtensions ?? []).join(', '),
            quotaGraceHours: String(t.policies.quotaGraceHours ?? 24),
          })
        }
      })
      .catch(err => setError((err as ApiError).message))
  }, [])

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      // We strip `hasGitHubPat` (server-computed boolean, not editable)
      // and only include `gitHubPat` when the user typed something
      // new (empty input = keep existing token, don't clobber).
      const { hasGitHubPat: _hasPat, policies: _policies, ...rest } = team
      const payload: Record<string, unknown> = { ...rest }
      const sharedDriveIds = team.googleSharedDriveIds
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      for (const id of sharedDriveIds) {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
          setError(`Google Shared Drive ID "${id}" is invalid. Use comma-separated Drive IDs only.`)
          setBusy(false)
          return
        }
      }
      payload.googleSharedDriveIds = Array.from(new Set(sharedDriveIds)).join(',')
      if (patInput.trim() !== '') payload.gitHubPat = patInput.trim()
      // Parse numeric fields from their string form-state. Empty
      // string → NaN, which we surface as "must be a number"
      // instead of silently coercing to 0.
      const maxFileSizeMb = Number.parseInt(policyForm.maxFileSizeMb, 10)
      const quotaGraceHours = Number.parseInt(policyForm.quotaGraceHours, 10)
      // Range-validate policies client-side so the user sees a
      // friendlier error than the server's 400 echo. Server runs
      // the same checks (these are belt-and-suspenders).
      if (!Number.isInteger(maxFileSizeMb) || maxFileSizeMb < 10 || maxFileSizeMb > 2048) {
        setError('Max file size must be an integer between 10 and 2048 MB.')
        setBusy(false)
        return
      }
      if (!Number.isInteger(quotaGraceHours) || quotaGraceHours < 0 || quotaGraceHours > 168) {
        setError('Quota grace window must be an integer between 0 and 168 hours.')
        setBusy(false)
        return
      }
      // Parse the CSV into a clean array — split on commas/spaces/
      // newlines, strip leading dots, lowercase, dedupe. Server
      // re-validates per-entry against [a-z0-9]+ so any junk hits
      // a 400 response (which would surface in the catch below).
      const blockedExtensions = Array.from(new Set(
        policyForm.blockedExtensionsCsv
          .split(/[\s,]+/)
          .map(s => s.trim().replace(/^\./, '').toLowerCase())
          .filter(Boolean)
      ))
      payload.maxFileSizeMb = maxFileSizeMb
      payload.blockedExtensions = blockedExtensions
      payload.quotaGraceHours = quotaGraceHours

      await api('PATCH', '/api/admin/team', payload)
      // Update local team state to reflect what we just sent. Wipe the
      // PAT input on success so a re-save doesn't re-send the same token.
      setTeam({
        ...team,
        googleSharedDriveIds: payload.googleSharedDriveIds as string,
        hasGitHubPat: patInput.trim() !== '' ? true : team.hasGitHubPat,
        policies: {
          maxFileSizeMb,
          blockedExtensions,
          quotaGraceHours,
        },
      })
      if (patInput.trim() !== '') setPatInput('')
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
        <h3>Your GitHub account</h3>
        <div className="hint">
          Link a personal access token from <strong>your</strong>{' '}
          GitHub account. FrameCAD uses it when YOU initiate a GitHub
          API call from the admin UI (checking a project's remote,
          creating a new repo) so the call runs with your own access
          — picking up SSO-protected and per-repo private repos that
          a shared team token can't see. The token never reaches
          browsers or desktop clients; it's stored on this server
          and only used server-side.
          {' '}
          <a
            href="https://github.com/settings/tokens?type=beta"
            target="_blank"
            rel="noopener noreferrer"
          >
            Create a fine-grained token
          </a>{' '}
          with <span className="mono">contents:read</span> +{' '}
          <span className="mono">metadata:read</span> on the repos you
          care about (and <span className="mono">administration:write</span>{' '}
          if you'll create new repos from FrameCAD).
        </div>
        <label>
          Personal token: {hasMyGhPat ? (
            <span style={{ color: 'var(--green)' }}>linked</span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>not linked</span>
          )}
        </label>
        <input
          type="password"
          value={myPatInput}
          onChange={e => setMyPatInput(e.target.value)}
          placeholder={hasMyGhPat
            ? 'Leave blank to keep the existing token'
            : 'ghp_… or github_pat_…'}
          autoComplete="off"
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="primary"
            disabled={busy || !myPatInput.trim()}
            onClick={async () => {
              setBusy(true); setError(null); setStatus(null)
              try {
                const res = await api<{ hasGitHubPat: boolean }>(
                  'POST', '/api/me/github-pat',
                  { gitHubPat: myPatInput.trim() },
                )
                setHasMyGhPat(!!res.hasGitHubPat)
                setMyPatInput('')
                setStatus('Your GitHub token is linked.')
              } catch (err) {
                setError((err as ApiError).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {hasMyGhPat ? 'Replace token' : 'Link token'}
          </button>
          {hasMyGhPat && (
            <button
              className="link"
              disabled={busy}
              onClick={async () => {
                if (!confirm('Unlink your personal GitHub token? Admin operations will fall back to the team-level token; private repos that only your account can see may stop showing up correctly.')) return
                setBusy(true); setError(null)
                try {
                  await api('POST', '/api/me/github-pat', { gitHubPat: '' })
                  setHasMyGhPat(false)
                  setMyPatInput('')
                  setStatus('Personal GitHub token unlinked.')
                } catch (err) {
                  setError((err as ApiError).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Unlink
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3>GitHub (team)</h3>
        <div className="hint">
          Organization, project-name prefix, and a <strong>shared</strong>{' '}
          fallback Personal Access Token. The team token is used when
          the calling admin hasn't linked their own (see the card above);
          for org-wide operations like check-remote on every project
          where no specific admin's token has been linked yet. Scopes
          needed: classic <span className="mono">repo</span> (full) OR a
          fine-grained token with <span className="mono">contents:write</span>,{' '}
          <span className="mono">metadata:read</span>, and{' '}
          <span className="mono">administration:write</span> on the
          org's repos.
        </div>

        <label>GitHub organization</label>
        <input value={team.gitHubOrg} onChange={e => setTeam({ ...team, gitHubOrg: e.target.value })} placeholder="netarcx" />

        <label>Project name prefix</label>
        <input value={team.projectPrefix} onChange={e => setTeam({ ...team, projectPrefix: e.target.value })} placeholder="framecad-" />
        <div className="hint" style={{ marginTop: 4 }}>
          Members see a "Browse Projects" button on the welcome screen
          listing repos in this org that match the prefix. New repos
          created from the admin Projects page are auto-prefixed too.
        </div>

        <label style={{ marginTop: 12 }}>
          Personal Access Token: {team.hasGitHubPat ? (
            <span style={{ color: 'var(--green)' }}>set</span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>not set</span>
          )}
        </label>
        <input
          type="password"
          value={patInput}
          onChange={e => setPatInput(e.target.value)}
          placeholder={team.hasGitHubPat
            ? 'Leave blank to keep the existing token'
            : 'ghp_… or github_pat_…'}
          autoComplete="off"
          spellCheck={false}
        />
        {team.hasGitHubPat && (
          <button
            type="button"
            className="link"
            style={{ marginTop: 6 }}
            onClick={async () => {
              if (!confirm('Clear the stored GitHub token? FrameCAD will no longer be able to create repos or clone private ones until a new token is set.')) return
              setBusy(true)
              setError(null)
              try {
                await api('PATCH', '/api/admin/team', { gitHubPat: '' })
                setTeam({ ...team, hasGitHubPat: false })
                setPatInput('')
                setStatus('GitHub token cleared.')
              } catch (err) {
                setError((err as ApiError).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            Clear token
          </button>
        )}
      </div>

      <div className="card">
        <h3>Google Drive</h3>
        <div className="hint">
          Restrict Drive-backend projects to specific Google Shared Drives.
          Enrolled desktop clients use this server value on their next
          snapshot refresh; leave blank to use the installer-baked
          allowlist. Use the Shared Drive ID, not the folder URL.
        </div>
        <label>Allowed Shared Drive IDs</label>
        <textarea
          rows={3}
          value={team.googleSharedDriveIds}
          onChange={e => setTeam({ ...team, googleSharedDriveIds: e.target.value })}
          placeholder="0AExampleSharedDriveId, 0AAnotherSharedDriveId"
          spellCheck={false}
          autoCapitalize="off"
        />
        <div className="hint" style={{ marginTop: 4 }}>
          Comma-separated. Once set, FrameCAD only lists, joins, syncs, and
          publishes projects in these Shared Drives.
        </div>
      </div>


      <div style={{ marginTop: 18 }}>
        <button className="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <div className="card">
        <h3>Limits &amp; Policies</h3>
        <div className="hint">
          Values used to be hardcoded in the desktop client — moving them
          here means tweaks take effect on every client's next snapshot
          refresh without cutting a new release. All ranges are server-
          enforced; bad values are rejected at save time.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label>Max file size (MB)</label>
            <input
              type="number"
              min="10"
              max="2048"
              step="1"
              value={policyForm.maxFileSizeMb}
              onChange={e => setPolicyForm({ ...policyForm, maxFileSizeMb: e.target.value })}
            />
            <div className="hint" style={{ marginTop: 4 }}>
              Hard refusal at publish. Range 10–2048.
            </div>
          </div>
          <div>
            <label>Quota grace window (hours)</label>
            <input
              type="number"
              min="0"
              max="168"
              step="1"
              value={policyForm.quotaGraceHours}
              onChange={e => setPolicyForm({ ...policyForm, quotaGraceHours: e.target.value })}
            />
            <div className="hint" style={{ marginTop: 4 }}>
              Hours a project can publish over its storage cap. Range 0–168.
            </div>
          </div>
        </div>
        <label>Blocked file extensions</label>
        <textarea
          rows={3}
          value={policyForm.blockedExtensionsCsv}
          onChange={e => setPolicyForm({ ...policyForm, blockedExtensionsCsv: e.target.value })}
          placeholder="exe, mp4, mov, rar, 7z, …"
        />
        <div className="hint" style={{ marginTop: 4 }}>
          Comma- or space-separated. No leading dots. Default refuses videos /
          audio / executables / niche archives. Images and zip are explicitly
          allowed (vendor STEP packages ship as .zip).
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save policies'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Appearance</h3>
        <div className="hint">
          Theme is a per-browser preference — not stored on the team server.
          "System" follows the OS's light/dark setting and updates live when
          you flip it (e.g. macOS auto-dark at sunset).
        </div>
        <label>Theme</label>
        <select
          value={theme}
          onChange={e => {
            const next = e.target.value as ThemeChoice
            setThemeState(next)
            setStoredTheme(next)
          }}
        >
          <option value="system">System (follow OS)</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
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

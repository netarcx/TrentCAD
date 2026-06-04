import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import CapabilityControls from '../components/CapabilityControls'
import {
  EMPTY_CAPABILITY_VALUE,
  type CapabilityValue,
  type ProjectOption,
} from '../caps'

interface SetupState {
  setupComplete: boolean
  teamInfoSet: boolean
  projectCount: number
  memberCount: number
}

type Step = 'team' | 'project' | 'member' | 'done'

/**
 * First-launch admin onboarding wizard.
 *
 * Walks a freshly-bootstrapped admin through the minimum a real team
 * needs: team name + GitHub org, a first project, and a first PIN for
 * a teammate. Every step is skippable — the admin can finish the
 * wizard with all still pending and the server is in a perfectly
 * usable state — but doing the steps now means a single linear flow
 * instead of hunting around the sidebar.
 *
 * Triggered by AdminShell when `/api/admin/setup-state` says the
 * team row hasn't been marked complete. Once "Finish" is clicked
 * we POST /api/admin/setup-complete and never show this again.
 */
export default function Wizard() {
  const navigate = useNavigate()
  const [state, setState] = useState<SetupState | null>(null)
  const [step, setStep] = useState<Step>('team')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ── Per-step form state ────────────────────────────────────────────
  const [teamName, setTeamName] = useState('')
  const [gitHubOrg, setGitHubOrg] = useState('')
  const [projectPrefix, setProjectPrefix] = useState('')

  const [projectName, setProjectName] = useState('')
  const [projectRepoUrl, setProjectRepoUrl] = useState('')
  const [projectQuotaGb, setProjectQuotaGb] = useState('10')

  const [pinRole, setPinRole] = useState<'student' | 'mentor' | 'admin'>('student')
  const [pinDisplayName, setPinDisplayName] = useState('')
  const [pinGitHub, setPinGitHub] = useState('')
  const [pinCaps, setPinCaps] = useState<CapabilityValue>(EMPTY_CAPABILITY_VALUE)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [issuedPinCode, setIssuedPinCode] = useState<string | null>(null)

  useEffect(() => {
    api<SetupState>('GET', '/api/admin/setup-state')
      .then(s => {
        setState(s)
        // Prefill team fields from existing values so re-entering the
        // wizard doesn't wipe out what the admin already typed.
        // (Empty server defaults will just leave the inputs blank.)
        return api<{ name: string; gitHubOrg: string; projectPrefix: string }>(
          'GET', '/api/team'
        )
      })
      .then(t => {
        setTeamName(t.name ?? '')
        setGitHubOrg(t.gitHubOrg ?? '')
        setProjectPrefix(t.projectPrefix ?? '')
      })
      .catch(err => setError((err as ApiError).message))
  }, [])

  // Pull the project list into memory once the admin reaches the
  // member step; needed for the capability controls' allowlist picker.
  useEffect(() => {
    if (step !== 'member') return
    api<{ projects: Array<{ id: number; name: string }> }>('GET', '/api/admin/projects')
      .then(r => setProjects(r.projects.map(p => ({ id: p.id, name: p.name }))))
      .catch(() => { /* the picker just shows empty — admin can fix later */ })
  }, [step])

  // ── Step handlers ──────────────────────────────────────────────────

  async function saveTeam(): Promise<void> {
    if (!teamName.trim()) {
      setError('Team name is required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api('PATCH', '/api/admin/team', {
        name: teamName,
        gitHubOrg,
        projectPrefix,
      })
      setStep('project')
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function addProject(): Promise<void> {
    if (!projectName.trim() || !projectRepoUrl.trim()) {
      setError('Both fields are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const gb = Number.parseFloat(projectQuotaGb)
      const quotaBytes = Number.isFinite(gb) && gb >= 0
        ? Math.round(gb * 1024 * 1024 * 1024)
        : null
      await api('POST', '/api/admin/projects', {
        name: projectName,
        repoUrl: projectRepoUrl,
        quotaBytes,
      })
      setStep('member')
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function issuePin(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const pin = await api<{ code: string }>('POST', '/api/admin/pins', {
        role: pinRole,
        displayName: pinDisplayName.trim() || undefined,
        githubUsername: pinGitHub.trim() || undefined,
        capabilities: pinCaps.capabilities,
        allowedProjectIds: pinCaps.allowedProjectIds,
        autoOpenProjectId: pinCaps.autoOpenProjectId,
        kioskMode: pinCaps.kioskMode,
        archiveMode: pinCaps.archiveMode,
      })
      setIssuedPinCode(pin.code)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function finish(): Promise<void> {
    setBusy(true)
    try {
      await api('POST', '/api/admin/setup-complete')
      navigate('/', { replace: true })
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────

  if (!state) {
    return <div style={{ padding: 30, color: 'var(--text-muted)' }}>Loading…</div>
  }

  // If somehow we end up here after setup has already been marked
  // complete (e.g. operator forced /setup in the URL), just bounce.
  if (state.setupComplete) {
    navigate('/', { replace: true })
    return null
  }

  const stepIndex = ['team', 'project', 'member'].indexOf(step)

  return (
    <div className="wizard">
      <div className="wizard-card">
        <div className="wizard-header">
          <div className="wizard-brand">FrameCAD</div>
          <div className="wizard-progress">
            {['Team', 'Project', 'Member'].map((label, i) => (
              <div
                key={label}
                className={`wizard-dot${
                  i === stepIndex ? ' active' : i < stepIndex ? ' done' : ''
                }`}
              >
                <span>{i + 1}</span>
                <small>{label}</small>
              </div>
            ))}
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        {step === 'team' && (
          <>
            <h2>Tell us about your team</h2>
            <div className="hint">
              The name and GitHub org show up everywhere a team member
              looks — the desktop welcome screen, the admin web UI,
              every project's clone URL.
            </div>
            <label>Team name</label>
            <input
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              placeholder="FRC Team 2129"
              autoFocus
            />
            <label>GitHub org</label>
            <input
              value={gitHubOrg}
              onChange={e => setGitHubOrg(e.target.value)}
              placeholder="netarcx"
            />
            <label>Project prefix (optional)</label>
            <input
              value={projectPrefix}
              onChange={e => setProjectPrefix(e.target.value)}
              placeholder="frc2129-"
            />
            <div className="wizard-nav">
              <button className="link" onClick={() => setStep('project')}>
                Skip for now
              </button>
              <button
                className="primary"
                onClick={saveTeam}
                disabled={busy || !teamName.trim()}
              >
                {busy ? 'Saving…' : 'Continue'}
              </button>
            </div>
          </>
        )}

        {step === 'project' && (
          <>
            <h2>Add your first project</h2>
            <div className="hint">
              Create the GitHub repo first, then paste its URL here. Team
              members will see this project on the FrameCAD welcome screen
              once they enroll.
            </div>
            <label>Project name</label>
            <input
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder="2026 Robot"
              autoFocus
            />
            <label>Repo URL</label>
            <input
              value={projectRepoUrl}
              onChange={e => setProjectRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
            <label>Storage quota (GB)</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={projectQuotaGb}
              onChange={e => setProjectQuotaGb(e.target.value)}
              placeholder="blank = unlimited"
            />
            <div className="hint" style={{ marginTop: 4 }}>
              Hard cap on how much CAD data this project can store in
              Google Drive. 10 GB is plenty for a robot's worth of files;
              tweak later from the Projects page.
            </div>
            <div className="wizard-nav">
              <button className="link" onClick={() => setStep('member')}>
                Skip — I'll add projects later
              </button>
              <button
                className="primary"
                onClick={addProject}
                disabled={busy || !projectName.trim() || !projectRepoUrl.trim()}
              >
                {busy ? 'Adding…' : 'Add & continue'}
              </button>
            </div>
          </>
        )}

        {step === 'member' && (
          <>
            <h2>Invite your first teammate</h2>
            <div className="hint">
              Generate a single-use PIN. Hand the 6 characters to the
              teammate — they paste it into the FrameCAD desktop's
              "Enroll with Team" screen and they're in.
            </div>
            {!issuedPinCode ? (
              <>
                <label>Role</label>
                <select
                  value={pinRole}
                  onChange={e => setPinRole(e.target.value as typeof pinRole)}
                >
                  <option value="student">Student</option>
                  <option value="mentor">Mentor</option>
                  <option value="admin">Admin</option>
                </select>
                <label>Display name (optional)</label>
                <input
                  value={pinDisplayName}
                  onChange={e => setPinDisplayName(e.target.value)}
                  placeholder="Jane Smith"
                />
                <label>GitHub username (optional)</label>
                <input
                  value={pinGitHub}
                  onChange={e => setPinGitHub(e.target.value)}
                  placeholder="janesmith"
                />
                <div style={{ marginTop: 14 }}>
                  <CapabilityControls
                    value={pinCaps}
                    onChange={setPinCaps}
                    projects={projects}
                    disabled={busy}
                  />
                </div>
                <div className="wizard-nav">
                  <button className="link" onClick={finish} disabled={busy}>
                    Skip — I'll do this later
                  </button>
                  <button className="primary" onClick={issuePin} disabled={busy}>
                    {busy ? 'Generating…' : 'Generate PIN'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="success" style={{ marginTop: 16 }}>
                  <div style={{ marginBottom: 8 }}>
                    Hand this PIN to your teammate:
                  </div>
                  <span className="tag" style={{ fontSize: 18 }}>{issuedPinCode}</span>
                  <div className="hint" style={{ marginTop: 8 }}>
                    Single-use. Expires in 7 days if not used.
                  </div>
                </div>
                <div className="wizard-nav">
                  <button className="primary" onClick={finish} disabled={busy}>
                    {busy ? 'Finishing…' : 'Finish setup'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

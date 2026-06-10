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
  const [projectDriveFolderId, setProjectDriveFolderId] = useState('')
  const [projectSharedDriveId, setProjectSharedDriveId] = useState('')
  // The team's current Shared-Drive allowlist. The project step appends the
  // new project's Shared Drive to it so clients are actually permitted to
  // reach it (the desktop refuses a Shared Drive that isn't allowlisted).
  const [sharedDriveIds, setSharedDriveIds] = useState('')

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
        return api<{ name: string; gitHubOrg: string; projectPrefix: string; googleSharedDriveIds: string }>(
          'GET', '/api/team'
        )
      })
      .then(t => {
        setTeamName(t.name ?? '')
        setGitHubOrg(t.gitHubOrg ?? '')
        setProjectPrefix(t.projectPrefix ?? '')
        setSharedDriveIds(t.googleSharedDriveIds ?? '')
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
    if (!projectName.trim() || !projectDriveFolderId.trim()) {
      setError('Project name and the Google Drive folder ID are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const folderId = projectDriveFolderId.trim()
      const driveId = projectSharedDriveId.trim()
      // If the project lives in a Shared Drive, add that drive to the team's
      // allowlist FIRST. The desktop refuses to touch a Shared Drive that
      // isn't allowlisted, so registering the project without this would
      // leave it un-joinable. Merge into the existing list (dedup), never
      // replace — re-entering the wizard must not drop other drives.
      if (driveId) {
        const merged = Array.from(new Set(
          sharedDriveIds.split(',').map(s => s.trim()).filter(Boolean).concat(driveId)
        )).join(',')
        if (merged !== sharedDriveIds) {
          await api('PATCH', '/api/admin/team', { googleSharedDriveIds: merged })
          setSharedDriveIds(merged)
        }
      }
      await api('POST', '/api/admin/projects', {
        name: projectName.trim(),
        driveFolderId: folderId,
        sharedDriveId: driveId || undefined,
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
        // Match the copy shown after issue: "Single-use. Expires in
        // 7 days if not used." (server defaults are 3 uses / 24 h).
        ttlMs: 7 * 24 * 3600 * 1000,
        maxUses: 1,
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
              The team name shows up everywhere a member looks — the desktop
              welcome screen and the admin web UI. Storage is your team's
              Google Shared Drive; you'll point at it in the next step.
            </div>
            <label>Team name</label>
            <input
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              placeholder="FRC Team 2129"
              autoFocus
            />
            <label>GitHub org (optional)</label>
            <input
              value={gitHubOrg}
              onChange={e => setGitHubOrg(e.target.value)}
              placeholder="netarcx"
            />
            <div className="hint" style={{ marginTop: 4 }}>
              Only used for the optional "create a repo on GitHub" helper on
              the Projects page. Leave blank — FrameCAD stores CAD in Google
              Drive, not GitHub.
            </div>
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
              In Google Drive, make a folder for this project inside your
              team's Shared Drive, then paste its folder ID here. Team members
              see this project on the FrameCAD welcome screen and join it
              straight from Drive once they enroll. (The folder ID is the last
              part of the folder's URL:
              <code>drive.google.com/drive/folders/<strong>THIS_ID</strong></code>.)
            </div>
            <label>Project name</label>
            <input
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder="2026 Robot"
              autoFocus
            />
            <label>Google Drive folder ID</label>
            <input
              value={projectDriveFolderId}
              onChange={e => setProjectDriveFolderId(e.target.value)}
              placeholder="the project folder's Drive ID"
              spellCheck={false}
            />
            <label>Shared Drive ID</label>
            <input
              value={projectSharedDriveId}
              onChange={e => setProjectSharedDriveId(e.target.value)}
              placeholder="the Shared Drive the folder lives in"
              spellCheck={false}
            />
            <div className="hint" style={{ marginTop: 4 }}>
              The Shared Drive ID is added to your team's allowlist so clients
              are permitted to reach it — leave blank only if the folder lives
              in a regular My Drive (not recommended for a team).
            </div>
            <div className="wizard-nav">
              <button className="link" onClick={() => setStep('member')}>
                Skip — I'll add projects later
              </button>
              <button
                className="primary"
                onClick={addProject}
                disabled={busy || !projectName.trim() || !projectDriveFolderId.trim()}
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

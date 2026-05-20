import { useState, useEffect } from 'react'
import { ArrowLeft, Users } from 'lucide-react'
import type { CoordinationState, GitHubAuthStatus } from '@shared/types'

interface Props {
  /** 'join' to connect to an existing coordination repo, 'create' to create a new one */
  flow: 'join' | 'create'
  onBack: () => void
  onComplete: () => void
  prefilledUrl?: string | null
}

export default function TeamSetup({ flow, onBack, onComplete, prefilledUrl }: Props) {
  const [repoUrl, setRepoUrl] = useState(prefilledUrl || '')
  const [teamName, setTeamName] = useState('')
  const [org, setOrg] = useState('')
  const [projectPrefix, setProjectPrefix] = useState('')
  const [welcomeMessage, setWelcomeMessage] = useState('')
  const [repoName, setRepoName] = useState('framecad-team')
  const [displayName, setDisplayName] = useState('')

  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus | null>(null)
  const [previewState, setPreviewState] = useState<CoordinationState | null>(null)
  const [joinRequested, setJoinRequested] = useState(false)

  useEffect(() => {
    window.api.githubAuthStatus().then(setAuthStatus).catch(() => {})
    window.api.getGitIdentity().then(id => {
      if (id.name) setDisplayName(id.name)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (prefilledUrl) setRepoUrl(prefilledUrl)
  }, [prefilledUrl])

  const handleJoinPreview = async () => {
    const url = repoUrl.trim()
    if (!url) return
    setWorking(true)
    setError(null)
    setStatus('Fetching team info...')
    try {
      const state = await window.api.previewCoordinationRepo(url)
      setPreviewState(state)
      setStatus(null)
    } catch (err) {
      setError((err as Error).message || 'Could not connect to coordination repo')
      setStatus(null)
    } finally {
      setWorking(false)
    }
  }

  const handleRequestJoin = async () => {
    if (!displayName.trim()) {
      setError('Enter your name')
      return
    }
    setWorking(true)
    setError(null)
    setStatus('Connecting to team repo...')
    try {
      await window.api.setupCoordinationRepo(repoUrl.trim())
      setStatus('Submitting join request...')
      const result = await window.api.requestToJoinTeam(displayName.trim())
      if (result.success) {
        setJoinRequested(true)
        setStatus(null)
      } else {
        setError(result.error || 'Could not submit join request')
        setStatus(null)
      }
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    } finally {
      setWorking(false)
    }
  }

  const handleCreate = async () => {
    if (!org.trim()) { setError('Enter your GitHub organization'); return }
    if (!repoName.trim()) { setError('Enter a repo name'); return }
    setWorking(true)
    setError(null)
    setStatus('Creating coordination repo...')
    try {
      const result = await window.api.createCoordinationRepo(org.trim(), repoName.trim())
      if (!result.success) {
        setError(result.error || 'Could not create repo')
        setStatus(null)
        return
      }
      if (teamName.trim() || projectPrefix.trim() || welcomeMessage.trim()) {
        setStatus('Saving team settings...')
        try {
          await window.api.saveTeamConfig({
            teamName: teamName.trim() || org.trim(),
            gitHubOrg: org.trim(),
            projectPrefix: projectPrefix.trim(),
            welcomeMessage: welcomeMessage.trim() || undefined
          })
        } catch {
          setError('Team created, but settings could not be saved. You can configure them later from the Admin Panel.')
        }
      }
      setStatus(null)
      onComplete()
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    } finally {
      setWorking(false)
    }
  }

  if (joinRequested) {
    return (
      <div className="setup-screen">
        <h1>Request Submitted</h1>
        <div className="setup-form" style={{ textAlign: 'center', gap: '1rem' }}>
          <Users size={48} strokeWidth={1.25} style={{ opacity: 0.5, margin: '0 auto' }} />
          <p>Your join request has been sent to the team admins.</p>
          <p className="admin-hint">You'll be able to browse team projects once an admin approves your request. Check back later.</p>
          <div className="actions">
            <button className="toolbar-btn primary" onClick={onComplete}>
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (previewState?.configured && previewState.team) {
    const alreadyMember = previewState.isMember
    return (
      <div className="setup-screen">
        <button className="toolbar-btn back-btn" onClick={onBack}>
          <ArrowLeft size={16} /> Back
        </button>
        <h1>{previewState.team.teamName}</h1>
        {previewState.team.welcomeMessage && (
          <p className="subtitle">{previewState.team.welcomeMessage}</p>
        )}
        <div className="setup-form" style={{ gap: '1rem' }}>
          {alreadyMember ? (
            <>
              <p style={{ color: 'var(--color-success, #22c55e)' }}>You're already a member of this team.</p>
              <div className="actions">
                <button className="toolbar-btn primary" onClick={onComplete}>Continue</button>
              </div>
            </>
          ) : (
            <>
              <p>Enter your name to request to join this team.</p>
              <div className="form-group">
                <label>Your Name</label>
                <input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="e.g. Jane Smith"
                  disabled={working}
                />
              </div>
              {error && <div className="form-error">{error}</div>}
              {status && <div className="admin-hint">{status}</div>}
              <div className="actions">
                <button
                  className="toolbar-btn primary"
                  onClick={handleRequestJoin}
                  disabled={working || !displayName.trim() || !authStatus?.loggedIn}
                >
                  {working ? 'Submitting...' : 'Request to Join'}
                </button>
              </div>
              {!authStatus?.loggedIn && (
                <p className="admin-hint">Sign in to GitHub first to submit a join request.</p>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  if (flow === 'join') {
    return (
      <div className="setup-screen">
        <button className="toolbar-btn back-btn" onClick={onBack}>
          <ArrowLeft size={16} /> Back
        </button>
        <h1>Join a Team</h1>
        <div className="setup-form">
          <div className="form-group">
            <label>Coordination Repo URL</label>
            <input
              value={repoUrl}
              onChange={e => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/framecad-team.git"
              disabled={working}
            />
            <span className="form-hint">Paste the URL your team admin shared with you</span>
          </div>
          {error && <div className="form-error">{error}</div>}
          {status && <div className="admin-hint">{status}</div>}
          <div className="actions">
            <button className="toolbar-btn" onClick={onBack} disabled={working}>Cancel</button>
            <button
              className="toolbar-btn primary"
              onClick={handleJoinPreview}
              disabled={working || !repoUrl.trim()}
            >
              {working ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // flow === 'create'
  return (
    <div className="setup-screen">
      <button className="toolbar-btn back-btn" onClick={onBack}>
        <ArrowLeft size={16} /> Back
      </button>
      <h1>Create a Team</h1>
      <div className="setup-form">
        <div className="form-group">
          <label>GitHub Organization</label>
          <input
            value={org}
            onChange={e => setOrg(e.target.value)}
            placeholder="e.g. frc2129"
            disabled={working}
          />
          <span className="form-hint">The GitHub org where your team's repos live</span>
        </div>
        <div className="form-group">
          <label>Team Name</label>
          <input
            value={teamName}
            onChange={e => setTeamName(e.target.value)}
            placeholder="e.g. FRC Team 2129"
            disabled={working}
          />
        </div>
        <div className="form-group">
          <label>Project Prefix</label>
          <input
            value={projectPrefix}
            onChange={e => setProjectPrefix(e.target.value)}
            placeholder="e.g. 2026-"
            disabled={working}
          />
          <span className="form-hint">Optional prefix for new project repo names</span>
        </div>
        <div className="form-group">
          <label>Welcome Message</label>
          <input
            value={welcomeMessage}
            onChange={e => setWelcomeMessage(e.target.value)}
            placeholder="e.g. Welcome to Southwest Robotics!"
            disabled={working}
          />
        </div>
        <div className="form-group">
          <label>Coordination Repo Name</label>
          <input
            value={repoName}
            onChange={e => setRepoName(e.target.value)}
            placeholder="framecad-team"
            disabled={working}
          />
          <span className="form-hint">Will be created at github.com/{org || '...'}/{repoName}</span>
        </div>
        {error && <div className="form-error">{error}</div>}
        {status && <div className="admin-hint">{status}</div>}
        <div className="actions">
          <button className="toolbar-btn" onClick={onBack} disabled={working}>Cancel</button>
          <button
            className="toolbar-btn primary"
            onClick={handleCreate}
            disabled={working || !org.trim() || !repoName.trim() || !authStatus?.loggedIn}
          >
            {working ? 'Creating...' : 'Create Team'}
          </button>
        </div>
        {!authStatus?.loggedIn && (
          <p className="admin-hint">Sign in to GitHub first to create a team.</p>
        )}
      </div>
    </div>
  )
}

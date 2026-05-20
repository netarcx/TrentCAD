import { useState, useEffect, useCallback } from 'react'
import type { CoordinationState, JoinRequest, MemberRole } from '@shared/types'

export default function MembersPanel() {
  const [coordState, setCoordState] = useState<CoordinationState>({ configured: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  // Manual add form
  const [showAddForm, setShowAddForm] = useState(false)
  const [addUsername, setAddUsername] = useState('')
  const [addDisplayName, setAddDisplayName] = useState('')
  const [addRole, setAddRole] = useState<MemberRole>('student')

  // Add project form
  const [showAddProject, setShowAddProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectUrl, setProjectUrl] = useState('')
  const [projectDesc, setProjectDesc] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const state = await window.api.syncCoordinationRepo()
      setCoordState(state)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const isAdmin = coordState.currentUserRole === 'admin' || coordState.currentUserRole === 'mentor'

  const [currentUsername, setCurrentUsername] = useState<string | null>(null)
  useEffect(() => {
    window.api.githubAuthStatus()
      .then(s => setCurrentUsername(s.username ?? null))
      .catch(() => {})
  }, [])

  const handleApprove = async (req: JoinRequest, role: MemberRole) => {
    setStatus(`Approving ${req.githubUsername}...`)
    setError(null)
    try {
      const result = await window.api.approveJoinRequest(req.githubUsername, req.displayName, role, req.issueNumber)
      if (result.orgInviteFailed) {
        setError(`Member approved in FrameCAD, but the GitHub org invite for @${req.githubUsername} failed. An org admin may need to invite them manually.`)
      }
      setStatus(null)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    }
  }

  const handleDeny = async (req: JoinRequest) => {
    setStatus(`Denying ${req.githubUsername}...`)
    setError(null)
    try {
      await window.api.denyJoinRequest(req.issueNumber)
      setStatus(null)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    }
  }

  const handleRoleChange = async (username: string, newRole: MemberRole) => {
    setError(null)
    try {
      await window.api.updateTeamMember(username, { role: newRole })
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleRemoveMember = async (username: string) => {
    if (!window.confirm(`Remove @${username} from the team?`)) return
    setError(null)
    try {
      await window.api.removeTeamMember(username)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleAddMember = async () => {
    if (!addUsername.trim()) return
    setError(null)
    setStatus('Adding member...')
    try {
      await window.api.addTeamMember({
        githubUsername: addUsername.trim(),
        displayName: addDisplayName.trim() || addUsername.trim(),
        role: addRole,
        status: 'active'
      })
      setAddUsername('')
      setAddDisplayName('')
      setAddRole('student')
      setShowAddForm(false)
      setStatus(null)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    }
  }

  const handleAddProject = async () => {
    if (!projectName.trim() || !projectUrl.trim()) return
    setError(null)
    setStatus('Adding project...')
    try {
      await window.api.addProjectToRegistry({
        name: projectName.trim(),
        repoUrl: projectUrl.trim(),
        description: projectDesc.trim() || undefined
      })
      setProjectName('')
      setProjectUrl('')
      setProjectDesc('')
      setShowAddProject(false)
      setStatus(null)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
      setStatus(null)
    }
  }

  const handleRemoveProject = async (repoUrl: string) => {
    setError(null)
    try {
      await window.api.removeProjectFromRegistry(repoUrl)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect from the coordination repo? You can reconnect later from the welcome screen.')) return
    setError(null)
    try {
      await window.api.disconnectCoordinationRepo()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (loading) {
    return (
      <div className="admin-section">
        <h3>Team Members</h3>
        <p className="admin-hint">Loading coordination state...</p>
      </div>
    )
  }

  if (!coordState.configured) {
    return (
      <div className="admin-section">
        <h3>Team Members</h3>
        <p className="admin-hint">
          No coordination repo connected. Create or join a team from the welcome screen
          to manage team members.
        </p>
      </div>
    )
  }

  const members = coordState.members ?? []
  const pending = coordState.pendingRequests ?? []
  const projects = coordState.projects ?? []

  return (
    <>
      {error && <div className="form-error" style={{ margin: '0 0 1rem' }}>{error}</div>}
      {status && <p className="admin-hint">{status}</p>}

      <div className="admin-section">
        <h3>Coordination Repo</h3>
        <p className="admin-hint" style={{ wordBreak: 'break-all' }}>
          {coordState.repoUrl}
        </p>
        {coordState.lastSyncAt && (
          <p className="admin-hint" style={{ fontSize: '0.75rem', opacity: 0.6 }}>
            Last synced: {new Date(coordState.lastSyncAt).toLocaleString()}
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button className="toolbar-btn" onClick={refresh} disabled={loading}>
            {loading ? 'Syncing...' : 'Sync Now'}
          </button>
          <button className="toolbar-btn" onClick={handleDisconnect} style={{ color: 'var(--color-danger, #ef4444)' }}>
            Disconnect
          </button>
        </div>
      </div>

      {isAdmin && pending.length > 0 && (
        <div className="admin-section">
          <h3>Pending Join Requests ({pending.length})</h3>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>GitHub</th>
                  <th>Requested</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pending.map(req => (
                  <tr key={req.issueNumber}>
                    <td>{req.displayName}</td>
                    <td>@{req.githubUsername}</td>
                    <td>{new Date(req.requestedAt).toLocaleDateString()}</td>
                    <td style={{ display: 'flex', gap: '0.25rem' }}>
                      <button className="toolbar-btn primary" onClick={() => handleApprove(req, 'student')}>
                        Approve
                      </button>
                      <button className="toolbar-btn" onClick={() => handleDeny(req)}>
                        Deny
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="admin-section">
        <h3>Team Members ({members.length})</h3>
        {members.length === 0 ? (
          <p className="admin-hint">No members yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>GitHub</th>
                  <th>Role</th>
                  <th>Joined</th>
                  {isAdmin && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {members.map(m => (
                  <tr key={m.githubUsername}>
                    <td>{m.displayName}</td>
                    <td>@{m.githubUsername}</td>
                    <td>
                      {isAdmin && (!currentUsername || m.githubUsername.toLowerCase() !== currentUsername.toLowerCase()) ? (
                        <select
                          value={m.role}
                          onChange={e => handleRoleChange(m.githubUsername, e.target.value as MemberRole)}
                          style={{ padding: '0.15rem 0.25rem', fontSize: '0.8rem' }}
                        >
                          <option value="admin">Admin</option>
                          <option value="mentor">Mentor</option>
                          <option value="student">Student</option>
                        </select>
                      ) : (
                        m.role
                      )}
                    </td>
                    <td>{new Date(m.joinedAt).toLocaleDateString()}</td>
                    {isAdmin && (
                      <td>
                        {currentUsername && m.githubUsername.toLowerCase() === currentUsername.toLowerCase() ? (
                          <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>You</span>
                        ) : (
                          <button
                            className="toolbar-btn"
                            onClick={() => handleRemoveMember(m.githubUsername)}
                            style={{ color: 'var(--color-danger, #ef4444)', fontSize: '0.75rem' }}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {isAdmin && (
          <>
            {showAddForm ? (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1, minWidth: '120px' }}>
                  <label>GitHub Username</label>
                  <input value={addUsername} onChange={e => setAddUsername(e.target.value)} placeholder="username" />
                </div>
                <div className="form-group" style={{ flex: 1, minWidth: '120px' }}>
                  <label>Display Name</label>
                  <input value={addDisplayName} onChange={e => setAddDisplayName(e.target.value)} placeholder="Jane Smith" />
                </div>
                <div className="form-group" style={{ minWidth: '80px' }}>
                  <label>Role</label>
                  <select value={addRole} onChange={e => setAddRole(e.target.value as MemberRole)}>
                    <option value="student">Student</option>
                    <option value="mentor">Mentor</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <button className="toolbar-btn primary" onClick={handleAddMember} disabled={!addUsername.trim()}>Add</button>
                <button className="toolbar-btn" onClick={() => setShowAddForm(false)}>Cancel</button>
              </div>
            ) : (
              <button className="toolbar-btn" onClick={() => setShowAddForm(true)} style={{ marginTop: '0.5rem' }}>
                + Add Member
              </button>
            )}
          </>
        )}
      </div>

      <div className="admin-section">
        <h3>Project Registry ({projects.length})</h3>
        {projects.length === 0 ? (
          <p className="admin-hint">No projects registered. Add projects so team members can find them easily.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>URL</th>
                  <th>Description</th>
                  {isAdmin && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {projects.map(p => (
                  <tr key={p.repoUrl}>
                    <td>{p.name}</td>
                    <td style={{ wordBreak: 'break-all', fontSize: '0.75rem' }}>
                      {p.repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}
                    </td>
                    <td>{p.description || '—'}</td>
                    {isAdmin && (
                      <td>
                        <button
                          className="toolbar-btn"
                          onClick={() => handleRemoveProject(p.repoUrl)}
                          style={{ color: 'var(--color-danger, #ef4444)', fontSize: '0.75rem' }}
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {isAdmin && (
          <>
            {showAddProject ? (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1, minWidth: '120px' }}>
                  <label>Project Name</label>
                  <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="2026 Robot" />
                </div>
                <div className="form-group" style={{ flex: 2, minWidth: '200px' }}>
                  <label>Repo URL</label>
                  <input value={projectUrl} onChange={e => setProjectUrl(e.target.value)} placeholder="https://github.com/org/repo.git" />
                </div>
                <div className="form-group" style={{ flex: 1, minWidth: '120px' }}>
                  <label>Description</label>
                  <input value={projectDesc} onChange={e => setProjectDesc(e.target.value)} placeholder="Optional" />
                </div>
                <button className="toolbar-btn primary" onClick={handleAddProject} disabled={!projectName.trim() || !projectUrl.trim()}>Add</button>
                <button className="toolbar-btn" onClick={() => setShowAddProject(false)}>Cancel</button>
              </div>
            ) : (
              <button className="toolbar-btn" onClick={() => setShowAddProject(true)} style={{ marginTop: '0.5rem' }}>
                + Add Project
              </button>
            )}
          </>
        )}
      </div>
    </>
  )
}

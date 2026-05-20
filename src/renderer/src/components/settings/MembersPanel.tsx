import { useState, useEffect, useCallback } from 'react'
import type { CoordinationState, JoinRequest, MemberRole } from '@shared/types'

export default function MembersPanel() {
  const [coordState, setCoordState] = useState<CoordinationState>({ configured: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [addUsername, setAddUsername] = useState('')
  const [addDisplayName, setAddDisplayName] = useState('')
  const [addRole, setAddRole] = useState<MemberRole>('student')

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

  if (loading) {
    return (
      <div className="admin-section">
        <h3>Team Members</h3>
        <p className="admin-hint">Loading...</p>
      </div>
    )
  }

  if (!coordState.configured) {
    return (
      <div className="admin-section">
        <h3>Team Members</h3>
        <p className="admin-hint">
          No coordination repo connected. Set one up in Team Settings
          to manage team members.
        </p>
      </div>
    )
  }

  const members = coordState.members ?? []
  const pending = coordState.pendingRequests ?? []

  return (
    <>
      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
      {status && <p className="admin-hint">{status}</p>}

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
                    <td style={{ display: 'flex', gap: 4 }}>
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
                          style={{ padding: '2px 4px', fontSize: 12 }}
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
                          <span style={{ fontSize: 11, opacity: 0.5 }}>You</span>
                        ) : (
                          <button
                            className="toolbar-btn"
                            onClick={() => handleRemoveMember(m.githubUsername)}
                            style={{ color: 'var(--red)', fontSize: 11 }}
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
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1, minWidth: 120 }}>
                  <label>GitHub Username</label>
                  <input value={addUsername} onChange={e => setAddUsername(e.target.value)} placeholder="username" />
                </div>
                <div className="form-group" style={{ flex: 1, minWidth: 120 }}>
                  <label>Display Name</label>
                  <input value={addDisplayName} onChange={e => setAddDisplayName(e.target.value)} placeholder="Jane Smith" />
                </div>
                <div className="form-group" style={{ minWidth: 80 }}>
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
              <button className="toolbar-btn" onClick={() => setShowAddForm(true)} style={{ marginTop: 8 }}>
                + Add Member
              </button>
            )}
          </>
        )}
      </div>
    </>
  )
}

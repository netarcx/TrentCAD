import { useState, useEffect, useCallback } from 'react'
import type { CoordinationState } from '@shared/types'

interface Props {
  /** Mentors and admins can add/remove projects from the registry. */
  isMentor: boolean
}

export default function ProjectsPanel({ isMentor }: Props) {
  const [coordState, setCoordState] = useState<CoordinationState>({ configured: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

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

  const canEdit = isMentor

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

  if (loading) {
    return (
      <div className="admin-section">
        <h3>Project Registry</h3>
        <p className="admin-hint">Loading...</p>
      </div>
    )
  }

  if (!coordState.configured) {
    return (
      <div className="admin-section">
        <h3>Project Registry</h3>
        <p className="admin-hint">
          No coordination repo connected. Set one up in Team Settings
          to manage projects.
        </p>
      </div>
    )
  }

  const projects = coordState.projects ?? []

  return (
    <>
      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
      {status && <p className="admin-hint">{status}</p>}

      <div className="admin-section">
        <h3>Project Registry ({projects.length})</h3>
        <p className="admin-hint">
          Projects listed here appear on the welcome screen so team members can find and join them.
        </p>
        {projects.length === 0 ? (
          <p className="admin-hint">No projects registered yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>URL</th>
                  <th>Description</th>
                  {canEdit &&<th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {projects.map(p => (
                  <tr key={p.repoUrl}>
                    <td>{p.name}</td>
                    <td style={{ wordBreak: 'break-all', fontSize: 11 }}>
                      {p.repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}
                    </td>
                    <td>{p.description || '—'}</td>
                    {canEdit &&(
                      <td>
                        <button
                          className="toolbar-btn"
                          onClick={() => handleRemoveProject(p.repoUrl)}
                          style={{ color: 'var(--red)', fontSize: 11 }}
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
        {canEdit &&(
          <>
            {showAddProject ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1, minWidth: 120 }}>
                  <label>Project Name</label>
                  <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="2026 Robot" />
                </div>
                <div className="form-group" style={{ flex: 2, minWidth: 200 }}>
                  <label>Repo URL</label>
                  <input value={projectUrl} onChange={e => setProjectUrl(e.target.value)} placeholder="https://github.com/org/repo.git" />
                </div>
                <div className="form-group" style={{ flex: 1, minWidth: 120 }}>
                  <label>Description</label>
                  <input value={projectDesc} onChange={e => setProjectDesc(e.target.value)} placeholder="Optional" />
                </div>
                <button className="toolbar-btn primary" onClick={handleAddProject} disabled={!projectName.trim() || !projectUrl.trim()}>Add</button>
                <button className="toolbar-btn" onClick={() => setShowAddProject(false)}>Cancel</button>
              </div>
            ) : (
              <button className="toolbar-btn" onClick={() => setShowAddProject(true)} style={{ marginTop: 8 }}>
                + Add Project
              </button>
            )}
          </>
        )}
      </div>
    </>
  )
}

import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'

interface Project {
  id: number
  name: string
  /** Google Drive folder id — the canonical per-project key. */
  driveFolderId: string | null
  description: string
  createdAt: number
}

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [driveFolderId, setDriveFolderId] = useState('')
  const [sharedDriveId, setSharedDriveId] = useState('')
  const [description, setDescription] = useState('')

  async function load(): Promise<void> {
    try {
      const res = await api<{ projects: Project[] }>('GET', '/api/admin/projects')
      setProjects(res.projects)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  useEffect(() => { load() }, [])

  async function add(): Promise<void> {
    if (!name.trim() || !driveFolderId.trim()) {
      setError('Name and the Google Drive folder ID are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api('POST', '/api/admin/projects', {
        name,
        driveFolderId: driveFolderId.trim(),
        sharedDriveId: sharedDriveId.trim() || undefined,
        description,
      })
      setName(''); setDriveFolderId(''); setSharedDriveId(''); setDescription('')
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(p: Project): Promise<void> {
    const msg = `Remove "${p.name}" from the project registry?\n\nThis only removes the server-side record. Team members still have local copies in their FrameCAD folder — remind them to back up anything they want and delete the local folder themselves.`
    if (!confirm(msg)) return
    setError(null)
    try {
      await api('DELETE', `/api/admin/projects/${p.id}`)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  return (
    <>
      <h1>Projects</h1>
      <div className="sub">{projects.length} registered project{projects.length === 1 ? '' : 's'}</div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>Register a project</h3>
        <div className="hint">
          Point the team at a folder in your Google Shared Drive. Listed
          projects appear on the FrameCAD welcome screen so team members can
          find and join them.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          <div>
            <label>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="2026 Robot" />
          </div>
          <div>
            <label>Google Drive folder ID</label>
            <input value={driveFolderId} onChange={e => setDriveFolderId(e.target.value)} placeholder="the project folder's Drive id" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
          <div>
            <label>Shared Drive ID (optional)</label>
            <input value={sharedDriveId} onChange={e => setSharedDriveId(e.target.value)} placeholder="the Shared Drive the folder lives in" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
          <div>
            <label>Description (optional)</label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Main competition robot" />
          </div>
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="primary" onClick={add} disabled={busy || !name.trim() || !driveFolderId.trim()}>
            {busy ? 'Adding…' : 'Add Drive project'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Registered projects</h3>
        {projects.length === 0 ? (
          <div className="hint">No projects registered yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Drive folder</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map(p => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    {p.description && (
                      <div className="hint" style={{ marginTop: 2 }}>
                        {p.description}
                      </div>
                    )}
                  </td>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>
                    {p.driveFolderId
                      ? `Drive · ${p.driveFolderId}`
                      : <span className="hint">—</span>}
                  </td>
                  <td className="row-actions">
                    <button className="secondary danger" onClick={() => remove(p)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

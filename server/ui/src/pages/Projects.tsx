import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'

interface Project {
  id: number
  name: string
  repoUrl: string
  description: string
  createdAt: number
}

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [description, setDescription] = useState('')

  async function load(): Promise<void> {
    try {
      const res = await api<{ projects: Project[] }>('GET', '/api/projects')
      setProjects(res.projects)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  useEffect(() => { load() }, [])

  async function add(): Promise<void> {
    if (!name.trim() || !repoUrl.trim()) {
      setError('Name and repo URL are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api('POST', '/api/admin/projects', { name, repoUrl, description })
      setName(''); setRepoUrl(''); setDescription('')
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(p: Project): Promise<void> {
    if (!confirm(`Remove "${p.name}" from the project registry?`)) return
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
          Listed projects appear on the FrameCAD welcome screen so team
          members can find and join them.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          <div>
            <label>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="2026 Robot" />
          </div>
          <div>
            <label>Repo URL</label>
            <input value={repoUrl} onChange={e => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo.git" />
          </div>
        </div>
        <label>Description (optional)</label>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Main competition robot" />
        <div style={{ marginTop: 14 }}>
          <button className="primary" onClick={add} disabled={busy || !name.trim() || !repoUrl.trim()}>
            {busy ? 'Adding…' : 'Add project'}
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
              <tr><th>Name</th><th>Repo</th><th>Description</th><th></th></tr>
            </thead>
            <tbody>
              {projects.map(p => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>
                    {p.repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}
                  </td>
                  <td>{p.description || <span className="hint">—</span>}</td>
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

import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'

interface Project {
  id: number
  name: string
  repoUrl: string
  description: string
  createdAt: number
  quotaBytes: number | null
  storageBytes: number
  storageScannedAt: number
}

/** 10 GiB — matches DEFAULT_PROJECT_QUOTA_BYTES on the server. Kept
 *  in sync by convention; if the server default changes, bump this
 *  too so the form pre-fills the same number the backend would. */
const DEFAULT_QUOTA_GB = 10

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [description, setDescription] = useState('')
  // Quota for the project being created. UI works in GB; the wire
  // format is bytes. Empty string = "unlimited".
  const [quotaGb, setQuotaGb] = useState<string>(String(DEFAULT_QUOTA_GB))
  // Per-row state for the inline quota editor (which project is
  // being edited and what the staged value is). Only one row can be
  // editing at a time.
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null)

  async function load(): Promise<void> {
    try {
      // Use /api/admin/projects which carries quota + storage; the
      // public /api/projects strips those for student callers.
      const res = await api<{ projects: Project[] }>('GET', '/api/admin/projects')
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
      // Empty quota field = unlimited (send null). Otherwise convert
      // GB → bytes and round, so the server stores an integer.
      const parsedGb = quotaGb.trim() === '' ? null : Number.parseFloat(quotaGb)
      if (parsedGb !== null && (!Number.isFinite(parsedGb) || parsedGb < 0)) {
        setError('Quota must be a non-negative number or blank')
        setBusy(false)
        return
      }
      const quotaBytes = parsedGb === null ? null : Math.round(parsedGb * 1024 * 1024 * 1024)
      await api('POST', '/api/admin/projects', { name, repoUrl, description, quotaBytes })
      setName(''); setRepoUrl(''); setDescription('')
      setQuotaGb(String(DEFAULT_QUOTA_GB))
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

  async function saveQuota(p: Project): Promise<void> {
    if (!editing || editing.id !== p.id) return
    setError(null)
    try {
      const parsedGb = editing.value.trim() === '' ? null : Number.parseFloat(editing.value)
      if (parsedGb !== null && (!Number.isFinite(parsedGb) || parsedGb < 0)) {
        setError('Quota must be a non-negative number or blank')
        return
      }
      const quotaBytes = parsedGb === null ? null : Math.round(parsedGb * 1024 * 1024 * 1024)
      await api('PATCH', `/api/admin/projects/${p.id}`, { quotaBytes })
      setEditing(null)
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
          members can find and join them. The storage quota caps how much
          CAD data this project can push to the team's self-hosted LFS
          server — leave blank for unlimited.
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
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <div>
            <label>Description (optional)</label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Main competition robot" />
          </div>
          <div>
            <label>Storage quota (GB)</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={quotaGb}
              onChange={e => setQuotaGb(e.target.value)}
              placeholder="blank = unlimited"
            />
          </div>
        </div>
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
              <tr>
                <th>Name</th>
                <th>Repo</th>
                <th>Storage</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map(p => {
                const pct =
                  p.quotaBytes && p.quotaBytes > 0
                    ? Math.min(100, (p.storageBytes / p.quotaBytes) * 100)
                    : null
                const over = pct !== null && pct >= 100
                const warn = pct !== null && pct >= 80 && pct < 100
                const isEditing = editing?.id === p.id
                return (
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
                      {p.repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}
                    </td>
                    <td style={{ minWidth: 220 }}>
                      {isEditing ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={editing!.value}
                            onChange={e => setEditing({ id: p.id, value: e.target.value })}
                            style={{ width: 100 }}
                            placeholder="GB"
                            autoFocus
                          />
                          <button className="secondary" onClick={() => saveQuota(p)}>Save</button>
                          <button className="link" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      ) : (
                        <div>
                          <div style={{ fontSize: 12, marginBottom: 4 }}>
                            <span className="mono">{formatBytes(p.storageBytes)}</span>
                            {p.quotaBytes !== null ? (
                              <>
                                {' '}/ <span className="mono">{formatBytes(p.quotaBytes)}</span>
                              </>
                            ) : (
                              <span className="hint"> / unlimited</span>
                            )}
                            <button
                              className="link"
                              onClick={() => setEditing({
                                id: p.id,
                                value: p.quotaBytes === null
                                  ? ''
                                  : (p.quotaBytes / 1024 / 1024 / 1024).toFixed(1),
                              })}
                              style={{ marginLeft: 8, fontSize: 11 }}
                            >
                              edit
                            </button>
                          </div>
                          {pct !== null && (
                            <div className="quota-bar">
                              <div
                                className={`quota-fill${over ? ' over' : warn ? ' warn' : ''}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                          {over && (
                            <div className="hint" style={{ color: 'var(--red)', marginTop: 4 }}>
                              Over quota — new uploads blocked
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="row-actions">
                      <button className="secondary danger" onClick={() => remove(p)}>Remove</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

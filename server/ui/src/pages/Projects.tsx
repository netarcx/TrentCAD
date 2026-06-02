import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { copyToClipboard } from '../lib/copyToClipboard'

interface Project {
  id: number
  name: string
  repoUrl: string
  /** Google Drive folder id when this is a Drive project; null for
   *  legacy GitHub-only rows. The canonical per-project key. */
  driveFolderId?: string | null
  description: string
  createdAt: number
  quotaBytes: number | null
  storageBytes: number
  storageScannedAt: number
  remoteStatus: 'unknown' | 'ok' | 'missing'
  remoteCheckedAt: number | null
}

type RemoteCheckResult = { status: 'ok' | 'missing' | 'error'; detail: string | null; checkedAt: number }

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
  const [driveFolderId, setDriveFolderId] = useState('')
  const [sharedDriveId, setSharedDriveId] = useState('')
  const [description, setDescription] = useState('')
  // Quota for the project being created. UI works in GB; the wire
  // format is bytes. Empty string = "unlimited".
  const [quotaGb, setQuotaGb] = useState<string>(String(DEFAULT_QUOTA_GB))
  // Per-row state for the inline quota editor (which project is
  // being edited and what the staged value is). Only one row can be
  // editing at a time.
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null)
  // Which project's remote-check is in flight (we disable the button
  // and show "Checking…" so the admin doesn't think the click did
  // nothing on a slow GitHub).
  const [checkingId, setCheckingId] = useState<number | null>(null)
  // "Create on GitHub" modal state. Distinct from the registration
  // flow above because this one ALSO calls GitHub's repo-create API
  // before inserting locally. Closed when null.
  const [createOnGh, setCreateOnGh] = useState<{
    name: string
    description: string
    private: boolean
    quotaGb: string
  } | null>(null)
  const [creatingOnGh, setCreatingOnGh] = useState(false)
  const [createGhError, setCreateGhError] = useState<string | null>(null)
  const [createGhResult, setCreateGhResult] = useState<{ repoUrl: string; name: string } | null>(null)

  async function submitCreateOnGitHub(): Promise<void> {
    if (!createOnGh) return
    setCreateGhError(null)
    if (!createOnGh.name.trim()) {
      setCreateGhError('Repo name is required.')
      return
    }
    const parsedGb = createOnGh.quotaGb.trim() === '' ? null : Number.parseFloat(createOnGh.quotaGb)
    if (parsedGb !== null && (!Number.isFinite(parsedGb) || parsedGb < 0)) {
      setCreateGhError('Quota must be a non-negative number or blank.')
      return
    }
    setCreatingOnGh(true)
    try {
      const quotaBytes = parsedGb === null ? null : Math.round(parsedGb * 1024 * 1024 * 1024)
      const res = await api<{ name: string; repoUrl: string; private: boolean }>(
        'POST',
        '/api/admin/projects/create-on-github',
        {
          name: createOnGh.name.trim(),
          description: createOnGh.description.trim(),
          private: createOnGh.private,
          quotaBytes,
        },
      )
      // Stash the result so the modal can show the new clone URL
      // (which is what the admin needs to hand to clients). Don't
      // close the modal yet — let the user copy the URL first.
      setCreateGhResult({ repoUrl: res.repoUrl, name: res.name })
      await load()
    } catch (err) {
      setCreateGhError((err as ApiError).message)
    } finally {
      setCreatingOnGh(false)
    }
  }

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
    if (!name.trim() || !driveFolderId.trim()) {
      setError('Name and the Google Drive folder ID are required')
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
      await api('POST', '/api/admin/projects', {
        name,
        driveFolderId: driveFolderId.trim(),
        sharedDriveId: sharedDriveId.trim() || undefined,
        description,
        quotaBytes,
      })
      setName(''); setDriveFolderId(''); setSharedDriveId(''); setDescription('')
      setQuotaGb(String(DEFAULT_QUOTA_GB))
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(p: Project): Promise<void> {
    // Sterner warning when the remote is known-missing — the admin is
    // probably here BECAUSE the repo was deleted, but still worth
    // reminding them that local clones won't be auto-cleaned.
    const msg = p.remoteStatus === 'missing'
      ? `Remove "${p.name}" from the team registry?\n\nThis only removes the server-side record. Team members still have local clones in their FrameCAD folder — remind them to back up anything they want and delete the local folder themselves.`
      : `Remove "${p.name}" from the project registry?`
    if (!confirm(msg)) return
    setError(null)
    try {
      await api('DELETE', `/api/admin/projects/${p.id}`)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }


  async function checkRemote(p: Project): Promise<void> {
    setCheckingId(p.id)
    setError(null)
    try {
      const res = await api<RemoteCheckResult>(
        'POST', `/api/admin/projects/${p.id}/check-remote`,
      )
      // Re-fetch the projects list so the row reflects the latest
      // remoteStatus + remoteCheckedAt without having to merge
      // partial state ourselves. Cheap query.
      await load()
      if (res.status === 'error') {
        setError(`Couldn't reach GitHub to check "${p.name}": ${res.detail}`)
      }
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setCheckingId(null)
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
          CAD data this project can store in Google Drive — leave blank
          for unlimited.
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
        <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="primary" onClick={add} disabled={busy || !name.trim() || !driveFolderId.trim()}>
            {busy ? 'Adding…' : 'Add Drive project'}
          </button>
          <button
            className="secondary"
            onClick={() => setCreateOnGh({
              name: '',
              description: '',
              private: true,
              quotaGb: String(DEFAULT_QUOTA_GB),
            })}
          >
            Create new repo on GitHub…
          </button>
        </div>
      </div>

      {createOnGh && (
        <div className="modal-backdrop" onClick={() => { if (!creatingOnGh) { setCreateOnGh(null); setCreateGhError(null); setCreateGhResult(null) } }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ minWidth: 480 }}>
            {createGhResult ? (
              <>
                <h2>Repo created</h2>
                <div className="hint" style={{ marginBottom: 10 }}>
                  GitHub created <strong>{createGhResult.name}</strong>. The
                  clone URL below is also registered as a FrameCAD project,
                  so it'll show up on the welcome screen for everyone.
                </div>
                <input
                  readOnly
                  className="mono"
                  value={createGhResult.repoUrl}
                  onFocus={e => e.currentTarget.select()}
                  onClick={e => (e.currentTarget as HTMLInputElement).select()}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <button
                    className="secondary"
                    onClick={async () => {
                      await copyToClipboard(createGhResult.repoUrl)
                    }}
                  >
                    Copy URL
                  </button>
                  <button
                    className="primary"
                    onClick={() => { setCreateOnGh(null); setCreateGhError(null); setCreateGhResult(null) }}
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Create new repo on GitHub</h2>
                <div className="hint" style={{ marginBottom: 10 }}>
                  Creates a new repo in your team's GitHub org using the
                  stored PAT and registers it as a FrameCAD project. Repo
                  is created empty — desktop clients push the initial
                  commit on first publish.
                </div>
                {createGhError && <div className="error">{createGhError}</div>}
                <label>Repo name</label>
                <input
                  value={createOnGh.name}
                  onChange={e => setCreateOnGh({ ...createOnGh, name: e.target.value })}
                  placeholder="2026-robot"
                  autoFocus
                  spellCheck={false}
                />
                <label>Description (optional)</label>
                <input
                  value={createOnGh.description}
                  onChange={e => setCreateOnGh({ ...createOnGh, description: e.target.value })}
                  placeholder="Main competition robot"
                />
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}
                >
                  <input
                    type="checkbox"
                    checked={createOnGh.private}
                    onChange={e => setCreateOnGh({ ...createOnGh, private: e.target.checked })}
                  />
                  Private (recommended for team CAD)
                </label>
                <label style={{ marginTop: 10 }}>Storage quota (GB)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={createOnGh.quotaGb}
                  onChange={e => setCreateOnGh({ ...createOnGh, quotaGb: e.target.value })}
                  placeholder="blank = unlimited"
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <button
                    className="secondary"
                    onClick={() => { setCreateOnGh(null); setCreateGhError(null) }}
                    disabled={creatingOnGh}
                  >
                    Cancel
                  </button>
                  <button
                    className="primary"
                    onClick={submitCreateOnGitHub}
                    disabled={creatingOnGh || !createOnGh.name.trim()}
                  >
                    {creatingOnGh ? 'Creating…' : 'Create repo'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
                <th>Remote</th>
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
                      {p.driveFolderId
                        ? `Drive · ${p.driveFolderId}`
                        : p.repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}
                    </td>
                    <td style={{ minWidth: 130 }}>
                      {p.driveFolderId ? (
                        <span className="hint" style={{ fontSize: 11 }}>n/a — Drive project</span>
                      ) : (<>
                      {p.remoteStatus === 'missing' ? (
                        <div>
                          <span
                            className="pill"
                            style={{ color: 'var(--red)', background: 'var(--red-tint)' }}
                            title="GitHub returned 404 — repo is deleted or private"
                          >
                            DELETED
                          </span>
                          <div className="hint" style={{ marginTop: 4, fontSize: 11 }}>
                            Ask the team to back up + delete their local folders.
                          </div>
                        </div>
                      ) : p.remoteStatus === 'ok' ? (
                        <span
                          className="pill"
                          style={{ color: 'var(--green)', background: 'rgba(134, 239, 172, 0.15)' }}
                          title={p.remoteCheckedAt
                            ? `Last checked ${new Date(p.remoteCheckedAt).toLocaleString()}`
                            : 'Reachable'}
                        >
                          OK
                        </span>
                      ) : (
                        <span className="hint" style={{ fontSize: 11 }}>not checked</span>
                      )}
                      <div style={{ marginTop: 4 }}>
                        <button
                          className="link"
                          style={{ fontSize: 11 }}
                          onClick={() => checkRemote(p)}
                          disabled={checkingId === p.id}
                        >
                          {checkingId === p.id ? 'Checking…' : 'Check now'}
                        </button>
                      </div>
                      </>)}
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

import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'

interface Team {
  name: string
  githubOrg: string
  projectPrefix: string
  welcomeMessage: string
}

export default function TeamSettings() {
  const [team, setTeam] = useState<Team>({ name: '', githubOrg: '', projectPrefix: '', welcomeMessage: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    api<Team>('GET', '/api/team')
      .then(setTeam)
      .catch(err => setError((err as ApiError).message))
  }, [])

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await api('PATCH', '/api/admin/team', team)
      setStatus('Saved. Connected clients pick this up on their next sync.')
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Team Settings</h1>
      <div className="sub">Server-wide configuration that every client sees.</div>

      {error && <div className="error">{error}</div>}
      {status && <div className="success">{status}</div>}

      <div className="card">
        <h3>Identity</h3>
        <label>Team name</label>
        <input value={team.name} onChange={e => setTeam({ ...team, name: e.target.value })} placeholder="FRC Team 2129" />

        <label>Welcome message</label>
        <textarea
          rows={3}
          value={team.welcomeMessage}
          onChange={e => setTeam({ ...team, welcomeMessage: e.target.value })}
          placeholder="Optional message shown on the FrameCAD welcome screen"
        />
      </div>

      <div className="card">
        <h3>GitHub Browse</h3>
        <div className="hint">
          When set, members see a "Browse Projects" button on the welcome
          screen listing repos in this org that match the prefix. New
          projects use the prefix automatically.
        </div>
        <label>GitHub organization</label>
        <input value={team.githubOrg} onChange={e => setTeam({ ...team, githubOrg: e.target.value })} placeholder="netarcx" />

        <label>Project name prefix</label>
        <input value={team.projectPrefix} onChange={e => setTeam({ ...team, projectPrefix: e.target.value })} placeholder="framecad-" />
      </div>

      <div style={{ marginTop: 18 }}>
        <button className="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </>
  )
}

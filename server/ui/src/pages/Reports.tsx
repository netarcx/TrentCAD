import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'

interface IssueReport {
  id: number
  memberId: number | null
  reporterName: string
  message: string
  appVersion: string | null
  platform: string | null
  status: 'open' | 'resolved'
  createdAt: number
}

/**
 * Problem reports submitted from the desktop's error-banner "Report" button
 * (POST /api/issues). Open reports float to the top; resolve to triage,
 * delete to clear. Reports live here (and optionally a chat webhook, if
 * FRAMECAD_ISSUE_WEBHOOK_URL set).
 */
export default function Reports() {
  const [issues, setIssues] = useState<IssueReport[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showResolved, setShowResolved] = useState(false)

  async function load(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await api<{ issues: IssueReport[] }>('GET', '/api/admin/issues')
      setIssues(res.issues)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  async function setStatus(r: IssueReport, status: 'open' | 'resolved'): Promise<void> {
    setError(null)
    try {
      await api('PATCH', `/api/admin/issues/${r.id}`, { status })
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  async function remove(r: IssueReport): Promise<void> {
    if (!confirm(`Delete report #${r.id} from ${r.reporterName}?`)) return
    setError(null)
    try {
      await api('DELETE', `/api/admin/issues/${r.id}`)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  const visible = issues.filter(i => showResolved || i.status === 'open')
  const openCount = issues.filter(i => i.status === 'open').length

  return (
    <>
      <h1>Reports</h1>
      <div className="sub">
        {openCount} open report{openCount === 1 ? '' : 's'} · submitted from the desktop “Report” button
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <button className="secondary" onClick={load} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={showResolved}
              onChange={e => setShowResolved(e.target.checked)}
            />
            Show resolved
          </label>
        </div>

        {visible.length === 0 ? (
          <div className="hint">No {showResolved ? '' : 'open '}reports. 🎉</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visible.map(r => (
              <div
                key={r.id}
                className="card"
                style={{ margin: 0, opacity: r.status === 'resolved' ? 0.6 : 1 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div>
                    <strong>#{r.id}</strong> · {r.reporterName}
                    {r.status === 'resolved' && (
                      <span className="pill" style={{ marginLeft: 8, color: 'var(--green)', background: 'rgba(134, 239, 172, 0.15)' }}>
                        resolved
                      </span>
                    )}
                  </div>
                  <div className="hint" style={{ fontSize: 11 }}>
                    {new Date(r.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 2, fontSize: 11 }}>
                  {[r.appVersion && `v${r.appVersion}`, r.platform].filter(Boolean).join(' · ') || 'no client metadata'}
                </div>
                <pre
                  className="mono"
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8, marginBottom: 8, maxHeight: 240, overflow: 'auto' }}
                >
                  {r.message}
                </pre>
                <div style={{ display: 'flex', gap: 8 }}>
                  {r.status === 'open' ? (
                    <button className="secondary" onClick={() => setStatus(r, 'resolved')}>Mark resolved</button>
                  ) : (
                    <button className="link" onClick={() => setStatus(r, 'open')}>Reopen</button>
                  )}
                  <button className="secondary danger" onClick={() => remove(r)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

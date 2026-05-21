import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import CapabilityControls from '../components/CapabilityControls'
import {
  EMPTY_CAPABILITY_VALUE,
  capCount,
  type CapabilityValue,
  type MemberCapabilities,
  type ProjectOption,
} from '../caps'

interface PinRow {
  code: string
  role: 'admin' | 'mentor' | 'student'
  displayName: string | null
  githubUsername: string | null
  expiresAt: number | null
  createdAt: number
  capabilities: MemberCapabilities
  allowedProjectIds: number[]
  autoOpenProjectId: number | null
  kioskMode: boolean
}

interface IssuedPin {
  code: string
  role: PinRow['role']
  expiresAt: number | null
}

function relExpiry(ts: number | null): string {
  if (ts === null) return 'never'
  const diff = ts - Date.now()
  if (diff <= 0) return 'expired'
  if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`
  return `in ${Math.floor(diff / 86_400_000)}d`
}

export default function Pins() {
  const [pins, setPins] = useState<PinRow[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Form
  const [role, setRole] = useState<PinRow['role']>('student')
  const [displayName, setDisplayName] = useState('')
  const [githubUsername, setGithubUsername] = useState('')
  const [caps, setCaps] = useState<CapabilityValue>(EMPTY_CAPABILITY_VALUE)
  const [justIssued, setJustIssued] = useState<IssuedPin | null>(null)
  // Toggle the just-issued PIN display between the new full-URL form
  // (default — matches the desktop's paste-link wizard) and the
  // legacy bare 6-char code. Resets to 'url' on every fresh issuance.
  const [linkView, setLinkView] = useState<'url' | 'pin'>('url')

  async function load(): Promise<void> {
    try {
      const [pinsRes, projectsRes] = await Promise.all([
        api<{ pins: PinRow[] }>('GET', '/api/admin/pins'),
        api<{ projects: ProjectOption[] }>('GET', '/api/projects'),
      ])
      setPins(pinsRes.pins)
      setProjects(projectsRes.projects)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  useEffect(() => { load() }, [])

  async function issue(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await api<IssuedPin>('POST', '/api/admin/pins', {
        role,
        displayName: displayName.trim() || undefined,
        githubUsername: githubUsername.trim() || undefined,
        capabilities: caps.capabilities,
        allowedProjectIds: caps.allowedProjectIds,
        autoOpenProjectId: caps.autoOpenProjectId,
        kioskMode: caps.kioskMode,
      })
      setJustIssued(res)
      setLinkView('url')
      setDisplayName('')
      setGithubUsername('')
      setCaps(EMPTY_CAPABILITY_VALUE)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(code: string): Promise<void> {
    if (!confirm(`Revoke PIN ${code}? Anyone holding it won't be able to use it.`)) return
    setError(null)
    try {
      await api('DELETE', `/api/admin/pins/${code}`)
      await load()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  // navigator.clipboard.writeText only works in a secure context
  // (HTTPS or http://localhost). When the admin opens this UI on a
  // LAN IP like http://10.0.0.5:42130 — which is the standard
  // school-server deployment — the API throws and any catch{} that
  // swallows the error leaves the clipboard holding whatever was in
  // it before, which looks like the copy "worked" but produced
  // garbage. Try the modern API, fall back to the legacy textarea +
  // execCommand path (works over plain HTTP), and surface failure so
  // the admin knows when nothing happened.
  async function copyToClipboard(code: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(code)
        return true
      } catch { /* fall through to legacy path */ }
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = code
      // Keep the textarea off-screen and unfocusable for accessibility
      // but still in the DOM so select() + execCommand can see it.
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      ta.setAttribute('readonly', '')
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }

  /** Which copy button (if any) is currently showing the "Copied!"
   *  feedback. Keyed by PIN code so we can highlight a specific row
   *  without flashing every row. `'__failed__'` is a sentinel for the
   *  error state. */
  const [copyState, setCopyState] = useState<{ code: string; ok: boolean } | null>(null)

  async function handleCopy(code: string): Promise<void> {
    const ok = await copyToClipboard(code)
    setCopyState({ code, ok })
    setTimeout(() => {
      setCopyState(curr => (curr?.code === code ? null : curr))
    }, 2000)
  }

  return (
    <>
      <h1>Enrollment PINs</h1>
      <div className="sub">Generate a single-use code; hand it to the person enrolling.</div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>Generate new PIN</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <label>Role</label>
            <select value={role} onChange={e => setRole(e.target.value as PinRow['role'])}>
              <option value="student">Student</option>
              <option value="mentor">Mentor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div>
            <label>Display name (optional)</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Jane Smith" />
          </div>
          <div>
            <label>GitHub username (optional)</label>
            <input value={githubUsername} onChange={e => setGithubUsername(e.target.value)} placeholder="janesmith" />
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <CapabilityControls
            value={caps}
            onChange={setCaps}
            projects={projects}
            disabled={busy}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <button className="primary" disabled={busy} onClick={issue}>
            {busy ? 'Issuing…' : 'Generate PIN'}
          </button>
          {capCount(caps.capabilities) === 0 && (
            <span className="hint" style={{ marginLeft: 10 }}>
              ⚠ No home-screen buttons enabled — the enrollee will see only the
              Settings button. (Click an option above to grant access.)
            </span>
          )}
        </div>

        {justIssued && (() => {
          // Build the full enrollment URL the same way the desktop
          // wizard expects it: `<server-origin>/enroll/<PIN>`. Uses
          // window.location.origin because that's whatever URL the
          // admin's browser actually used to reach this server —
          // which is what desktop clients on the same network will
          // also use. NOTE: if the admin opened the UI on localhost
          // but the students will reach the server via a different
          // hostname, the admin should re-open the admin UI from a
          // session on the students' network before grabbing the
          // link.
          const enrollUrl = `${window.location.origin}/enroll/${justIssued.code}`
          return (
            <div className="success" style={{ marginTop: 18 }}>
              <div style={{ marginBottom: 8 }}>
                New {justIssued.role} PIN — expires {relExpiry(justIssued.expiresAt)}. Hand this to the enrollee:
              </div>
              {linkView === 'url' ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <span className="tag mono" style={{ wordBreak: 'break-all', maxWidth: '100%' }}>
                      {enrollUrl}
                    </span>
                    <button className="secondary" onClick={() => handleCopy(enrollUrl)}>
                      {copyState?.code === enrollUrl
                        ? (copyState.ok ? '✓ Copied!' : '✗ Failed')
                        : 'Copy link'}
                    </button>
                    <button className="link" onClick={() => setLinkView('pin')}>
                      Show PIN instead
                    </button>
                    <button className="link" onClick={() => setJustIssued(null)}>Hide</button>
                  </div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    They paste this into FrameCAD desktop's Sync with Team
                    screen — no separate server URL or PIN entry needed.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <span className="tag">{justIssued.code}</span>
                    <button className="secondary" onClick={() => handleCopy(justIssued.code)}>
                      {copyState?.code === justIssued.code
                        ? (copyState.ok ? '✓ Copied!' : '✗ Failed')
                        : 'Copy PIN'}
                    </button>
                    <button className="link" onClick={() => setLinkView('url')}>
                      Show link instead
                    </button>
                    <button className="link" onClick={() => setJustIssued(null)}>Hide</button>
                  </div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    The 6-character PIN is a fallback for clients that
                    don't support pasting the full link.
                  </div>
                </>
              )}
            </div>
          )
        })()}
      </div>

      <div className="card">
        <h3>Active PINs</h3>
        {pins.length === 0 ? (
          <div className="hint">No active PINs. They burn the instant they're used.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Role</th>
                <th>For</th>
                <th>Caps</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pins.map(p => (
                <tr key={p.code}>
                  <td className="mono">{p.code}</td>
                  <td><span className={`pill ${p.role}`}>{p.role}</span></td>
                  <td>
                    {p.displayName || p.githubUsername || <span className="hint">anyone</span>}
                    {p.githubUsername && <span className="mono" style={{ marginLeft: 6, opacity: 0.7 }}>@{p.githubUsername}</span>}
                  </td>
                  <td className="mono" title={JSON.stringify(p.capabilities)}>
                    {capCount(p.capabilities)}/4
                    {p.allowedProjectIds.length > 0 && (
                      <span className="hint" style={{ marginLeft: 6 }}>
                        ({p.allowedProjectIds.length} proj)
                      </span>
                    )}
                    {p.kioskMode && (
                      <span
                        className="pill"
                        style={{ marginLeft: 6, color: 'var(--accent)', background: 'var(--accent-tint)' }}
                        title="Kiosk PIN — enrollee will be locked into the auto-open project"
                      >
                        KIOSK
                      </span>
                    )}
                  </td>
                  <td className="mono">{relExpiry(p.expiresAt)}</td>
                  <td className="row-actions">
                    <button className="secondary" onClick={() => handleCopy(p.code)}>
                      {copyState?.code === p.code
                        ? (copyState.ok ? '✓ Copied!' : '✗ Failed')
                        : 'Copy'}
                    </button>
                    <button className="secondary danger" onClick={() => revoke(p.code)}>Revoke</button>
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

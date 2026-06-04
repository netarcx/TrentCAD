import { useEffect, useState } from 'react'
import { Sun, Moon, RefreshCw, FolderOpen, HardDriveDownload, CheckCircle2, AlertCircle, Clock } from 'lucide-react'
import type { ArchiveStatus, ArchiveProjectStatus, TeamSnapshot } from '@shared/types'
import logoUrl from '../assets/logo.png'

interface Props {
  teamSnapshot: TeamSnapshot | null
  serverReach: 'unknown' | 'reachable' | 'unreachable' | 'not-enrolled'
  gitName: string
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}

const EMPTY_STATUS: ArchiveStatus = {
  active: false,
  archiveRoot: '',
  lastTickAt: null,
  projects: [],
}

function relTime(ts: number | null): string {
  if (ts === null) return 'never'
  const diff = Date.now() - ts
  if (diff < 5_000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function StateBadge({ p }: { p: ArchiveProjectStatus }) {
  switch (p.state) {
    case 'syncing':
      return (
        <span className="archive-state syncing">
          <RefreshCw size={14} className="spin" /> Syncing {p.percent > 0 ? `${p.percent}%` : ''}
        </span>
      )
    case 'idle':
      return <span className="archive-state idle"><CheckCircle2 size={14} /> Up to date</span>
    case 'error':
      return <span className="archive-state error"><AlertCircle size={14} /> Error</span>
    default:
      return <span className="archive-state pending"><Clock size={14} /> Waiting…</span>
  }
}

export default function ArchiveDashboard(props: Props) {
  const { teamSnapshot, serverReach, gitName, theme, onToggleTheme } = props
  const [status, setStatus] = useState<ArchiveStatus>(EMPTY_STATUS)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.archiveGetStatus().then(s => { if (!cancelled) setStatus(s) })
    const unsub = window.api.onArchiveStatus(s => setStatus(s))
    return () => { cancelled = true; unsub() }
  }, [])

  // Keep the relative times ("3m ago") fresh without a server round-trip.
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  async function syncNow(): Promise<void> {
    setBusy(true)
    try { setStatus(await window.api.archiveSyncNow()) }
    finally { setBusy(false) }
  }

  async function chooseRoot(): Promise<void> {
    setBusy(true)
    try { setStatus(await window.api.archiveChooseRoot()) }
    finally { setBusy(false) }
  }

  const teamName = teamSnapshot?.team?.name ?? 'your team'
  const syncing = status.projects.some(p => p.state === 'syncing')
  const errors = status.projects.filter(p => p.state === 'error').length

  return (
    <div className="app archive-app">
      <div className="app-header">
        <div className="logo-home-btn" style={{ cursor: 'default' }}>
          <img className="logo-img" src={logoUrl} alt="FrameCAD" />
          <span className="logo">FrameCAD</span>
        </div>
        <span className="archive-mode-pill">Archive mode</span>
        <span className="project-name-label">{teamName} mirror</span>
        <span className="spacer" />
        {serverReach !== 'not-enrolled' && serverReach !== 'unknown' && (
          <span
            className="status-dot"
            title={serverReach === 'reachable' ? 'Team server reachable' : 'Team server unreachable'}
            style={{ background: serverReach === 'reachable' ? 'var(--green)' : 'var(--red)', marginRight: 4 }}
          />
        )}
        <button
          className="theme-toggle"
          onClick={onToggleTheme}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
        </button>
        <span className="user-badge" title={`Signed in as ${gitName}`}>{gitName}</span>
      </div>

      <div className="archive-body">
        <div className="archive-hero">
          <HardDriveDownload size={28} strokeWidth={1.6} />
          <div>
            <h1>Read-only archive</h1>
            <p>
              This machine continuously mirrors {status.projects.length === 0 ? 'projects' : status.projects.length === 1 ? 'one project' : `${status.projects.length} projects`} from
              Google Drive and never uploads. Updates download automatically when teammates publish.
            </p>
          </div>
          <span className="spacer" />
          <button className="toolbar-btn" onClick={syncNow} disabled={busy || syncing}>
            <RefreshCw size={15} className={syncing ? 'spin' : ''} /> Sync now
          </button>
        </div>

        {status.projects.length === 0 ? (
          <div className="archive-empty">
            No projects assigned to this archive device yet. Ask your admin to add projects to its
            allowlist, then it'll start mirroring automatically.
          </div>
        ) : (
          <div className="archive-grid">
            {status.projects.map(p => (
              <div key={p.projectKey} className={`archive-card ${p.state}`}>
                <div className="archive-card-head">
                  <span className="archive-card-name" title={p.name}>{p.name}</span>
                  <StateBadge p={p} />
                </div>
                {p.state === 'syncing' && (
                  <div className="archive-progress">
                    <div className="archive-progress-fill" style={{ width: `${p.percent}%` }} />
                  </div>
                )}
                <div className="archive-card-meta">
                  <span>{p.fileCount} file{p.fileCount === 1 ? '' : 's'}</span>
                  <span>·</span>
                  <span>synced {relTime(p.lastSyncAt)}</span>
                </div>
                {p.lastError && <div className="archive-card-error">{p.lastError}</div>}
                <div className="archive-card-path" title={p.localPath}>{p.localPath}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="archive-footer">
        <span className="archive-footer-stat">
          {errors > 0
            ? <><AlertCircle size={14} /> {errors} project{errors === 1 ? '' : 's'} with errors</>
            : <><CheckCircle2 size={14} /> {status.projects.length} mirrored</>}
          {status.lastTickAt && <span className="hint"> · last checked {relTime(status.lastTickAt)}</span>}
        </span>
        <span className="spacer" />
        <span className="archive-root" title={status.archiveRoot}>{status.archiveRoot}</span>
        <button className="toolbar-btn secondary" onClick={chooseRoot} disabled={busy}>
          <FolderOpen size={15} /> Change folder…
        </button>
      </div>
    </div>
  )
}

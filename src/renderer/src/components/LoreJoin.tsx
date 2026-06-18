import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import { joinTargetDir } from '@shared/paths'

interface Props {
  /** Back to the welcome screen. */
  onBack: () => void
  /** Clone a `lore://` repo into a local dir and open it as the active
   *  project. Resolves once the project view is ready to show. */
  onJoinLoreProject: (args: { url: string; localPath: string; name: string }) => Promise<void>
  /** True while a clone is in flight — disables the form. */
  isLoading: boolean
  /** Optional pre-filled lore:// URL (e.g. from a team project row). */
  initialUrl?: string
}

/** Last path segment of a lore:// URL → a human project name. */
function nameFromUrl(url: string): string {
  const seg = url.replace(/\/+$/, '').split('/').pop() ?? ''
  return seg || 'lore-project'
}

/** MUST match lore-project.ts slugFromUrl — the folder-name fallback the main
 *  process uses when computing the real clone target, so this preview can't
 *  diverge from where the project actually lands. */
function slugFromUrl(url: string): string {
  const seg = url.replace(/\/+$/, '').split('/').pop() ?? 'lore-project'
  return seg.replace(/[^A-Za-z0-9._-]/g, '-') || 'lore-project'
}

/**
 * Lore "join project" flow (the experiment peer of DriveJoin). One screen:
 * paste the team's `lore://host:port/repo` address, pick a local save folder,
 * Join. Clone progress is surfaced by the App-level join-progress modal (same
 * `join-progress` channel Drive uses), so this component only owns the form up
 * to the moment `onJoinLoreProject` is called.
 */
export default function LoreJoin({ onBack, onJoinLoreProject, isLoading, initialUrl }: Props) {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [savePath, setSavePath] = useState('')
  const [error, setError] = useState<string | null>(null)

  const trimmedUrl = url.trim()
  const validUrl = /^lore:\/\/[^/]+\/.+/.test(trimmedUrl)
  const name = validUrl ? nameFromUrl(trimmedUrl) : ''

  const handleBrowse = async (): Promise<void> => {
    const dir = await window.api.selectDirectory()
    if (dir) setSavePath(dir)
  }

  const handleJoin = async (): Promise<void> => {
    if (!validUrl || !savePath.trim()) return
    setError(null)
    try {
      await onJoinLoreProject({ url: trimmedUrl, localPath: savePath.trim(), name })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="setup-screen">
      <h1>Join from Lore</h1>
      <div className="setup-form">
        <p className="form-hint" style={{ lineHeight: 1.5 }}>
          Enter your team's project address — your admin gives you this. It
          looks like <span className="mono">lore://server.example.com:41337/robot-2026</span>.
          FrameCAD clones the project from your team's Lore server to this
          computer.
        </p>

        <div className="form-group">
          <label>Project address</label>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="lore://host:41337/project"
            disabled={isLoading}
          />
        </div>

        {validUrl && (
          <div className="form-group">
            <label>Save To</label>
            <div className="path-input">
              <input
                value={savePath}
                onChange={e => setSavePath(e.target.value)}
                placeholder="C:\framecad"
                disabled={isLoading}
              />
              <button className="browse-btn" onClick={handleBrowse} disabled={isLoading}>Browse</button>
            </div>
            {savePath.trim() && (
              // Mirrors the main process exactly (same shared helper): a
              // per-project subfolder is created inside the picked location.
              <div className="form-hint" style={{ marginTop: 6 }}>
                Project will be cloned to{' '}
                <span className="mono">{joinTargetDir(savePath.trim(), name, slugFromUrl(trimmedUrl))}</span>
              </div>
            )}
            <div className="form-hint" style={{ marginTop: 6, lineHeight: 1.5 }}>
              <strong>Pro tip:</strong> put the project folder close to the
              drive root (e.g. <span className="mono">C:\framecad\</span>) and
              <strong> never</strong> inside a OneDrive / iCloud / Dropbox
              folder — desktop-sync services fight with FrameCAD's own sync and
              can corrupt files.
            </div>
          </div>
        )}

        {error && <div className="error-msg" style={{ marginTop: 12 }}>{error}</div>}

        <div className="form-actions">
          <button className="toolbar-btn" onClick={onBack} disabled={isLoading}>Back</button>
          <button
            className="toolbar-btn primary"
            disabled={!validUrl || !savePath.trim() || isLoading}
            onClick={handleJoin}
          >
            {isLoading ? <span className="loading-spinner" /> : (
              <><GitBranch size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />Join</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

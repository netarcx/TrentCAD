import { useState, useEffect, useCallback } from 'react'
import { HardDrive, FolderOpen, LogOut, RefreshCw } from 'lucide-react'
import type { GoogleAuthStatus, DriveSharedDrive, DriveFolder } from '@shared/types'

interface Props {
  /** Back to the welcome screen. */
  onBack: () => void
  /** Download a Drive folder into a local dir and open it as the active
   *  project. Resolves once the project view is ready to show. */
  onJoinDriveProject: (args: {
    folderId: string
    sharedDriveId: string
    localPath: string
    name: string
  }) => Promise<void>
  /** True while a join (download) is in flight — disables the form so the
   *  user can't fire a second join over the first. */
  isLoading: boolean
}

/**
 * Google Drive "join project" flow. Four linear steps gated on each
 * other:
 *   1. Sign in to Google (loopback OAuth, handled in the main process).
 *   2. Pick a Shared Drive the account can see.
 *   3. Pick a top-level folder inside it — that folder IS the project.
 *   4. Pick a local save folder, then download.
 *
 * Download progress is surfaced by the App-level join-progress modal
 * (the same one the git clone flow uses), so this component only owns
 * the picker UI up to the moment `onJoinDriveProject` is called.
 */
export default function DriveJoin({ onBack, onJoinDriveProject, isLoading }: Props) {
  const [auth, setAuth] = useState<GoogleAuthStatus | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [drives, setDrives] = useState<DriveSharedDrive[] | null>(null)
  const [loadingDrives, setLoadingDrives] = useState(false)
  const [selectedDrive, setSelectedDrive] = useState<DriveSharedDrive | null>(null)

  const [folders, setFolders] = useState<DriveFolder[] | null>(null)
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(null)

  const [savePath, setSavePath] = useState('')

  // Initial auth probe — cached, no network. If already signed in we
  // jump straight to the Shared Drive picker.
  useEffect(() => {
    window.api.googleAuthStatus()
      .then(setAuth)
      .catch(() => setAuth({ signedIn: false }))
  }, [])

  const loadDrives = useCallback(async () => {
    setLoadingDrives(true)
    setError(null)
    try {
      setDrives(await window.api.driveListSharedDrives())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoadingDrives(false)
    }
  }, [])

  // Once signed in, fetch the Shared Drive list once.
  useEffect(() => {
    if (auth?.signedIn && drives === null && !loadingDrives) {
      loadDrives()
    }
  }, [auth?.signedIn, drives, loadingDrives, loadDrives])

  const handleSignIn = async () => {
    setSigningIn(true)
    setError(null)
    try {
      const status = await window.api.googleSignIn()
      setAuth(status)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSigningIn(false)
    }
  }

  const handleSignOut = async () => {
    try { await window.api.googleSignOut() } catch { /* best effort */ }
    setAuth({ signedIn: false })
    setDrives(null)
    setSelectedDrive(null)
    setFolders(null)
    setSelectedFolder(null)
  }

  const pickDrive = async (drive: DriveSharedDrive) => {
    setSelectedDrive(drive)
    setSelectedFolder(null)
    setFolders(null)
    setLoadingFolders(true)
    setError(null)
    try {
      setFolders(await window.api.driveListFolders(drive.id))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoadingFolders(false)
    }
  }

  const handleBrowse = async () => {
    const dir = await window.api.selectDirectory()
    if (dir) setSavePath(dir)
  }

  const handleJoin = async () => {
    if (!selectedDrive || !selectedFolder || !savePath) return
    setError(null)
    try {
      await onJoinDriveProject({
        folderId: selectedFolder.id,
        sharedDriveId: selectedDrive.id,
        localPath: savePath,
        name: selectedFolder.name
      })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // ── Not signed in: the sign-in gate ──
  if (!auth?.signedIn) {
    return (
      <div className="setup-screen">
        <h1>Join from Google Drive</h1>
        <div className="setup-form">
          <p className="form-hint" style={{ lineHeight: 1.5 }}>
            Sign in with the Google account that has access to your team's
            Shared Drive. FrameCAD opens your browser to Google's sign-in
            page; nothing is stored except a token on this machine.
          </p>
          {error && <div className="error-msg" style={{ marginTop: 12 }}>{error}</div>}
          <div className="form-actions">
            <button className="toolbar-btn" onClick={onBack} disabled={signingIn}>Back</button>
            <button className="toolbar-btn primary" onClick={handleSignIn} disabled={signingIn}>
              {signingIn ? <span className="loading-spinner" /> : 'Sign in with Google'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Signed in: the drive → folder → save-path picker ──
  return (
    <div className="setup-screen">
      <h1>Join from Google Drive</h1>
      <div className="setup-form">
        <div
          className="form-hint"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}
        >
          <span>Signed in as <strong>{auth.email || auth.name || 'Google account'}</strong></span>
          <button className="link-btn" onClick={handleSignOut} title="Sign out of Google">
            <LogOut size={13} strokeWidth={1.75} /> Sign out
          </button>
        </div>

        {/* Step 1 — Shared Drive */}
        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Shared Drive</span>
            <button
              className="link-btn"
              onClick={loadDrives}
              disabled={loadingDrives}
              title="Refresh Shared Drives"
            >
              <RefreshCw size={12} strokeWidth={1.75} /> Refresh
            </button>
          </label>
          {loadingDrives ? (
            <div className="form-hint">Loading Shared Drives…</div>
          ) : drives && drives.length > 0 ? (
            <div className="project-list">
              {drives.map(d => (
                <button
                  key={d.id}
                  type="button"
                  className={'project-list-row' + (selectedDrive?.id === d.id ? ' selected' : '')}
                  onClick={() => pickDrive(d)}
                  disabled={isLoading}
                >
                  <div className="project-list-row-main">
                    <div className="project-list-row-name">
                      <HardDrive size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                      {d.name}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="form-hint">
              No Shared Drives found for this account. Ask your team admin
              to grant you access to the team's Shared Drive.
            </div>
          )}
        </div>

        {/* Step 2 — folder inside the chosen drive */}
        {selectedDrive && (
          <div className="form-group">
            <label>Project folder</label>
            {loadingFolders ? (
              <div className="form-hint">Loading folders…</div>
            ) : folders && folders.length > 0 ? (
              <div className="project-list">
                {folders.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    className={'project-list-row' + (selectedFolder?.id === f.id ? ' selected' : '')}
                    onClick={() => setSelectedFolder(f)}
                    disabled={isLoading}
                  >
                    <div className="project-list-row-main">
                      <div className="project-list-row-name">
                        <FolderOpen size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                        {f.name}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="form-hint">This Shared Drive has no top-level folders.</div>
            )}
          </div>
        )}

        {/* Step 3 — local save path */}
        {selectedFolder && (
          <div className="form-group">
            <label>Save To</label>
            <div className="path-input">
              <input
                value={savePath}
                onChange={e => setSavePath(e.target.value)}
                placeholder="C:\framecad"
              />
              <button className="browse-btn" onClick={handleBrowse}>Browse</button>
            </div>
            <div className="form-hint" style={{ marginTop: 6, lineHeight: 1.5 }}>
              <strong>Pro tip:</strong> put the project folder close to the
              drive root (e.g. <span className="mono">C:\framecad\</span>) and
              <strong> never</strong> inside a OneDrive / iCloud / Dropbox
              folder — desktop-sync services fight with FrameCAD's own sync
              and can corrupt files.
            </div>
          </div>
        )}

        {error && <div className="error-msg" style={{ marginTop: 12 }}>{error}</div>}

        <div className="form-actions">
          <button className="toolbar-btn" onClick={onBack} disabled={isLoading}>Back</button>
          <button
            className="toolbar-btn primary"
            disabled={!selectedDrive || !selectedFolder || !savePath || isLoading}
            onClick={handleJoin}
          >
            {isLoading ? <span className="loading-spinner" /> : 'Join'}
          </button>
        </div>
      </div>
    </div>
  )
}

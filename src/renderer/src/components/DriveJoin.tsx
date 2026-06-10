import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { HardDrive, FolderOpen, LogOut, RefreshCw } from 'lucide-react'
import type { GoogleAuthStatus, DriveSharedDrive, DriveFolder, ProjectEntry } from '@shared/types'

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
  allowedProjects: ProjectEntry[]
  allowAllProjects?: boolean
  /** When set, pre-walk the picker to this Shared Drive + folder so the
   *  user only has to choose a save path (used when joining a specific
   *  team project straight from the welcome list). Falls back to the
   *  manual picker if either isn't visible to this Google account. */
  initialTarget?: { sharedDriveId: string; folderId: string; name: string } | null
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
export default function DriveJoin({ onBack, onJoinDriveProject, isLoading, allowedProjects, allowAllProjects = false, initialTarget }: Props) {
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
  const allowedDriveIds = useMemo(() => new Set(
    allowedProjects
      .filter(p => p.driveFolderId && p.sharedDriveId)
      .map(p => `${p.sharedDriveId}:${p.driveFolderId}`)
  ), [allowedProjects])

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

  // Once signed in, fetch the Shared Drive list once. Latched on a ref —
  // a failed load leaves `drives === null`, and without the latch the
  // effect would re-fire loadDrives() in a tight retry loop. The
  // "Refresh" button is the manual retry path.
  const driveLoadAttemptedRef = useRef(false)
  useEffect(() => {
    if (auth?.signedIn && drives === null && !loadingDrives && !driveLoadAttemptedRef.current) {
      driveLoadAttemptedRef.current = true
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
    driveLoadAttemptedRef.current = false
    setDrives(null)
    setSelectedDrive(null)
    setFolders(null)
    setSelectedFolder(null)
  }

  const pickDrive = useCallback(async (drive: DriveSharedDrive) => {
    setSelectedDrive(drive)
    setSelectedFolder(null)
    setFolders(null)
    setLoadingFolders(true)
    setError(null)
    try {
      const listed = await window.api.driveListFolders(drive.id)
      setFolders(allowAllProjects ? listed : listed.filter(f => allowedDriveIds.has(`${drive.id}:${f.id}`)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoadingFolders(false)
    }
  }, [allowAllProjects, allowedDriveIds])

  // Pre-target: when opened for a specific team project, auto-advance the
  // picker to its Shared Drive, then its folder, landing the user on the
  // save-path step. Each guard (`!selected*`) lets the user still override
  // manually; if the drive/folder isn't visible to this account the picker
  // just stays put. Declared after pickDrive so the dep ref isn't in its TDZ.
  useEffect(() => {
    if (!initialTarget || !drives || selectedDrive) return
    const target = drives.find(d => d.id === initialTarget.sharedDriveId)
    if (target) pickDrive(target)
    else setError(`Couldn’t find “${initialTarget.name}” on this Google account. Pick it manually below, or sign out and use the account with access to your team’s Shared Drive.`)
  }, [initialTarget, drives, selectedDrive, pickDrive])

  useEffect(() => {
    if (!initialTarget || !folders || selectedFolder) return
    const target = folders.find(f => f.id === initialTarget.folderId)
    if (target) setSelectedFolder(target)
    else setError(`“${initialTarget.name}” isn’t visible in this Shared Drive for your account. Pick the project folder manually below.`)
  }, [initialTarget, folders, selectedFolder])

  const handleBrowse = async () => {
    const dir = await window.api.selectDirectory()
    if (dir) setSavePath(dir)
  }

  const handleJoin = async () => {
    if (!selectedDrive || !selectedFolder || !savePath) return
    if (!allowAllProjects && !allowedDriveIds.has(`${selectedDrive.id}:${selectedFolder.id}`)) {
      setError('Your admin has not granted you access to join that project.')
      return
    }
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
              <div className="form-hint">This Shared Drive has no projects you can join.</div>
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

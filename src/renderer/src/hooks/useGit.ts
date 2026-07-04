import { useState, useCallback, useEffect } from 'react'
import type { FileEntry, HistoryEntry, ProjectConfig, LockInfo } from '@shared/types'
import { clearRendererThumbnailCache } from '../components/FileThumbnail'

// Find a file entry by path anywhere in the tree. Used to re-resolve
// `selectedFile` against fresh tree data — without this, the selection
// keeps the FileEntry captured at click time and the DetailsPanel shows
// stale lock/status after Check Out / Check In / Sync.
function findByPath(entries: FileEntry[], path: string): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry
    if (entry.children) {
      const found = findByPath(entry.children, path)
      if (found) return found
    }
  }
  return null
}

export function useGit() {
  const [project, setProject] = useState<ProjectConfig | null>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [locks, setLocks] = useState<LockInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)

  useEffect(() => {
    // Capture the cleanup in a local const + return it. The previous
    // pattern parked the unsubscribe on a ref, which made StrictMode's
    // mount → cleanup → re-mount cycle overwrite the ref between the
    // first cleanup and the eventual second-mount cleanup — leaking
    // a listener every dev re-render.
    const fileCleanup = window.api.onFileChange((newFiles) => {
      setFiles(newFiles)
      setSelectedFile(prev => prev ? findByPath(newFiles, prev.path) ?? null : null)
    })
    const errorCleanup = window.api.onError((err) => {
      setError(err)
    })
    return () => {
      fileCleanup()
      errorCleanup()
    }
  }, [])

  async function fetchAll(): Promise<void> {
    const [newFiles, newHistory, newLocks] = await Promise.all([
      window.api.getStatus(),
      window.api.getHistory(),
      window.api.getLocks()
    ])
    setFiles(newFiles)
    setSelectedFile(prev => prev ? findByPath(newFiles, prev.path) ?? null : null)
    setHistory(newHistory)
    setLocks(newLocks)
  }


  // Join a Google Drive project: download the chosen Drive folder into
  // a local dir, then transition straight into the project view (the
  // main process already set currentProject + started the watcher).
  const joinDriveProject = useCallback(async (args: {
    folderId: string
    sharedDriveId: string
    localPath: string
    name: string
  }) => {
    setIsLoading(true)
    setError(null)
    try {
      const config = await window.api.driveJoinProject(args)
      setProject(config)
      await fetchAll()
    } catch (err) {
      setError((err as Error).message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Join a Lore project: clone the `lore://` repo into a local dir, then
  // transition into the project view (the main process already set
  // currentProject + started the watcher). Mirror of joinDriveProject — the
  // backend is invisible above the IPC boundary because getStatus/getHistory/
  // getLocks dispatch by backend in the main process.
  const joinLoreProject = useCallback(async (args: {
    url: string
    localPath: string
    name: string
  }) => {
    setIsLoading(true)
    setError(null)
    try {
      const config = await window.api.loreJoinProject(args)
      setProject(config)
      await fetchAll()
    } catch (err) {
      setError((err as Error).message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  const closeProject = useCallback(async () => {
    try { await window.api.closeProject() } catch { /* best effort */ }
    // Drop the renderer-side thumbnail cache so a long session of opening
    // many projects doesn't accumulate tens of MB of base64 data-URLs.
    clearRendererThumbnailCache()
    setProject(null)
    setFiles([])
    setHistory([])
    setLocks([])
    setSelectedFile(null)
    setError(null)
  }, [])

  const openProject = useCallback(async (path: string): Promise<boolean> => {
    setIsLoading(true)
    setError(null)
    try {
      const config = await window.api.openProject(path)
      setProject(config)
      await fetchAll()
      return true
    } catch (err) {
      // Surface the error in the UI AND tell the caller it failed, so a
      // caller that flipped into a special view (e.g. manufacturing/kiosk
      // shell) can roll back instead of stranding on a null project.
      setError((err as Error).message)
      return false
    } finally {
      setIsLoading(false)
    }
  }, [])

  const sync = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await window.api.sync()
      if (!result.success) {
        setError(result.error || 'Download failed')
      }
      await fetchAll()
      // Sync may refresh the project name from Drive (folder renamed there).
      // Re-read the config so the GUI stays consistent with Drive. Cheap —
      // reads the in-memory config, no network.
      const cfg = await window.api.getProjectConfig()
      if (cfg) setProject(cfg)
      return result
    } catch (err) {
      setError((err as Error).message)
      return { success: false, filesUpdated: 0, error: (err as Error).message }
    } finally {
      setIsLoading(false)
    }
  }, [])

  const publish = useCallback(async (message: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await window.api.publish(message)
      if (!result.success) {
        setError(result.error || 'Upload failed')
      }
      await fetchAll()
      return result
    } catch (err) {
      setError((err as Error).message)
      return { success: false, error: (err as Error).message }
    } finally {
      setIsLoading(false)
    }
  }, [])

  const checkOut = useCallback(async (filePath: string) => {
    setIsLoading(true)
    setError(null)
    try {
      await window.api.checkOut(filePath)
      await fetchAll()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const checkIn = useCallback(async (filePath: string) => {
    setIsLoading(true)
    setError(null)
    try {
      await window.api.checkIn(filePath)
      await fetchAll()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // These set isLoading like the other mutators so the Toolbar's
  // `disabled={isLoading}` (and Enter-key paths) actually engage during the
  // in-flight create — otherwise a double-click / double-Enter fires two
  // create IPCs and mints two sequential part numbers, and tombstones make the
  // stray reservation permanent.
  const createNewPart = useCallback(async (folder: string, description?: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await window.api.createNewPart(folder, description)
      await fetchAll()
      return result
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [])

  const createSubsystem = useCallback(async (parentFolder: string, name: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await window.api.createSubsystem(parentFolder, name)
      await fetchAll()
      return result
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [])

  const createNewAssembly = useCallback(async (parentFolder: string, name: string, description?: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await window.api.createNewAssembly(parentFolder, name, description)
      await fetchAll()
      return result
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [])

  const dismissError = useCallback(() => setError(null), [])

  return {
    project,
    files,
    history,
    locks,
    isLoading,
    error,
    selectedFile,
    setSelectedFile,
    joinDriveProject,
    joinLoreProject,
    openProject,
    closeProject,
    sync,
    publish,
    checkOut,
    checkIn,
    createNewPart,
    createNewAssembly,
    createSubsystem,
    dismissError,
    setError
  }
}

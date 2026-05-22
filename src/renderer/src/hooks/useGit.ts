import { useState, useCallback, useEffect } from 'react'
import type { FileEntry, HistoryEntry, ProjectConfig, LockInfo } from '@shared/types'

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
    setHistory(newHistory)
    setLocks(newLocks)
  }


  const createProject = useCallback(async (name: string, path: string, remote: string, isCotsProject?: boolean) => {
    setIsLoading(true)
    setError(null)
    try {
      await window.api.createProject(name, path, remote, isCotsProject)
      const config = await window.api.getProjectConfig()
      setProject(config)
      await fetchAll()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const joinProject = useCallback(async (
    url: string,
    path: string,
    options?: { skipSmudge?: boolean },
  ) => {
    setIsLoading(true)
    setError(null)
    try {
      await window.api.joinProject(url, path, options)
      const config = await window.api.getProjectConfig()
      setProject(config)
      await fetchAll()
    } catch (err) {
      // Let the caller decide what to do — surface via local error
      // state AND re-throw so the welcome screen can intercept the
      // LFS_UNREACHABLE sentinel and offer a retry.
      setError((err as Error).message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  const closeProject = useCallback(async () => {
    try { await window.api.closeProject() } catch { /* best effort */ }
    setProject(null)
    setFiles([])
    setHistory([])
    setLocks([])
    setSelectedFile(null)
    setError(null)
  }, [])

  const openProject = useCallback(async (path: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const config = await window.api.openProject(path)
      setProject(config)
      await fetchAll()
    } catch (err) {
      setError((err as Error).message)
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
    setError(null)
    try {
      await window.api.checkOut(filePath)
      await fetchAll()
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  const checkIn = useCallback(async (filePath: string) => {
    setError(null)
    try {
      await window.api.checkIn(filePath)
      await fetchAll()
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  const createNewPart = useCallback(async (folder: string, description?: string) => {
    setError(null)
    try {
      const result = await window.api.createNewPart(folder, description)
      await fetchAll()
      return result
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }, [])

  const createSubsystem = useCallback(async (parentFolder: string, name: string) => {
    setError(null)
    try {
      const result = await window.api.createSubsystem(parentFolder, name)
      await fetchAll()
      return result
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }, [])

  const createNewAssembly = useCallback(async (parentFolder: string, name: string, description?: string) => {
    setError(null)
    try {
      const result = await window.api.createNewAssembly(parentFolder, name, description)
      await fetchAll()
      return result
    } catch (err) {
      setError((err as Error).message)
      return null
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
    createProject,
    joinProject,
    openProject,
    closeProject,
    sync,
    publish,
    checkOut,
    checkIn,
    createNewPart,
    createNewAssembly,
    createSubsystem,
    dismissError
  }
}

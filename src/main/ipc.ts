import { ipcMain, dialog, shell, app, BrowserWindow, Notification } from 'electron'
import os from 'os'
import path from 'path'
import { watch } from 'chokidar'
import * as gitOps from './git'
import * as lockOps from './locking'
import * as partsOps from './parts'
import * as adminOps from './admin'
import * as pathsOps from './paths'
import * as depsOps from './deps'
import * as authOps from './auth'
import { reportIssue } from './issue'
import { generateDocument } from './documents'
import type { DocType } from './documents'
import { scanLargeFiles } from './large-files'
import * as metaOps from './meta'
import * as exportQueue from './export-queue'
import {
  getGlobalAdminState,
  saveGlobalAdmin,
  resetGlobalAdmin,
  migrateFromCachedBrowseConfig
} from './global-admin'
import { addRecentProject, getRecentProjects, getCachedBrowseConfig, setProjectPinned, removeRecentProject, resetAllAppState } from './config'
import * as teamServer from './teamServer'
import * as googleAuth from './google-auth'
import * as driveProject from './drive-project'
import * as driveOps from './drive'
import { setRestProject, clearRestProject, stopRestServer, queuePendingCreate, setRestMainWindow } from './rest'
import { getThumbnail, clearThumbnailCache } from './thumbnails'
import type { FileEntry, ProjectConfig } from '@shared/types'

let watcher: ReturnType<typeof watch> | null = null
let publishingNow = false

export function isPublishing(): boolean {
  return publishingNow
}

/**
 * The lock key for the currently-open Drive project — its Drive folder
 * id (see server migration v15). Throws if called when no Drive project
 * is open or the manifest somehow lacks a folder id, so a lock call
 * never silently targets the wrong project.
 */
function driveProjectKey(): string {
  const key = driveProject.currentConfig()?.driveFolderId
  if (!key) throw new Error('No Drive project open (missing Drive folder id)')
  return key
}

async function getDriveStatusWithLocks(): Promise<FileEntry[]> {
  const files = await driveProject.status()
  try {
    const locks = await teamServer.listDriveLocks(driveProjectKey())
    const me = teamServer.currentSnapshot().me
    const lockMap = new Map(locks.map(l => [l.filePath, l]))
    const applyLocks = (entries: FileEntry[]): void => {
      for (const entry of entries) {
        if (!entry.isDirectory) {
          const lock = lockMap.get(entry.path)
          if (lock) {
            entry.lockedBy = lock.ownerName
            entry.state = lock.ownerMemberId === me?.id ? 'locked-by-you' : 'locked-by-other'
          }
        }
        if (entry.children) applyLocks(entry.children)
      }
    }
    applyLocks(files)
  } catch {
    // Offline / not enrolled: show local status only.
  }
  return files
}

function debounce<T extends (...args: unknown[]) => unknown>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: unknown[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as unknown as T
}

function notifyFileChange(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // Drive projects have no git index / parts manifest sync — just diff
  // the working tree against the Drive manifest and push that.
  if (driveProject.isOpen()) {
    getDriveStatusWithLocks()
      .then(files => { if (!win.isDestroyed()) win.webContents.send('file-change', files) })
      .catch(() => {})
    return
  }
  partsOps.syncManifest()
    .then(() => gitOps.getStatus())
    .then(files => { if (!win.isDestroyed()) win.webContents.send('file-change', files) })
    .catch(() => {
      gitOps.getStatus().then(files => {
        if (!win.isDestroyed()) win.webContents.send('file-change', files)
      }).catch(() => {})
    })
}

/**
 * Broadcast a fresh getStatus() to the renderer without re-running the
 * manifest sync. Used after meta-mutating IPC calls so the file tree,
 * AdminPage caches, and ManufacturingQueue all pick up the new
 * release-state / comments / mass / cost / method / material without
 * waiting for the next file-watcher tick. The chokidar watcher ignores
 * `.framecad/` so parts-meta.json writes never fire it on their own.
 */
function broadcastStatus(getMainWindow: () => BrowserWindow | null): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  gitOps.getStatus()
    .then(files => { if (!win.isDestroyed()) win.webContents.send('file-change', files) })
    .catch(() => {})
}

function startWatching(dirPath: string, win: BrowserWindow): void {
  stopWatching()
  const debouncedNotify = debounce(() => notifyFileChange(win), 500)
  watcher = watch(dirPath, {
    ignored: [/(^|[/\\])\../, /node_modules/, /parts\.json$/],
    persistent: true,
    ignoreInitial: true,
    depth: 10
  })
  watcher.on('all', debouncedNotify)
}

function stopWatching(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

export function setupIpc(getMainWindow: () => BrowserWindow | null): void {
  let currentProject: ProjectConfig | null = null

  // Let the REST server bring the main window forward when the SW
  // add-in's "Show in FrameCAD" button is clicked
  setRestMainWindow(getMainWindow)

  ipcMain.handle('create-project', async (_e, name: string, dirPath: string, remote: string, isCotsProject?: boolean) => {
    await gitOps.createProject(name, dirPath, remote)
    if (isCotsProject) {
      await adminOps.writeLocalAdminConfig({ isCotsProject: true })
    }
    currentProject = { name, path: dirPath, remote }
    await addRecentProject(currentProject)
    setRestProject(currentProject)
    const win = getMainWindow()
    if (win) startWatching(dirPath, win)
  })

  ipcMain.handle('join-project', async (
    _e,
    url: string,
    dirPath: string,
    options?: { skipSmudge?: boolean },
  ) => {
    const win = getMainWindow()
    await gitOps.joinProject(
      url,
      dirPath,
      (progress) => {
        if (win && !win.isDestroyed()) win.webContents.send('join-progress', progress)
      },
      options,
    )
    const name = path.basename(dirPath)
    currentProject = { name, path: dirPath, remote: url }
    await addRecentProject(currentProject)
    setRestProject(currentProject)
    // If the joined project has admin-configured COTS, download it as part
    // of the join so the COTS library is ready before the user enters the
    // project. Network errors are tolerated — the project still opens.
    // Also load the project / COTS subpaths so the file tree, IPC, and
    // REST API all start out scoped correctly without waiting for the
    // next open-project round-trip.
    try {
      const cfg = await adminOps.loadAdminConfig()
      pathsOps.setProjectSubpath(cfg.projectSubpath ?? '')
      pathsOps.setCotsSubpath(cfg.cotsSubpath ?? '')
      if (cfg.cotsRepoUrl) {
        await gitOps.syncCotsRepo(cfg.cotsRepoUrl, cfg.cotsBranch)
      }
    } catch { /* best effort */ }
    if (win) startWatching(dirPath, win)
  })

  ipcMain.handle('open-project', async (_e, dirPath: string) => {
    // Drive project? (folder carries a .framecad/drive-manifest.json).
    // If so it owns this session — skip the git open flow entirely.
    const driveConfig = await driveProject.open(dirPath).catch(() => null)
    if (driveConfig) {
      gitOps.setFilesystemProjectPath(dirPath)
      currentProject = driveConfig
      setRestProject(currentProject)
      const win = getMainWindow()
      if (win) startWatching(dirPath, win)
      return currentProject
    }
    driveProject.close()
    await gitOps.openProject(dirPath)
    const name = path.basename(dirPath)
    const git = gitOps.getGit()
    let remote = ''
    try {
      const remotes = await git.getRemotes(true)
      remote = remotes.find(r => r.name === 'origin')?.refs.push || ''
    } catch { /* no remote */ }
    currentProject = { name, path: dirPath, remote }
    await addRecentProject(currentProject)
    setRestProject(currentProject)
    // Apply admin config: load the project / COTS subpaths into the
    // path-translation cache so the file tree, locks, and watcher all
    // honour them immediately. Then pull the shared COTS library in
    // the background if one's configured.
    adminOps.loadAdminConfig().then(cfg => {
      pathsOps.setProjectSubpath(cfg.projectSubpath ?? '')
      pathsOps.setCotsSubpath(cfg.cotsSubpath ?? '')
      if (cfg.cotsRepoUrl) gitOps.syncCotsRepo(cfg.cotsRepoUrl, cfg.cotsBranch).catch(() => {})
    }).catch(() => {})
    const win = getMainWindow()
    if (win) startWatching(dirPath, win)
    return currentProject
  })

  ipcMain.handle('sync', async () => {
    if (driveProject.isOpen()) {
      const win = getMainWindow()
      const result = await driveProject.sync(progress => {
        if (win && !win.isDestroyed()) win.webContents.send('publish-progress', progress)
      })
      if (result.success && result.filesUpdated > 0 && Notification.isSupported()) {
        try {
          new Notification({
            title: 'FrameCAD — Downloaded',
            body: `${result.filesUpdated} file${result.filesUpdated === 1 ? '' : 's'} updated from the team`,
            silent: false
          }).show()
        } catch { /* not all platforms support */ }
      }
      return result
    }
    const result = await gitOps.sync()
    if (result.success && result.filesUpdated > 0 && Notification.isSupported()) {
      try {
        new Notification({
          title: 'FrameCAD — Downloaded',
          body: `${result.filesUpdated} file${result.filesUpdated === 1 ? '' : 's'} updated from the team`,
          silent: false
        }).show()
      } catch { /* not all platforms support */ }
    }
    return result
  })

  ipcMain.handle('publish', async (_e, message: string) => {
    const win = getMainWindow()
    publishingNow = true
    try {
      if (driveProject.isOpen()) {
        const result = await driveProject.publish(progress => {
          if (win && !win.isDestroyed()) win.webContents.send('publish-progress', progress)
        })
        return result
      }
      await metaOps.flushMetaCommit()
      const result = await gitOps.publish(message, (progress) => {
        if (win && !win.isDestroyed()) win.webContents.send('publish-progress', progress)
      })
      return result
    } finally {
      publishingNow = false
    }
  })

  ipcMain.handle('get-status', async () => {
    if (driveProject.isOpen()) return getDriveStatusWithLocks()
    return gitOps.getStatus()
  })

  ipcMain.handle('get-history', async (_e, limit?: number) => {
    // Drive backend has no commit history (yet — revisions are a future
    // enhancement). Return an empty feed so the UI renders cleanly.
    if (driveProject.isOpen()) return []
    return gitOps.getHistory(limit)
  })

  ipcMain.handle('check-out', async (_e, filePath: string) => {
    // Drive backend: locks live on the team server (no git lfs lock).
    // Paths from the Drive status tree are already project-relative —
    // no subpath translation, unlike the git path below.
    if (driveProject.isOpen()) {
      await teamServer.acquireDriveLock(driveProjectKey(), filePath)
      return
    }
    // Translate the (apparent project-root)-relative path the renderer
    // sends back to the git-relative form `git lfs lock` expects. No-op
    // when no subpath is configured.
    await lockOps.checkOut(pathsOps.toGitRel(filePath))
  })

  ipcMain.handle('check-in', async (_e, filePath: string) => {
    if (driveProject.isOpen()) {
      await teamServer.releaseDriveLock(driveProjectKey(), filePath)
      return
    }
    await lockOps.checkIn(pathsOps.toGitRel(filePath))
  })

  ipcMain.handle('force-check-in', async (_e, filePath: string) => {
    if (driveProject.isOpen()) {
      await teamServer.releaseDriveLock(driveProjectKey(), filePath, true)
      broadcastStatus(getMainWindow)
      return
    }
    await lockOps.forceCheckIn(pathsOps.toGitRel(filePath))
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('get-locks', async () => {
    if (driveProject.isOpen()) {
      try {
        const locks = await teamServer.listDriveLocks(driveProjectKey())
        // Map the server's lock shape to the LockInfo the renderer
        // already understands (path / owner / id).
        return locks.map(l => ({
          path: l.filePath,
          owner: l.ownerName,
          id: String(l.ownerMemberId)
        }))
      } catch {
        // Offline / server unreachable — no locks rather than a hard
        // failure, matching how the git backend degrades.
        return []
      }
    }
    return lockOps.getLocks()
  })

  ipcMain.handle('get-remote-ahead', async () => {
    if (driveProject.isOpen()) return 0
    return gitOps.getRemoteAhead()
  })

  ipcMain.handle('get-local-ahead', async () => {
    if (driveProject.isOpen()) return 0
    return gitOps.getLocalAhead()
  })

  ipcMain.handle('set-legacy-mode', async (_e, enabled: boolean) => {
    await partsOps.setLegacyMode(enabled)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('select-directory', async () => {
    const win = getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('open-file-explorer', async (_e, filePath: string) => {
    const projectDir = driveProject.currentDir() ?? gitOps.getProjectPath()
    shell.showItemInFolder(path.join(projectDir, filePath))
  })

  ipcMain.handle('get-project-config', () => {
    return currentProject
  })

  ipcMain.handle('get-parts-manifest', async () => {
    try {
      return await partsOps.loadManifest()
    } catch {
      return null
    }
  })

  ipcMain.handle('create-new-part', async (_e, folder: string, description?: string) => {
    // Folder arg comes from the renderer as a subpath-relative path
    // (or empty for "project root"). Translate to git-rel for the
    // parts engine, then translate the returned filePath back so the
    // UI doesn't see the subpath prefix.
    const gitFolder = pathsOps.toGitRel(folder || '')
    const result = await partsOps.createNewPart(gitFolder, description)
    queuePendingCreate('part', result.filePath, result.partNumber)
    const displayPath = pathsOps.toProjectRel(result.filePath) ?? result.filePath
    return { ...result, filePath: displayPath }
  })

  ipcMain.handle('create-new-assembly', async (_e, parentFolder: string, name: string, description?: string) => {
    const gitFolder = pathsOps.toGitRel(parentFolder || '')
    const result = await partsOps.createNewAssembly(gitFolder, name, description)
    queuePendingCreate('assembly', result.filePath, result.partNumber)
    const displayPath = pathsOps.toProjectRel(result.filePath) ?? result.filePath
    return { ...result, filePath: displayPath }
  })

  ipcMain.handle('create-subsystem', async (_e, parentFolder: string, name: string) => {
    const gitFolder = pathsOps.toGitRel(parentFolder || '')
    const result = await partsOps.createSubsystem(gitFolder, name)
    const displayPath = pathsOps.toProjectRel(result.folderPath) ?? result.folderPath
    return { ...result, folderPath: displayPath }
  })

  ipcMain.handle('get-recent-projects', async () => {
    return getRecentProjects()
  })

  ipcMain.handle('set-project-pinned', async (_e, projectPath: string, pinned: boolean) => {
    await setProjectPinned(projectPath, pinned)
  })

  ipcMain.handle('remove-recent-project', async (_e, projectPath: string) => {
    await removeRecentProject(projectPath)
  })

  ipcMain.handle('get-git-identity', async () => {
    return gitOps.getGitIdentity()
  })

  ipcMain.handle('set-git-identity', async (_e, name: string, email: string) => {
    await gitOps.setGitIdentity(name, email)
  })

  ipcMain.handle('close-project', () => {
    currentProject = null
    driveProject.close()
    gitOps.closeProject()
    clearRestProject()
    stopWatching()
    clearThumbnailCache()
    // Drop the cached subpath so opening a different project next
    // doesn't accidentally inherit this one's filter.
    pathsOps.clearSubpathCache()
  })

  ipcMain.handle('get-app-version', () => app.getVersion())

  // Tiny getters used by the enrollment wizard to pre-fill the
  // "Your name" + "Device label" fields with sensible defaults.
  // Both are best-effort: a renderer that doesn't get a value just
  // shows empty fields.
  ipcMain.handle('get-os-hostname', () => {
    try { return os.hostname() } catch { return '' }
  })
  ipcMain.handle('get-os-username', () => {
    try { return os.userInfo().username } catch { return '' }
  })

  ipcMain.handle('check-dependencies', async () => depsOps.checkDependencies())
  ipcMain.handle('github-auth-status', async () => authOps.githubAuthStatus())
  ipcMain.handle('github-login', async () => authOps.githubLogin())
  ipcMain.handle('github-logout', async () => authOps.githubLogout())

  ipcMain.handle('report-issue', async (_e, errorMessage: string) => {
    return reportIssue(errorMessage || '')
  })

  ipcMain.handle('generate-document', async (_e, type: DocType) => {
    try {
      const raw = driveProject.isOpen()
        ? (teamServer.currentSnapshot().me?.displayName ?? '')
        : await import('./git')
          .then(m => m.getGit())
          .then(g => g.raw(['config', '--get', 'user.name']).catch(() => ''))
      const generatedBy = raw.trim() || 'FrameCAD'
      return generateDocument(type, generatedBy)
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('open-path', async (_e, absPath: string) => {
    try {
      const result = await shell.openPath(absPath)
      return { success: result === '', error: result || undefined }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('reveal-in-folder', async (_e, absPath: string) => {
    try {
      shell.showItemInFolder(absPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('scan-large-files', async () => {
    try {
      const files = await scanLargeFiles()
      // Scan is intentionally repo-wide (you want to catch big blobs
      // anywhere, including sibling subprojects). For display, strip
      // the project subpath from any file that falls inside it so the
      // Storage page paths match the file tree the user sees. Files
      // outside the subpath keep their git-relative path so the user
      // can still see e.g. "COTS/Vendor1/giant.sldprt".
      const displayFiles = files.map(f => {
        const display = pathsOps.toProjectRel(f.path)
        return display === null ? f : { ...f, path: display }
      })
      return { success: true, files: displayFiles }
    } catch (err) {
      return { success: false, files: [], error: (err as Error).message }
    }
  })
  ipcMain.handle('git-resetup', async () => authOps.gitResetup())

  ipcMain.handle('list-github-repos', async (_e, org: string, prefix?: string) => {
    return authOps.listGitHubRepos(org, prefix)
  })

  ipcMain.handle('create-github-repo', async (_e, org: string, name: string, isPrivate: boolean, description?: string) => {
    return authOps.createGitHubRepo(org, name, isPrivate, description)
  })

  ipcMain.handle('open-external', async (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      await shell.openExternal(url)
    }
  })

  ipcMain.handle('get-admin-config', async () => {
    try { return await adminOps.loadAdminConfig() } catch { return {} }
  })

  ipcMain.handle('save-admin-config', async (_e, config) => {
    await adminOps.saveAndPublishAdminConfig(config)
    if (config?.mainRepoUrl) {
      try { await gitOps.setMainRemoteUrl(config.mainRepoUrl) } catch { /* leave to admin */ }
    }
    // Live-update the path cache so a change to projectSubpath /
    // cotsSubpath takes effect on the very next getStatus broadcast
    // (no restart required).
    pathsOps.setProjectSubpath(config?.projectSubpath ?? '')
    pathsOps.setCotsSubpath(config?.cotsSubpath ?? '')
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('get-global-admin', async () => {
    // One-time migration: seed the new local override file from the v0.7
    // cachedBrowseConfig if no override exists yet
    try {
      const cached = await getCachedBrowseConfig()
      if (cached.gitHubOrg || cached.projectPrefix) {
        await migrateFromCachedBrowseConfig(cached).catch(() => {})
      }
    } catch { /* ignore */ }
    return getGlobalAdminState()
  })

  ipcMain.handle('save-global-admin', async (_e, config) => {
    await saveGlobalAdmin(config || {})
  })

  ipcMain.handle('reset-global-admin', async () => {
    await resetGlobalAdmin()
  })

  ipcMain.handle('reset-all-app-state', async () => {
    // Catch errors so the relaunch fires even if a particular wipe step
    // fails (file locked on Windows, network blip on session API).
    // A partial reset + relaunch is still better than a silent no-op.
    try {
      await resetAllAppState()
    } catch (err) {
      console.error('reset-all-app-state error (will still relaunch):', err)
    }
    // Relaunch after the IPC reply has had a moment to reach the
    // renderer. A full process restart guarantees Chromium re-opens
    // its leveldb stores clean — a window.location.reload() would
    // keep the same process alive and re-flush stale state.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 200)
  })

  ipcMain.handle('sync-cots', async () => {
    const config = await adminOps.loadAdminConfig()
    if (!config.cotsRepoUrl) return { success: false, error: 'No COTS repo configured' }
    return gitOps.syncCotsRepo(config.cotsRepoUrl, config.cotsBranch)
  })

  ipcMain.handle('create-progress-tag', async (_e, name: string, message?: string) => {
    return gitOps.createProgressTag(name, message)
  })

  // Every handler that takes a `filePath` first translates the path
  // the renderer supplied (subpath-relative) into the git-relative
  // form the manifest, meta, and git CLI use. When no subpath is
  // configured these are no-ops.
  ipcMain.handle('get-part-meta', async (_e, filePath: string) => {
    return metaOps.getPartMeta(pathsOps.toGitRel(filePath))
  })

  ipcMain.handle('get-where-used', async (_e, filePath: string) => {
    // Returned paths are git-relative (manifest keys). Translate each
    // back to subpath-relative so the renderer can use them as paths
    // into the file tree it's already showing.
    const refs = await partsOps.findWhereUsed(pathsOps.toGitRel(filePath))
    return refs
      .map(p => pathsOps.toProjectRel(p))
      .filter((p): p is string => p !== null)
  })

  ipcMain.handle('get-thumbnail', async (_e, filePath: string, size: number) => {
    return getThumbnail(pathsOps.toGitRel(filePath), size)
  })

  ipcMain.handle('set-release-state', async (_e, filePath: string, state: string, note?: string) => {
    await metaOps.setReleaseState(pathsOps.toGitRel(filePath), state as Parameters<typeof metaOps.setReleaseState>[1], note)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('add-comment', async (_e, filePath: string, text: string) => {
    await metaOps.addComment(pathsOps.toGitRel(filePath), text)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('set-manufacturing-notes', async (_e, filePath: string, notes: string) => {
    await metaOps.setManufacturingNotes(pathsOps.toGitRel(filePath), notes)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('set-part-mass', async (_e, filePath: string, mass: number | null) => {
    await metaOps.setPartMass(pathsOps.toGitRel(filePath), mass)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('set-part-cost', async (_e, filePath: string, cost: number | null) => {
    await metaOps.setPartCost(pathsOps.toGitRel(filePath), cost)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('get-project-totals', async () => {
    return metaOps.getProjectTotals()
  })

  ipcMain.handle('set-mfg-method', async (_e, filePath: string, method: string | null) => {
    await metaOps.setManufacturingMethod(pathsOps.toGitRel(filePath), method as Parameters<typeof metaOps.setManufacturingMethod>[1])
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('set-mfg-material', async (_e, filePath: string, material: string) => {
    await metaOps.setManufacturingMaterial(pathsOps.toGitRel(filePath), material)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('bulk-update-meta', async (_e, updates: Record<string, metaOps.BulkMetaPatch>) => {
    // Renderer keys these by subpath-relative paths (from the file
    // tree it sees). Internal storage is keyed by git-relative paths,
    // so translate every key before passing through. When no subpath
    // is set, toGitRel is the identity.
    const translated: Record<string, metaOps.BulkMetaPatch> = {}
    for (const [k, v] of Object.entries(updates)) {
      translated[pathsOps.toGitRel(k)] = v
    }
    const n = await metaOps.bulkUpdateMeta(translated)
    broadcastStatus(getMainWindow)
    return n
  })

  ipcMain.handle('get-manufacturing-queue', async () => {
    // Items carry git-relative paths internally; translate each to
    // subpath-relative for the renderer, and drop entries outside the
    // active project subpath (e.g. parts in a sibling project folder).
    const queue = await metaOps.getManufacturingQueue()
    return queue
      .map(item => {
        const display = pathsOps.toProjectRel(item.path)
        return display === null ? null : { ...item, path: display }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  })

  // Status surfaced to the admin Export Queue tab so the UI can tell
  // whether a batch-export would actually go anywhere (SW must be open
  // and polling for any of this to do work).
  ipcMain.handle('get-export-status', async () => {
    const queue = await metaOps.getManufacturingQueue()
    // Filter + translate so the needs-export list matches the file
    // tree the user sees.
    const needsExport = queue
      .filter(q => !!q.needsExport)
      .map(item => {
        const display = pathsOps.toProjectRel(item.path)
        return display === null ? null : { ...item, path: display }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    return {
      swAlive: exportQueue.isSwAlive(),
      lastSwSeenAt: exportQueue.getLastSwSeenAt(),
      pendingTasks: exportQueue.listPendingExports().length,
      needsExport
    }
  })

  // Trigger an export for a single released part. Requires SW alive;
  // otherwise we'd just be queuing forever. Returns the task id (or
  // null if the file already has its paired export).
  ipcMain.handle('trigger-part-export', async (_e, filePath: string) => {
    if (!exportQueue.isSwAlive()) {
      throw new Error('SolidWorks is not connected. Open SolidWorks with the FrameCAD add-in, then try again.')
    }
    const gitPath = pathsOps.toGitRel(filePath)
    const queue = await metaOps.getManufacturingQueue()
    const item = queue.find(q => q.path === gitPath)
    if (!item) throw new Error(`Part not released or not found: ${filePath}`)
    if (!item.needsExport) return { taskId: null, alreadyExists: true }
    const projectPath = gitOps.getProjectPath()
    const task = exportQueue.queuePendingExport(projectPath, gitPath, item.needsExport)
    return { taskId: task?.id ?? null, alreadyExists: false }
  })

  // Batch trigger every needs-export part at once. Useful when a
  // backlog has built up (parts released while SW was closed, or
  // legacy parts predating this feature).
  ipcMain.handle('trigger-batch-export', async () => {
    if (!exportQueue.isSwAlive()) {
      throw new Error('SolidWorks is not connected. Open SolidWorks with the FrameCAD add-in, then try again.')
    }
    const queue = await metaOps.getManufacturingQueue()
    const projectPath = gitOps.getProjectPath()
    let queued = 0
    for (const item of queue) {
      if (!item.needsExport) continue
      const task = exportQueue.queuePendingExport(projectPath, item.path, item.needsExport)
      if (task) queued++
    }
    return { queued }
  })

  // Bulk loader used by the admin Parts Manager tab so we don't fire
  // N IPC calls (one per part) to render the table. Returns the entire
  // parts-meta.json file keyed by relative path; the renderer joins
  // against the parts manifest client-side.
  ipcMain.handle('get-all-parts-meta', async () => {
    // Keys are git-relative in storage; the Parts Manager indexes its
    // rows by what it sees in the file tree (subpath-relative). Drop
    // entries outside the project subpath and re-key the rest.
    const all = await metaOps.loadAllMeta()
    const out: Record<string, typeof all[string]> = {}
    for (const [gitPath, meta] of Object.entries(all)) {
      const display = pathsOps.toProjectRel(gitPath)
      if (display === null) continue
      out[display] = meta
    }
    return out
  })

  // Scans the parts manifest for integrity problems mentors should
  // know about: duplicate part numbers (rare but breaks the BOM),
  // drawings whose linkedTo target no longer exists in the manifest,
  // and tombstone entries (manifest entry with no file on disk).
  ipcMain.handle('check-manifest-integrity', async () => {
    try {
      const manifest = await partsOps.loadManifest()
      const fs = await import('fs/promises')
      const path = await import('path')
      const projectDir = gitOps.getProjectPath()

      // Duplicates: any partNumber appearing on more than one entry path
      const byNumber: Record<string, string[]> = {}
      for (const [p, e] of Object.entries(manifest.entries)) {
        if (!byNumber[e.partNumber]) byNumber[e.partNumber] = []
        byNumber[e.partNumber].push(p)
      }
      const duplicates = Object.entries(byNumber)
        .filter(([, paths]) => paths.length > 1)
        .map(([partNumber, paths]) => ({ partNumber, paths }))

      // Orphaned drawings: drawing entries whose `linkedTo` is set but
      // points at a path the manifest no longer has
      const orphanedDrawings: { path: string; linkedTo: string }[] = []
      for (const [p, e] of Object.entries(manifest.entries)) {
        if (e.type === 'drawing' && e.linkedTo && !manifest.entries[e.linkedTo]) {
          orphanedDrawings.push({ path: p, linkedTo: e.linkedTo })
        }
      }

      // Tombstones: manifest entries whose file no longer exists on disk
      const tombstones: string[] = []
      for (const p of Object.keys(manifest.entries)) {
        const abs = path.join(projectDir, p)
        try { await fs.stat(abs) } catch { tombstones.push(p) }
      }

      // Orphaned meta: parts-meta.json keys with no corresponding entry
      // in parts.json (rename history from before the migration fix, or
      // hand-edited meta). Surfaced so mentors can clean up the file.
      const manifestPathSet = new Set(Object.keys(manifest.entries))
      const orphanedMeta = await metaOps.findOrphanMetaPaths(manifestPathSet)

      return { success: true, duplicates, orphanedDrawings, tombstones, orphanedMeta }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Force `git add --renormalize -A` across the whole working tree.
  // Useful when .gitattributes was updated (e.g. v0.7.7 added zip/exe
  // to LFS) but existing files in the index are still stored as raw
  // blobs. Publish already does this on each invocation, but a
  // standalone button lets mentors run it explicitly for diagnosis.
  ipcMain.handle('renormalize-all', async () => {
    try {
      await gitOps.getGit().raw(['add', '--renormalize', '-A'])
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('get-main-remote-url', async () => {
    try {
      const remotes = await gitOps.getGit().getRemotes(true)
      return remotes.find(r => r.name === 'origin')?.refs.push || ''
    } catch {
      return ''
    }
  })

  // ── Team server (replaces the old coordination repo) ──
  // Every team-config / member / project mutation now lives in the
  // browser admin UI hosted by the team server. The desktop's job is
  // only to (a) enroll once with a PIN and (b) read snapshots.
  ipcMain.handle('team-get-snapshot', () => teamServer.currentSnapshot())
  ipcMain.handle('team-refresh', () => teamServer.refresh())
  ipcMain.handle('team-enroll', (_e, args: {
    serverUrl: string
    pin: string
    deviceLabel?: string
    displayName?: string
    githubUsername?: string
  }) => teamServer.enroll(args))
  ipcMain.handle('team-login-device', (_e, args: {
    serverUrl: string
    username: string
    password: string
    deviceLabel?: string
  }) => teamServer.loginDevice(args))
  ipcMain.handle('team-sign-out', () => teamServer.signOut())
  ipcMain.handle('team-admin-ui-url', () => teamServer.adminUiUrl())
  ipcMain.handle('team-ping-server', () => teamServer.pingTeamServer())

  // ── Google Drive storage backend ──
  // Sign-in lives in the main process (loopback OAuth needs a localhost
  // server + the system browser). The renderer only ever sees status.
  ipcMain.handle('google-auth-status', () => googleAuth.googleAuthStatus())
  ipcMain.handle('google-sign-in', () => googleAuth.googleSignIn())
  ipcMain.handle('google-sign-out', () => googleAuth.googleSignOut())

  ipcMain.handle('drive-list-shared-drives', () => driveOps.listSharedDrives())
  ipcMain.handle('drive-list-folders', (_e, sharedDriveId: string) =>
    driveOps.listDriveFolders(sharedDriveId))

  ipcMain.handle('drive-join-project', async (_e, args: {
    folderId: string
    sharedDriveId: string
    localPath: string
    name: string
  }) => {
    const win = getMainWindow()
    const config = await driveProject.join(
      args.folderId,
      args.sharedDriveId,
      args.localPath,
      args.name,
      progress => {
        if (win && !win.isDestroyed()) win.webContents.send('join-progress', progress)
      }
    )
    gitOps.setFilesystemProjectPath(config.path)
    currentProject = config
    setRestProject(currentProject)
    if (win) startWatching(config.path, win)
    return config
  })

  // Push snapshot updates to the renderer so the App-level cache
  // stays current without polling. Each render that subscribes via
  // onTeamSnapshot gets the same stream.
  teamServer.onSnapshot(snapshot => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('team-snapshot', snapshot)
    }
  })
}

export { stopWatching, stopRestServer }

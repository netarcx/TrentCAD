import { ipcMain, dialog, shell, app, BrowserWindow, Notification } from 'electron'
import path from 'path'
import { watch } from 'chokidar'
import * as gitOps from './git'
import * as lockOps from './locking'
import * as partsOps from './parts'
import * as adminOps from './admin'
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
import * as coordOps from './coordination'
import { setRestProject, clearRestProject, stopRestServer, queuePendingCreate, setRestMainWindow } from './rest'
import { getThumbnail, clearThumbnailCache } from './thumbnails'
import type { ProjectConfig } from '@shared/types'

let watcher: ReturnType<typeof watch> | null = null
let publishingNow = false

export function isPublishing(): boolean {
  return publishingNow
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

  ipcMain.handle('join-project', async (_e, url: string, dirPath: string) => {
    const win = getMainWindow()
    await gitOps.joinProject(url, dirPath, (progress) => {
      if (win && !win.isDestroyed()) win.webContents.send('join-progress', progress)
    })
    const name = path.basename(dirPath)
    currentProject = { name, path: dirPath, remote: url }
    await addRecentProject(currentProject)
    setRestProject(currentProject)
    // If the joined project has admin-configured COTS, download it as part
    // of the join so the COTS library is ready before the user enters the
    // project. Network errors are tolerated — the project still opens.
    try {
      const cfg = await adminOps.loadAdminConfig()
      if (cfg.cotsRepoUrl) {
        await gitOps.syncCotsRepo(cfg.cotsRepoUrl, cfg.cotsBranch)
      }
    } catch { /* best effort */ }
    if (win) startWatching(dirPath, win)
  })

  ipcMain.handle('open-project', async (_e, dirPath: string) => {
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
    // Apply admin config: pull the shared COTS library in the background
    adminOps.loadAdminConfig().then(cfg => {
      if (cfg.cotsRepoUrl) gitOps.syncCotsRepo(cfg.cotsRepoUrl, cfg.cotsBranch).catch(() => {})
    }).catch(() => {})
    const win = getMainWindow()
    if (win) startWatching(dirPath, win)
    return currentProject
  })

  ipcMain.handle('sync', async () => {
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
    return gitOps.getStatus()
  })

  ipcMain.handle('get-history', async (_e, limit?: number) => {
    return gitOps.getHistory(limit)
  })

  ipcMain.handle('check-out', async (_e, filePath: string) => {
    await lockOps.checkOut(filePath)
  })

  ipcMain.handle('check-in', async (_e, filePath: string) => {
    await lockOps.checkIn(filePath)
  })

  ipcMain.handle('force-check-in', async (_e, filePath: string) => {
    await lockOps.forceCheckIn(filePath)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('get-locks', async () => {
    return lockOps.getLocks()
  })

  ipcMain.handle('get-remote-ahead', async () => {
    return gitOps.getRemoteAhead()
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
    const projectDir = gitOps.getProjectPath()
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
    const result = await partsOps.createNewPart(folder, description)
    queuePendingCreate('part', result.filePath, result.partNumber)
    return result
  })

  ipcMain.handle('create-new-assembly', async (_e, parentFolder: string, name: string, description?: string) => {
    const result = await partsOps.createNewAssembly(parentFolder, name, description)
    queuePendingCreate('assembly', result.filePath, result.partNumber)
    return result
  })

  ipcMain.handle('create-subsystem', async (_e, parentFolder: string, name: string) => {
    return partsOps.createSubsystem(parentFolder, name)
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
    clearRestProject()
    stopWatching()
    clearThumbnailCache()
  })

  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('check-dependencies', async () => depsOps.checkDependencies())
  ipcMain.handle('github-auth-status', async () => authOps.githubAuthStatus())
  ipcMain.handle('github-login', async () => authOps.githubLogin())
  ipcMain.handle('github-logout', async () => authOps.githubLogout())

  ipcMain.handle('report-issue', async (_e, errorMessage: string) => {
    return reportIssue(errorMessage || '')
  })

  ipcMain.handle('generate-document', async (_e, type: DocType) => {
    try {
      const cfg = await import('./git').then(m => m.getGit())
      const raw = await cfg.raw(['config', '--get', 'user.name']).catch(() => '')
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
      return { success: true, files }
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
    await resetAllAppState()
  })

  ipcMain.handle('sync-cots', async () => {
    const config = await adminOps.loadAdminConfig()
    if (!config.cotsRepoUrl) return { success: false, error: 'No COTS repo configured' }
    return gitOps.syncCotsRepo(config.cotsRepoUrl, config.cotsBranch)
  })

  ipcMain.handle('create-progress-tag', async (_e, name: string, message?: string) => {
    return gitOps.createProgressTag(name, message)
  })

  ipcMain.handle('get-part-meta', async (_e, filePath: string) => {
    return metaOps.getPartMeta(filePath)
  })

  ipcMain.handle('get-where-used', async (_e, filePath: string) => {
    return partsOps.findWhereUsed(filePath)
  })

  ipcMain.handle('get-thumbnail', async (_e, filePath: string, size: number) => {
    return getThumbnail(filePath, size)
  })

  ipcMain.handle('set-release-state', async (_e, filePath: string, state: string, note?: string) => {
    await metaOps.setReleaseState(filePath, state as Parameters<typeof metaOps.setReleaseState>[1], note)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('add-comment', async (_e, filePath: string, text: string) => {
    await metaOps.addComment(filePath, text)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('set-manufacturing-notes', async (_e, filePath: string, notes: string) => {
    await metaOps.setManufacturingNotes(filePath, notes)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('set-part-mass', async (_e, filePath: string, mass: number | null) => {
    await metaOps.setPartMass(filePath, mass)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('set-part-cost', async (_e, filePath: string, cost: number | null) => {
    await metaOps.setPartCost(filePath, cost)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('get-project-totals', async () => {
    return metaOps.getProjectTotals()
  })

  ipcMain.handle('set-mfg-method', async (_e, filePath: string, method: string | null) => {
    await metaOps.setManufacturingMethod(filePath, method as Parameters<typeof metaOps.setManufacturingMethod>[1])
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('set-mfg-material', async (_e, filePath: string, material: string) => {
    await metaOps.setManufacturingMaterial(filePath, material)
    broadcastStatus(getMainWindow)
  })

  ipcMain.handle('bulk-update-meta', async (_e, updates: Record<string, metaOps.BulkMetaPatch>) => {
    const n = await metaOps.bulkUpdateMeta(updates)
    broadcastStatus(getMainWindow)
    return n
  })

  ipcMain.handle('get-manufacturing-queue', async () => {
    return metaOps.getManufacturingQueue()
  })

  // Status surfaced to the admin Export Queue tab so the UI can tell
  // whether a batch-export would actually go anywhere (SW must be open
  // and polling for any of this to do work).
  ipcMain.handle('get-export-status', async () => {
    const queue = await metaOps.getManufacturingQueue()
    const needsExport = queue.filter(q => !!q.needsExport)
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
    const queue = await metaOps.getManufacturingQueue()
    const item = queue.find(q => q.path === filePath)
    if (!item) throw new Error(`Part not released or not found: ${filePath}`)
    if (!item.needsExport) return { taskId: null, alreadyExists: true }
    const projectPath = gitOps.getProjectPath()
    const task = exportQueue.queuePendingExport(projectPath, filePath, item.needsExport)
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
    return metaOps.loadAllMeta()
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

  // ── Coordination repo ──
  ipcMain.handle('get-coordination-state', () => coordOps.getCoordinationState())
  ipcMain.handle('preview-coordination-repo', (_e, url: string) => coordOps.previewCoordinationRepo(url))
  ipcMain.handle('setup-coordination-repo', (_e, url: string) => coordOps.setupCoordinationRepo(url))
  ipcMain.handle('create-coordination-repo', (_e, org: string, name: string) => coordOps.createCoordinationRepo(org, name))
  ipcMain.handle('sync-coordination-repo', () => coordOps.syncCoordinationRepo())
  ipcMain.handle('disconnect-coordination-repo', () => coordOps.disconnectCoordinationRepo())
  ipcMain.handle('request-to-join-team', (_e, displayName: string) => coordOps.requestToJoinTeam(displayName))
  ipcMain.handle('get-pending-join-requests', () => coordOps.getPendingJoinRequests())
  ipcMain.handle('approve-join-request', (_e, username: string, displayName: string, role: string, issueNum: number) =>
    coordOps.approveJoinRequest(username, displayName, role as import('@shared/types').MemberRole, issueNum))
  ipcMain.handle('deny-join-request', (_e, issueNum: number) => coordOps.denyJoinRequest(issueNum))
  ipcMain.handle('add-team-member', (_e, member) => coordOps.addTeamMember(member))
  ipcMain.handle('remove-team-member', (_e, username: string) => coordOps.removeTeamMember(username))
  ipcMain.handle('update-team-member', (_e, username: string, updates) => coordOps.updateTeamMember(username, updates))
  ipcMain.handle('save-team-config', (_e, config) => coordOps.saveTeamConfig(config))
  ipcMain.handle('add-project-to-registry', (_e, project) => coordOps.addProjectToRegistry(project))
  ipcMain.handle('remove-project-from-registry', (_e, url: string) => coordOps.removeProjectFromRegistry(url))
}

export { stopWatching, stopRestServer }

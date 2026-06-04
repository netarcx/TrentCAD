import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi } from '@shared/types'

const api: IpcApi = {
  openProject: (path) =>
    ipcRenderer.invoke('open-project', path),

  closeProject: () =>
    ipcRenderer.invoke('close-project'),

  sync: () =>
    ipcRenderer.invoke('sync'),

  publish: (message) =>
    ipcRenderer.invoke('publish', message),

  getStatus: () =>
    ipcRenderer.invoke('get-status'),

  getHistory: (limit?) =>
    ipcRenderer.invoke('get-history', limit),

  checkOut: (filePath) =>
    ipcRenderer.invoke('check-out', filePath),

  checkIn: (filePath) =>
    ipcRenderer.invoke('check-in', filePath),

  forceCheckIn: (filePath) =>
    ipcRenderer.invoke('force-check-in', filePath),

  getLocks: () =>
    ipcRenderer.invoke('get-locks'),

  setLegacyMode: (enabled) =>
    ipcRenderer.invoke('set-legacy-mode', enabled),

  selectDirectory: () =>
    ipcRenderer.invoke('select-directory'),

  openFileExplorer: (path) =>
    ipcRenderer.invoke('open-file-explorer', path),

  getProjectConfig: () =>
    ipcRenderer.invoke('get-project-config'),

  getPartsManifest: () =>
    ipcRenderer.invoke('get-parts-manifest'),

  createNewPart: (folder, description?) =>
    ipcRenderer.invoke('create-new-part', folder, description),

  createNewAssembly: (parentFolder, name, description?) =>
    ipcRenderer.invoke('create-new-assembly', parentFolder, name, description),

  getRecentProjects: () =>
    ipcRenderer.invoke('get-recent-projects'),

  setProjectPinned: (projectPath, pinned) =>
    ipcRenderer.invoke('set-project-pinned', projectPath, pinned),

  removeRecentProject: (projectPath) =>
    ipcRenderer.invoke('remove-recent-project', projectPath),

  createSubsystem: (parentFolder, name) =>
    ipcRenderer.invoke('create-subsystem', parentFolder, name),

  getGitIdentity: () =>
    ipcRenderer.invoke('get-git-identity'),

  restartToUpdate: () =>
    ipcRenderer.invoke('restart-to-update'),

  checkForUpdate: () =>
    ipcRenderer.invoke('check-for-update'),

  cancelUpdateRetry: () =>
    ipcRenderer.invoke('cancel-update-retry'),

  getAppVersion: () =>
    ipcRenderer.invoke('get-app-version'),

  getOsHostname: () =>
    ipcRenderer.invoke('get-os-hostname'),

  getOsUsername: () =>
    ipcRenderer.invoke('get-os-username'),

  openExternal: (url) =>
    ipcRenderer.invoke('open-external', url),

  reportIssue: (errorMessage) =>
    ipcRenderer.invoke('report-issue', errorMessage),

  generateDocument: (type) =>
    ipcRenderer.invoke('generate-document', type),

  openPath: (absPath) =>
    ipcRenderer.invoke('open-path', absPath),

  revealInFolder: (absPath) =>
    ipcRenderer.invoke('reveal-in-folder', absPath),

  getAdminConfig: () =>
    ipcRenderer.invoke('get-admin-config'),

  getGlobalAdmin: () =>
    ipcRenderer.invoke('get-global-admin'),

  saveGlobalAdmin: (config) =>
    ipcRenderer.invoke('save-global-admin', config),

  resetGlobalAdmin: () =>
    ipcRenderer.invoke('reset-global-admin'),

  resetAllAppState: () =>
    ipcRenderer.invoke('reset-all-app-state'),

  saveAdminConfig: (config) =>
    ipcRenderer.invoke('save-admin-config', config),

  syncCots: () =>
    ipcRenderer.invoke('sync-cots'),

  getPartMeta: (filePath) =>
    ipcRenderer.invoke('get-part-meta', filePath),

  getWhereUsed: (filePath) =>
    ipcRenderer.invoke('get-where-used', filePath),

  getThumbnail: (filePath, size) =>
    ipcRenderer.invoke('get-thumbnail', filePath, size),

  setReleaseState: (filePath, state, note, location) =>
    ipcRenderer.invoke('set-release-state', filePath, state, note, location),

  addComment: (filePath, text) =>
    ipcRenderer.invoke('add-comment', filePath, text),

  setManufacturingNotes: (filePath, notes) =>
    ipcRenderer.invoke('set-manufacturing-notes', filePath, notes),

  setPartMass: (filePath, mass) =>
    ipcRenderer.invoke('set-part-mass', filePath, mass),

  setPartCost: (filePath, cost) =>
    ipcRenderer.invoke('set-part-cost', filePath, cost),

  getProjectTotals: () =>
    ipcRenderer.invoke('get-project-totals'),

  setManufacturingMethod: (filePath, method) =>
    ipcRenderer.invoke('set-mfg-method', filePath, method),

  setManufacturingMaterial: (filePath, material) =>
    ipcRenderer.invoke('set-mfg-material', filePath, material),

  setPurchaseInfo: (filePath, patch) =>
    ipcRenderer.invoke('set-purchase-info', filePath, patch),

  bulkUpdateMeta: (updates) =>
    ipcRenderer.invoke('bulk-update-meta', updates),

  getManufacturingQueue: () =>
    ipcRenderer.invoke('get-manufacturing-queue'),

  getExportStatus: () =>
    ipcRenderer.invoke('get-export-status'),

  triggerPartExport: (filePath) =>
    ipcRenderer.invoke('trigger-part-export', filePath),

  triggerBatchExport: () =>
    ipcRenderer.invoke('trigger-batch-export'),

  getAllPartsMeta: () =>
    ipcRenderer.invoke('get-all-parts-meta'),

  checkManifestIntegrity: () =>
    ipcRenderer.invoke('check-manifest-integrity'),

  // Team server (replaces coord repo)
  teamGetSnapshot: () =>
    ipcRenderer.invoke('team-get-snapshot'),

  teamRefresh: () =>
    ipcRenderer.invoke('team-refresh'),

  teamEnroll: (args) =>
    ipcRenderer.invoke('team-enroll', args),

  teamLoginDevice: (args) =>
    ipcRenderer.invoke('team-login-device', args),

  teamSignOut: () =>
    ipcRenderer.invoke('team-sign-out'),

  teamAdminUiUrl: () =>
    ipcRenderer.invoke('team-admin-ui-url'),

  teamPingServer: () =>
    ipcRenderer.invoke('team-ping-server'),

  onTeamSnapshot: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) =>
      callback(snapshot as Parameters<typeof callback>[0])
    ipcRenderer.on('team-snapshot', handler)
    return () => ipcRenderer.removeListener('team-snapshot', handler)
  },

  // Archive mode (read-only local mirror)
  archiveGetStatus: () =>
    ipcRenderer.invoke('archive-get-status'),

  archiveSyncNow: () =>
    ipcRenderer.invoke('archive-sync-now'),

  archiveChooseRoot: () =>
    ipcRenderer.invoke('archive-choose-root'),

  onArchiveStatus: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) =>
      callback(status as Parameters<typeof callback>[0])
    ipcRenderer.on('archive-status', handler)
    return () => ipcRenderer.removeListener('archive-status', handler)
  },

  onFileChange: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, files: unknown) =>
      callback(files as Parameters<typeof callback>[0])
    ipcRenderer.on('file-change', handler)
    return () => ipcRenderer.removeListener('file-change', handler)
  },

  consumePendingDeepLink: () =>
    ipcRenderer.invoke('consume-pending-deep-link'),

  onDeepLink: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) =>
      callback(payload as Parameters<typeof callback>[0])
    ipcRenderer.on('deep-link', handler)
    return () => ipcRenderer.removeListener('deep-link', handler)
  },

  onError: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) =>
      callback(error)
    ipcRenderer.on('error', handler)
    return () => ipcRenderer.removeListener('error', handler)
  },

  onUpdateAvailable: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, info: unknown) =>
      callback(info as Parameters<typeof callback>[0])
    ipcRenderer.on('update-available', handler)
    return () => ipcRenderer.removeListener('update-available', handler)
  },

  onUpdateDownloadProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: unknown) =>
      callback(progress as Parameters<typeof callback>[0])
    ipcRenderer.on('update-download-progress', handler)
    return () => ipcRenderer.removeListener('update-download-progress', handler)
  },

  onUpdateDownloaded: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('update-downloaded', handler)
    return () => ipcRenderer.removeListener('update-downloaded', handler)
  },

  onUpdateRetryStatus: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as Parameters<typeof callback>[0])
    ipcRenderer.on('update-retry-status', handler)
    return () => ipcRenderer.removeListener('update-retry-status', handler)
  },

  onPublishProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: unknown) =>
      callback(progress as Parameters<typeof callback>[0])
    ipcRenderer.on('publish-progress', handler)
    return () => ipcRenderer.removeListener('publish-progress', handler)
  },

  onJoinProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: unknown) =>
      callback(progress as Parameters<typeof callback>[0])
    ipcRenderer.on('join-progress', handler)
    return () => ipcRenderer.removeListener('join-progress', handler)
  },

  // Google Drive storage backend
  googleAuthStatus: () =>
    ipcRenderer.invoke('google-auth-status'),

  googleSignIn: () =>
    ipcRenderer.invoke('google-sign-in'),

  googleSignOut: () =>
    ipcRenderer.invoke('google-sign-out'),

  driveListSharedDrives: () =>
    ipcRenderer.invoke('drive-list-shared-drives'),

  driveListFolders: (sharedDriveId) =>
    ipcRenderer.invoke('drive-list-folders', sharedDriveId),

  driveJoinProject: (args) =>
    ipcRenderer.invoke('drive-join-project', args)
}

contextBridge.exposeInMainWorld('api', api)

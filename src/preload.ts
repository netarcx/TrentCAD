import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi } from '@shared/types'

const api: IpcApi = {
  createProject: (name, path, remote, isCotsProject) =>
    ipcRenderer.invoke('create-project', name, path, remote, isCotsProject),

  joinProject: (url, path) =>
    ipcRenderer.invoke('join-project', url, path),

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

  getRemoteAhead: () =>
    ipcRenderer.invoke('get-remote-ahead'),

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

  setGitIdentity: (name, email) =>
    ipcRenderer.invoke('set-git-identity', name, email),

  restartToUpdate: () =>
    ipcRenderer.invoke('restart-to-update'),

  checkForUpdate: () =>
    ipcRenderer.invoke('check-for-update'),

  getAppVersion: () =>
    ipcRenderer.invoke('get-app-version'),

  checkDependencies: () =>
    ipcRenderer.invoke('check-dependencies'),

  openExternal: (url) =>
    ipcRenderer.invoke('open-external', url),

  githubAuthStatus: () =>
    ipcRenderer.invoke('github-auth-status'),

  githubLogin: () =>
    ipcRenderer.invoke('github-login'),

  githubLogout: () =>
    ipcRenderer.invoke('github-logout'),

  reportIssue: (errorMessage) =>
    ipcRenderer.invoke('report-issue', errorMessage),

  generateDocument: (type) =>
    ipcRenderer.invoke('generate-document', type),

  openPath: (absPath) =>
    ipcRenderer.invoke('open-path', absPath),

  revealInFolder: (absPath) =>
    ipcRenderer.invoke('reveal-in-folder', absPath),

  scanLargeFiles: () =>
    ipcRenderer.invoke('scan-large-files'),

  gitResetup: () =>
    ipcRenderer.invoke('git-resetup'),

  listGitHubRepos: (org, prefix) =>
    ipcRenderer.invoke('list-github-repos', org, prefix),

  createGitHubRepo: (org, name, isPrivate, description) =>
    ipcRenderer.invoke('create-github-repo', org, name, isPrivate, description),

  getAdminConfig: () =>
    ipcRenderer.invoke('get-admin-config'),

  getGlobalAdmin: () =>
    ipcRenderer.invoke('get-global-admin'),

  saveGlobalAdmin: (config) =>
    ipcRenderer.invoke('save-global-admin', config),

  resetGlobalAdmin: () =>
    ipcRenderer.invoke('reset-global-admin'),

  saveAdminConfig: (config) =>
    ipcRenderer.invoke('save-admin-config', config),

  syncCots: () =>
    ipcRenderer.invoke('sync-cots'),

  createProgressTag: (name, message) =>
    ipcRenderer.invoke('create-progress-tag', name, message),

  getMainRemoteUrl: () =>
    ipcRenderer.invoke('get-main-remote-url'),

  getPartMeta: (filePath) =>
    ipcRenderer.invoke('get-part-meta', filePath),

  getWhereUsed: (filePath) =>
    ipcRenderer.invoke('get-where-used', filePath),

  getThumbnail: (filePath, size) =>
    ipcRenderer.invoke('get-thumbnail', filePath, size),

  setReleaseState: (filePath, state, note) =>
    ipcRenderer.invoke('set-release-state', filePath, state, note),

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

  renormalizeAll: () =>
    ipcRenderer.invoke('renormalize-all'),

  // Coordination repo
  getCoordinationState: () =>
    ipcRenderer.invoke('get-coordination-state'),

  previewCoordinationRepo: (repoUrl) =>
    ipcRenderer.invoke('preview-coordination-repo', repoUrl),

  setupCoordinationRepo: (repoUrl) =>
    ipcRenderer.invoke('setup-coordination-repo', repoUrl),

  createCoordinationRepo: (org, repoName) =>
    ipcRenderer.invoke('create-coordination-repo', org, repoName),

  syncCoordinationRepo: () =>
    ipcRenderer.invoke('sync-coordination-repo'),

  disconnectCoordinationRepo: () =>
    ipcRenderer.invoke('disconnect-coordination-repo'),

  requestToJoinTeam: (displayName) =>
    ipcRenderer.invoke('request-to-join-team', displayName),

  getPendingJoinRequests: () =>
    ipcRenderer.invoke('get-pending-join-requests'),

  approveJoinRequest: (githubUsername, displayName, role, issueNumber) =>
    ipcRenderer.invoke('approve-join-request', githubUsername, displayName, role, issueNumber),

  denyJoinRequest: (issueNumber) =>
    ipcRenderer.invoke('deny-join-request', issueNumber),

  addTeamMember: (member) =>
    ipcRenderer.invoke('add-team-member', member),

  removeTeamMember: (githubUsername) =>
    ipcRenderer.invoke('remove-team-member', githubUsername),

  updateTeamMember: (githubUsername, updates) =>
    ipcRenderer.invoke('update-team-member', githubUsername, updates),

  saveTeamConfig: (config) =>
    ipcRenderer.invoke('save-team-config', config),

  addProjectToRegistry: (project) =>
    ipcRenderer.invoke('add-project-to-registry', project),

  removeProjectFromRegistry: (repoUrl) =>
    ipcRenderer.invoke('remove-project-from-registry', repoUrl),

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
  }
}

contextBridge.exposeInMainWorld('api', api)

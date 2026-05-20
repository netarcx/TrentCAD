export interface ProjectConfig {
  name: string
  path: string
  remote: string
  partPrefix?: string
  /** When true, kept in the recent-projects list permanently and shown
   *  before unpinned entries on the Open Project picker. */
  pinned?: boolean
}

export type FileState = 'synced' | 'modified' | 'untracked' | 'locked-by-you' | 'locked-by-other'

export type ReleaseState = 'draft' | 'in-review' | 'released' | 'manufactured'

export interface PartComment {
  id: string
  author: string
  text: string
  at: string
}

export interface PartReleaseInfo {
  state: ReleaseState
  by?: string
  at?: string
  note?: string
}

export type ManufacturingMethod = 'print' | 'cnc' | 'manual' | 'other'

export interface DeepLinkPayload {
  action: 'join' | 'team'
  url: string
}

export interface BulkMetaPatch {
  release?: ReleaseState
  manufacturingMethod?: ManufacturingMethod | null
  manufacturingMaterial?: string | null
  /** Per-part mass in pounds. null clears the value. */
  mass?: number | null
  /** Per-part cost in dollars. null clears the value. */
  cost?: number | null
  /** Manufacturing notes — overwrites the existing notes string. */
  manufacturingNotes?: string
}

export interface PartMeta {
  release?: PartReleaseInfo
  comments?: PartComment[]
  manufacturingNotes?: string
  /** Mass in pounds */
  mass?: number
  /** Cost in USD */
  cost?: number
  manufacturingMethod?: ManufacturingMethod
  manufacturingMaterial?: string
}

export interface ManufacturingQueueItem {
  path: string
  method: ManufacturingMethod
  material?: string
  mass?: number
  notes?: string
  releasedBy?: string
  releasedAt?: string
  /** Set when a CAM-ready export (.step for cnc, .stl for print) is
   *  expected for this part but the file is missing on disk. */
  needsExport?: 'step' | 'stl'
  /** Project-relative path the export should land at, when needsExport is set. */
  expectedExportPath?: string
}

export interface ProjectTotals {
  mass: number
  cost: number
  partsWithMass: number
  partsWithCost: number
  totalParts: number
}

export interface FileEntry {
  path: string
  name: string
  isDirectory: boolean
  state: FileState
  lockedBy?: string
  partNumber?: string
  partDescription?: string
  releaseState?: ReleaseState
  commentCount?: number
  children?: FileEntry[]
}

export interface LockInfo {
  path: string
  owner: string
  id: string
}

export interface HistoryEntry {
  hash: string
  message: string
  author: string
  date: string
  files: string[]
}

export interface PublishResult {
  success: boolean
  hash?: string
  error?: string
}

export interface SyncResult {
  success: boolean
  filesUpdated: number
  error?: string
}

export interface GitStatusFile {
  path: string
  index: string
  working_dir: string
}

export type PartType = 'part' | 'assembly' | 'drawing'

export interface PartEntry {
  partNumber: string
  assignedAt: string
  type: PartType
  description?: string
  linkedTo?: string
}

export interface PartsManifest {
  prefix: string
  nextCounters: Record<string, number>
  nextAssemblyCounters: Record<string, number>
  entries: Record<string, PartEntry>
  assemblies: Record<string, string>
  /** When true, partNumbers are the file's base name (without
   *  extension) instead of a generated YY-team-XX-YYY number.
   *  Auto-set when FrameCAD opens an existing project that has CAD
   *  files but no prior parts.json — preserves the team's existing
   *  naming so we don't rename or shadow files they've already built
   *  around. Toggleable from Project Settings; the underlying numbers
   *  are still tracked in `entries` so a future flip back to scheme
   *  mode would only affect new files. */
  legacyMode?: boolean
}

export interface UpdateInfo {
  version: string
}

export interface PublishProgress {
  phase: 'preparing' | 'uploading' | 'done' | 'error'
  files?: string[]
  percent?: number
  detail?: string
  error?: string
}

export interface DependencyStatus {
  git: { installed: boolean; version?: string }
  lfs: { installed: boolean; version?: string }
}

export interface GitHubAuthStatus {
  ghCliAvailable: boolean
  loggedIn: boolean
  username?: string
}

export interface AdminConfig {
  /** Per-project default part-number prefix (e.g. "26-2129") */
  defaultPartPrefix?: string
  mainRepoUrl?: string
  cotsRepoUrl?: string
  cotsBranch?: string
  isCotsProject?: boolean
  /**
   * Optional override for where LFS object bytes are stored. When set,
   * FrameCAD writes a `.lfsconfig` file at the project root pointing at
   * this URL — git clone/pull/push respect it for LFS operations while
   * the repo itself stays on GitHub. Blank = use GitHub LFS (default).
   * Auth is left to the user via .netrc / git credential.
   */
  lfsUrl?: string
  /** Suppress the project-totals mass rollup (status bar, BOM summary).
   *  Useful for projects without a meaningful weight target. Default
   *  (undefined) = shown. */
  hideMass?: boolean
  /** As above for cost. */
  hideCost?: boolean
}

/**
 * Settings that apply to the FrameCAD install as a whole, not to any
 * single project. Defaults are baked in at build time from GH Actions
 * secrets; users override locally via the Settings page
 * and their overrides persist across app updates.
 */
export interface GlobalAdminConfig {
  teamName?: string
  welcomeMessage?: string
  gitHubOrg?: string
  projectPrefix?: string
}

export interface GlobalAdminState {
  effective: GlobalAdminConfig
  defaults: GlobalAdminConfig
  hasLocalOverride: boolean
}

// ── Coordination Repo ──

export type MemberRole = 'admin' | 'mentor' | 'student'
export type MemberStatus = 'active' | 'inactive'

export interface TeamConfig {
  teamName: string
  welcomeMessage?: string
  gitHubOrg: string
  projectPrefix: string
}

export interface TeamMember {
  githubUsername: string
  displayName: string
  role: MemberRole
  status: MemberStatus
  joinedAt: string
}

export interface ProjectEntry {
  name: string
  repoUrl: string
  description?: string
  createdAt: string
  archived?: boolean
}

export interface JoinRequest {
  issueNumber: number
  githubUsername: string
  displayName: string
  requestedAt: string
}

export interface CoordinationState {
  configured: boolean
  repoUrl?: string
  team?: TeamConfig
  members?: TeamMember[]
  projects?: ProjectEntry[]
  isMember?: boolean
  currentUserRole?: MemberRole
  pendingRequests?: JoinRequest[]
  lastSyncAt?: string
}

export interface GitHubRepoSummary {
  name: string
  description?: string
  url: string
  updatedAt?: string
  isPrivate?: boolean
}

export interface AppState {
  currentProject: ProjectConfig | null
  files: FileEntry[]
  locks: LockInfo[]
  history: HistoryEntry[]
  isLoading: boolean
  error: string | null
}

export interface IpcApi {
  createProject(name: string, path: string, remote: string, isCotsProject?: boolean): Promise<void>
  joinProject(url: string, path: string): Promise<void>
  openProject(path: string): Promise<ProjectConfig>
  closeProject(): Promise<void>
  sync(): Promise<SyncResult>
  publish(message: string): Promise<PublishResult>
  getStatus(): Promise<FileEntry[]>
  getHistory(limit?: number): Promise<HistoryEntry[]>
  checkOut(filePath: string): Promise<void>
  checkIn(filePath: string): Promise<void>
  forceCheckIn(filePath: string): Promise<void>
  getLocks(): Promise<LockInfo[]>
  getRemoteAhead(): Promise<number>
  setLegacyMode(enabled: boolean): Promise<void>
  selectDirectory(): Promise<string | null>
  openFileExplorer(path: string): Promise<void>
  getProjectConfig(): Promise<ProjectConfig | null>
  getPartsManifest(): Promise<PartsManifest | null>
  createNewPart(folder: string, description?: string): Promise<{ partNumber: string; filePath: string }>
  createNewAssembly(parentFolder: string, name: string, description?: string): Promise<{ partNumber: string; filePath: string }>
  getRecentProjects(): Promise<ProjectConfig[]>
  setProjectPinned(projectPath: string, pinned: boolean): Promise<void>
  removeRecentProject(projectPath: string): Promise<void>
  createSubsystem(parentFolder: string, name: string): Promise<{ folderPath: string }>
  getGitIdentity(): Promise<{ name: string; email: string }>
  setGitIdentity(name: string, email: string): Promise<void>
  restartToUpdate(): Promise<void>
  checkForUpdate(): Promise<{
    success: boolean
    currentVersion?: string
    latestVersion?: string
    updateAvailable?: boolean
    /** True when the check succeeded but no GitHub release exists yet
     *  (typical for a fresh repo / first build pre-publish). Lets the
     *  UI show a calm "no releases yet" message instead of an error. */
    noReleasesYet?: boolean
    error?: string
  }>
  getAppVersion(): Promise<string>
  checkDependencies(): Promise<DependencyStatus>
  openExternal(url: string): Promise<void>
  githubAuthStatus(): Promise<GitHubAuthStatus>
  githubLogin(): Promise<{ launched: boolean; error?: string }>
  githubLogout(): Promise<{ success: boolean; error?: string }>
  reportIssue(errorMessage: string): Promise<{ success: boolean; url?: string; number?: number; error?: string }>
  generateDocument(type: 'bom' | 'manufacturing' | 'summary' | 'bom-by-subsystem'): Promise<{ success: boolean; filePath?: string; relPath?: string; pdfFilePath?: string; pdfRelPath?: string; pdfError?: string; error?: string }>
  openPath(absPath: string): Promise<{ success: boolean; error?: string }>
  revealInFolder(absPath: string): Promise<{ success: boolean; error?: string }>
  scanLargeFiles(): Promise<{
    success: boolean
    files: Array<{
      path: string
      absolutePath: string
      size: number
      isLfsTracked: boolean
      status: 'blocker' | 'warning' | 'ok-lfs' | 'lfs-too-large'
    }>
    error?: string
  }>
  gitResetup(): Promise<{ success: boolean; messages: string[]; error?: string }>
  listGitHubRepos(org: string, prefix?: string): Promise<{ success: boolean; repos: GitHubRepoSummary[]; error?: string }>
  createGitHubRepo(org: string, name: string, isPrivate: boolean, description?: string): Promise<{ success: boolean; url?: string; error?: string }>
  getAdminConfig(): Promise<AdminConfig>
  getGlobalAdmin(): Promise<GlobalAdminState>
  saveGlobalAdmin(config: GlobalAdminConfig): Promise<void>
  resetGlobalAdmin(): Promise<void>
  resetAllAppState(): Promise<void>
  saveAdminConfig(config: AdminConfig): Promise<void>
  syncCots(): Promise<{ success: boolean; cloned?: boolean; error?: string }>
  createProgressTag(name: string, message?: string): Promise<{ success: boolean; error?: string }>
  getMainRemoteUrl(): Promise<string>
  getPartMeta(filePath: string): Promise<PartMeta>
  getWhereUsed(filePath: string): Promise<string[]>
  getThumbnail(filePath: string, size: number): Promise<string | null>
  setReleaseState(filePath: string, state: ReleaseState, note?: string): Promise<void>
  addComment(filePath: string, text: string): Promise<void>
  setManufacturingNotes(filePath: string, notes: string): Promise<void>
  setPartMass(filePath: string, mass: number | null): Promise<void>
  setPartCost(filePath: string, cost: number | null): Promise<void>
  getProjectTotals(): Promise<ProjectTotals>
  setManufacturingMethod(filePath: string, method: ManufacturingMethod | null): Promise<void>
  setManufacturingMaterial(filePath: string, material: string): Promise<void>
  bulkUpdateMeta(updates: Record<string, BulkMetaPatch>): Promise<number>
  getManufacturingQueue(): Promise<ManufacturingQueueItem[]>
  getExportStatus(): Promise<{
    swAlive: boolean
    lastSwSeenAt: number
    pendingTasks: number
    needsExport: ManufacturingQueueItem[]
  }>
  triggerPartExport(filePath: string): Promise<{ taskId: string | null; alreadyExists: boolean }>
  triggerBatchExport(): Promise<{ queued: number }>
  getAllPartsMeta(): Promise<Record<string, PartMeta>>
  checkManifestIntegrity(): Promise<{
    success: boolean
    duplicates?: Array<{ partNumber: string; paths: string[] }>
    orphanedDrawings?: Array<{ path: string; linkedTo: string }>
    tombstones?: string[]
    orphanedMeta?: string[]
    error?: string
  }>
  renormalizeAll(): Promise<{ success: boolean; error?: string }>
  onFileChange(callback: (files: FileEntry[]) => void): () => void
  consumePendingDeepLink(): Promise<DeepLinkPayload | null>
  onDeepLink(callback: (payload: DeepLinkPayload) => void): () => void
  onError(callback: (error: string) => void): () => void
  onUpdateAvailable(callback: (info: UpdateInfo) => void): () => void
  onUpdateDownloadProgress(callback: (progress: { percent: number }) => void): () => void
  onUpdateDownloaded(callback: () => void): () => void
  onPublishProgress(callback: (progress: PublishProgress) => void): () => void
  onJoinProgress(callback: (progress: PublishProgress) => void): () => void

  // Coordination repo
  getCoordinationState(): Promise<CoordinationState>
  previewCoordinationRepo(repoUrl: string): Promise<CoordinationState>
  setupCoordinationRepo(repoUrl: string): Promise<CoordinationState>
  createCoordinationRepo(org: string, repoName: string): Promise<{ success: boolean; url?: string; error?: string }>
  syncCoordinationRepo(): Promise<CoordinationState>
  disconnectCoordinationRepo(): Promise<void>
  requestToJoinTeam(displayName: string): Promise<{ success: boolean; issueNumber?: number; error?: string }>
  getPendingJoinRequests(): Promise<JoinRequest[]>
  approveJoinRequest(githubUsername: string, displayName: string, role: MemberRole, issueNumber: number): Promise<{ orgInviteFailed?: boolean }>
  denyJoinRequest(issueNumber: number): Promise<void>
  addTeamMember(member: Omit<TeamMember, 'joinedAt'>): Promise<void>
  removeTeamMember(githubUsername: string): Promise<void>
  updateTeamMember(githubUsername: string, updates: Partial<Pick<TeamMember, 'role' | 'status' | 'displayName'>>): Promise<void>
  saveTeamConfig(config: TeamConfig): Promise<void>
  addProjectToRegistry(project: Omit<ProjectEntry, 'createdAt'>): Promise<void>
  removeProjectFromRegistry(repoUrl: string): Promise<void>
}

declare global {
  interface Window {
    api: IpcApi
  }
}

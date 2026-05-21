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
  action: 'join'
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
  /** True when the failure was specifically "remote repo doesn't
   *  exist anymore" — the renderer shows a different help message
   *  pointing the user at their admin / suggesting local cleanup
   *  rather than the usual "retry?" copy. */
  remoteGone?: boolean
}

export interface SyncResult {
  success: boolean
  filesUpdated: number
  error?: string
  remoteGone?: boolean
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
  /** Per-file detail for the LFS transfer that's currently active.
   *  Populated during `phase === 'uploading'` when the git-lfs
   *  GIT_LFS_PROGRESS hook is wired up. The renderer shows this
   *  as a second progress line below the overall bar. Reads from
   *  whichever object git-lfs reported most recently — concurrent
   *  transfers (up to 12 at a time) all share this single field. */
  currentFile?: {
    path: string
    bytesTransferred: number
    totalBytes: number
  }
  /** True on the `phase === 'error'` event when the underlying git
   *  error matched the "remote unreachable" pattern (could be
   *  offline OR deleted on the server). Renderer cross-references
   *  the team snapshot to decide whether to surface the
   *  authoritative "deleted, back up files" copy. */
  remoteGone?: boolean
  /** Quota grace status from the server's `/api/lfs/token` response
   *  when the publish involved an LFS token mint. Renderer shows a
   *  warning banner when 'in-grace' so the user knows they're in
   *  the 24-hour window before writes get blocked. */
  quotaGrace?: 'ok' | 'in-grace' | 'expired'
  /** Timestamp (ms since epoch) when the grace window started.
   *  Renderer derives the remaining-time display from this. Only
   *  meaningful when `quotaGrace === 'in-grace'`. */
  quotaGraceStartedAt?: number
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
  /**
   * Subfolder inside the repo that holds the active project's content.
   * When set, FrameCAD presents this folder AS the project root — the
   * file tree only shows files inside it, new parts get created there
   * by default, and `parts.json` continues to live at the GIT root and
   * holds entries keyed by repo-relative paths.
   *
   * Use case: monorepo-style team repos where the robot lives at e.g.
   * `2026 Rebuilt/` and siblings like `COTS/` or `2025 Archive/` are
   * unrelated to the active project. Forward slashes, no leading or
   * trailing slash (e.g. `"2026 Rebuilt"`, not `"/2026 Rebuilt/"`).
   * Empty or undefined = repo root is the project root (original
   * behaviour, every existing project).
   */
  projectSubpath?: string
  /**
   * Optional sibling subfolder inside the SAME repo that holds COTS
   * parts. When set, the file tree hides this folder from project
   * views (it's not part of the active project) while still letting
   * the BOM and Where-Used see those parts. Mutually exclusive with
   * the `cotsRepoUrl` / `cotsBranch` "COTS lives in a separate repo"
   * flow: if both are set, the separate-repo flow wins. Same format
   * rules as `projectSubpath`.
   */
  cotsSubpath?: string
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
  /** Pre-baked team-server URL from the FRAMECAD_DEFAULT_SERVER_URL
   *  build-time env var. When set, the enrollment wizard uses this as
   *  the fallback server URL if the user pastes a bare PIN with no
   *  full link. Empty/undefined → user must paste a full link. */
  defaultServerUrl?: string
}

export interface GlobalAdminState {
  effective: GlobalAdminConfig
  defaults: GlobalAdminConfig
  hasLocalOverride: boolean
}

// ── Team Server (self-hosted coordination) ──
//
// The desktop client talks to a small Node + SQLite server (see
// `/server/`) instead of a coordination GitHub repo. The mental
// model is the same — a roster, a team config, a project registry,
// roles — but the wire protocol is HTTP + JSON and admin lives in
// the server's browser UI, not in this app.

export type MemberRole = 'admin' | 'mentor' | 'student'

export interface TeamConfig {
  name: string
  gitHubOrg: string
  projectPrefix: string
  welcomeMessage: string
  /** Base URL of the self-hosted Git-LFS server (Giftless) when the
   *  team server is configured for it; empty string otherwise. The
   *  desktop writes this into each project's `.lfsconfig` so all LFS
   *  traffic skips GitHub and lands on the team's own storage. */
  lfsUrl?: string
}

/**
 * Which home-screen buttons the member is allowed to see in FrameCAD.
 * Set per-PIN by the admin; copied to the member row on enrollment.
 * Independent of role — caps gate UI, role gates write-side power.
 */
export interface MemberCapabilities {
  createProject: boolean
  browseTeamProjects: boolean
  openProject: boolean
  manufacturingView: boolean
}

export interface TeamMember {
  id: number
  displayName: string
  githubUsername: string | null
  role: MemberRole
}

/** TeamMember + the per-user fields only the calling member sees about
 *  themselves: capability flags, project allowlist, auto-open id. The
 *  /api/members endpoint never returns these (privacy); /api/me does. */
export interface MyMember extends TeamMember {
  capabilities: MemberCapabilities
  /** If non-empty AND role==='student', the desktop should only show
   *  these project IDs in the Team Projects list. Empty = unrestricted. */
  allowedProjectIds: number[]
  /** When set, the desktop should auto-open this project on launch.
   *  Soft hint by default — closing the project returns to the
   *  welcome screen for the rest of the session. Null = no auto-open. */
  autoOpenProjectId: number | null
  /** Full kiosk lockdown. When true (and autoOpenProjectId is set),
   *  the desktop skips the welcome screen entirely, auto-reopens
   *  the project on close, and hides any UI that would let the user
   *  navigate to a different project. For shared shop computers. */
  kioskMode?: boolean
}

export interface ProjectEntry {
  id: number
  name: string
  repoUrl: string
  description?: string
  createdAt: number
  /** Server-confirmed reachability of the GitHub repo. 'missing' is
   *  the authoritative "this repo is gone — back up local files"
   *  signal the desktop reacts to. Clients should NOT downgrade a
   *  project based on their own failed git operations (those usually
   *  mean offline, not deleted). Optional so a legacy server that
   *  doesn't track remoteStatus still parses cleanly. */
  remoteStatus?: 'unknown' | 'ok' | 'missing'
}

/** What the renderer reads to decide what to render. Mirrors what the
 *  team server hands back from /api/team, /api/members, /api/projects,
 *  /api/me — all four bundled so the UI doesn't have to juggle four
 *  separate fetches. */
export interface TeamSnapshot {
  /** True once the user has successfully enrolled. */
  enrolled: boolean
  /** Server URL the device is talking to. */
  serverUrl: string | null
  /** Current user's member info + their per-user capability flags +
   *  per-user project allowlist + optional auto-open project id. */
  me: MyMember | null
  team: TeamConfig | null
  members: TeamMember[]
  projects: ProjectEntry[]
  /** Epoch ms of the last successful refresh; useful so UI can
   *  show "last synced" without firing a second call. */
  lastSyncAt: number | null
  /** Best-effort error string from the last fetch attempt, or null. */
  error: string | null
}

export interface EnrollResult {
  success: boolean
  /** Populated only when success === true. */
  snapshot?: TeamSnapshot
  /** Populated only when success === false. */
  error?: string
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
  /** Best-effort OS hostname for pre-filling the enrollment wizard's
   *  Device Label field. Returns '' on any failure. */
  getOsHostname(): Promise<string>
  /** Best-effort OS username for pre-filling the wizard's display-
   *  name field. Returns '' on any failure. */
  getOsUsername(): Promise<string>
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

  // Team server (replaces coordination repo).
  /** Cached snapshot — never hits the network. Returns enrolled=false if no team is wired. */
  teamGetSnapshot(): Promise<TeamSnapshot>
  /** Force a fresh fetch from the team server. Updates the cache. */
  teamRefresh(): Promise<TeamSnapshot>
  /** Trade a PIN + serverUrl for a bearer token. Stores the token + role locally. */
  teamEnroll(args: {
    serverUrl: string
    pin: string
    deviceLabel?: string
    displayName?: string
    githubUsername?: string
  }): Promise<EnrollResult>
  /** Drop the local token + cache. Server-side audit row still records the device. */
  teamSignOut(): Promise<void>
  /** Returns the URL to open the admin web UI in a browser (or null when not enrolled). */
  teamAdminUiUrl(): Promise<string | null>
  /** Subscribe to push notifications when the cached snapshot changes. */
  onTeamSnapshot(callback: (snapshot: TeamSnapshot) => void): () => void
}

declare global {
  interface Window {
    api: IpcApi
  }
}

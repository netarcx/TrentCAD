export interface ProjectConfig {
  name: string
  path: string
  remote: string
  partPrefix?: string
  /** When true, kept in the recent-projects list permanently and shown
   *  before unpinned entries on the Open Project picker. */
  pinned?: boolean
  /** Storage backend for this project. 'git' (the historical default —
   *  Git + LFS), 'drive' (Google Drive), or 'lore' (self-hosted Lore VCS).
   *  Absent = 'git' for any recent-project entry written before the Drive
   *  backend shipped. */
  backend?: 'git' | 'drive' | 'lore'
  /** Drive backend only: the Shared Drive folder id that IS this
   *  project, and the Shared Drive it lives in. Mirrors what the
   *  `.framecad/drive-manifest.json` records, surfaced here so the
   *  renderer and recent-projects list don't have to read the manifest. */
  driveFolderId?: string
  sharedDriveId?: string
  /** Lore backend only: the project's remote `lore://host:port/repo` URL.
   *  Mirrors `.framecad/lore-meta.json`; also the team-server lock/history
   *  key for a Lore project. */
  loreUrl?: string
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
  /** Where the finished part physically lives (shop dashboard). Captured when
   *  a part is marked 'manufactured'; preserved across later state changes so
   *  "where is part X" stays answerable. */
  location?: string
}

export type ManufacturingMethod = 'print' | 'cnc' | 'manual' | 'purchase' | 'other'

/** Order status for a part whose manufacturing method is 'purchase' (a
 *  bought, not made, part — COTS or a custom-order). Drives the Purchasing
 *  queue. 'received' is the purchase equivalent of 'manufactured'. */
export type PurchaseStatus = 'to-order' | 'ordered' | 'received'

export interface PartPurchaseInfo {
  vendor?: string
  /** Vendor part number / SKU. */
  sku?: string
  qty?: number
  /** Per-unit cost in USD. */
  unitCost?: number
  /** Product/order URL. */
  url?: string
  status?: PurchaseStatus
}

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
  /** Purchasing details, when manufacturingMethod === 'purchase'. */
  purchase?: PartPurchaseInfo
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

export type PartType = 'part' | 'assembly' | 'drawing'

export interface PartEntry {
  partNumber: string
  assignedAt: string
  type: PartType
  description?: string
  linkedTo?: string
  /**
   * This scheme number was assigned without a confirmed server claim — the
   * team server was unreachable when the part was created or auto-numbered.
   * A reconcile pass re-claims it on the next server contact; if the number
   * had already been taken, the server reassigns it (and, for a file that's
   * literally named by its number, the part is flagged for a rename). Cleared
   * once the number is confirmed. Absent/undefined = a confirmed number.
   */
  provisional?: boolean
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

export interface UpdateRetryStatus {
  status: 'waiting' | 'checking' | 'found' | 'none' | 'gave-up' | 'cancelled'
  attempt?: number
  maxAttempts?: number
  nextRetryMs?: number
}

export interface PublishProgress {
  phase: 'preparing' | 'uploading' | 'done' | 'error'
  files?: string[]
  percent?: number
  detail?: string
  error?: string
  /** True on the `phase === 'error'` event when the underlying error
   *  matched the "remote unreachable" pattern (could be offline OR
   *  deleted on the server). Renderer cross-references the team
   *  snapshot to decide whether to surface the authoritative
   *  "deleted, back up files" copy. */
  remoteGone?: boolean
}

/** Google account sign-in state for the Drive storage backend.
 *  `signedIn` is false before the OAuth loopback flow completes or
 *  after sign-out; email/name are cached for display in the UI. */
export interface GoogleAuthStatus {
  signedIn: boolean
  email?: string
  name?: string
}

/** A Google Shared Drive the signed-in user can see. Projects live as
 *  top-level folders inside one of these. */
export interface DriveSharedDrive {
  id: string
  name: string
}

/** A folder inside a Shared Drive — used by the "join project" picker
 *  to choose which top-level folder becomes the local project. */
export interface DriveFolder {
  id: string
  name: string
}

export interface AdminConfig {
  /** Per-project default part-number prefix (e.g. "26-2129") */
  defaultPartPrefix?: string
  isCotsProject?: boolean
  /**
   * Mark THIS project as imported — its files already have part numbers (from
   * a previous season, another team, or a non-FrameCAD source) that must be
   * preserved. Auto-assign then adopts each file using its existing filename
   * as the part number instead of imposing the YY-prefix scheme, so importing
   * never renumbers anyone's existing files. Equivalent to forcing legacy mode
   * for the project. Default (undefined) = a normal FrameCAD project that
   * auto-numbers new files with the scheme.
   */
  isImportedProject?: boolean
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
   * Optional sibling subfolder inside the SAME project that holds COTS
   * parts. When set, the file tree hides this folder from project
   * views (it's not part of the active project) while still letting
   * the BOM and Where-Used see those parts. Same format rules as
   * `projectSubpath`.
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
// `/server/`): a roster, a team config, a project registry,
// roles — the wire protocol is HTTP + JSON and admin lives in
// the server's browser UI, not in this app.

export type MemberRole = 'admin' | 'mentor' | 'student'

export interface TeamConfig {
  name: string
  gitHubOrg: string
  projectPrefix: string
  welcomeMessage: string
  /** Comma-separated Google Shared Drive IDs approved for Drive-backend
   *  projects. When non-empty, enrolled desktop clients use this as
   *  the Drive allowlist instead of the installer-baked fallback. */
  googleSharedDriveIds?: string
  /** Tunable per-team policies that used to be hardcoded constants
   *  in the desktop client. Server is the source of truth; the
   *  desktop falls back to the constants below if the snapshot
   *  isn't available (e.g. standalone mode). */
  policies?: TeamPolicies
}

/**
 * Per-team-server policy knobs. All values match the previous
 * hardcoded constants on the day this shipped, so a fresh DB with
 * no edits behaves byte-identically to the pre-policy versions.
 */
export interface TeamPolicies {
  /** Hard refusal at publish time. Range 10–2048 MB. The real
   *  per-file size backstop. */
  maxFileSizeMb: number
  /** File extensions (no leading dot, lowercase) refused at publish.
   *  Empty list = no blacklist; existing built-in remains as the
   *  default after migration v12. */
  blockedExtensions: string[]
  /** Vestigial since the Drive migration (no storage cap is enforced
   *  anymore). Kept because the server still emits it. */
  quotaGraceHours: number
}

/** Hardcoded fallbacks for desktop in standalone mode (not enrolled
 *  with a team server). Values must match the historical constants
 *  AND the migration v12 server-side defaults. */
export const DEFAULT_TEAM_POLICIES: TeamPolicies = {
  maxFileSizeMb: 256,
  blockedExtensions: [
    'mp4', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'm4v', 'flv', 'mpg', 'mpeg', '3gp',
    'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus',
    'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'txz', 'iso', 'lz', 'lzma', 'z',
    'exe', 'msi', 'dll', 'dmg', 'pkg', 'app', 'apk', 'deb', 'rpm',
    'bat', 'cmd', 'com', 'ps1', 'sh', 'run', 'bin',
    'url', 'webloc', 'desktop',
  ],
  quotaGraceHours: 24,
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
  /** "Trusted student" power: create/rename parts, assemblies, and subsystem
   *  folders (manage the CAD file structure). Additive — mentors/admins always
   *  have it via role; this grants it to a student without promoting them. */
  manageCadStructure: boolean
  /** Break (force-release) another member's check-out. Additive on top of the
   *  mentor/admin role grant. */
  forceCheckIn: boolean
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
  /** Read-only archive device. When true, the desktop becomes a local
   *  mirror: it auto-downloads every project on `allowedProjectIds`
   *  (whatever the server hands back in the snapshot) and can never
   *  upload — publish + check-out are blocked client- and server-side.
   *  Independent of kiosk; needs no auto-open project. Defaults to
   *  false on a legacy server that doesn't send the field. */
  archiveMode?: boolean
}

export interface ProjectEntry {
  id: number
  name: string
  repoUrl: string
  description?: string
  createdAt: number
  /** Google Drive folder id for a Drive-backed project, when the server
   *  records one. Lets the desktop match an auto-open/kiosk target to a
   *  downloaded Drive project by folder id (Drive recents have no GitHub
   *  remote). Optional — empty on GitHub-only/legacy project rows. */
  driveFolderId?: string
  /** Which Shared Drive the Drive folder lives in. Lets a client
   *  auto-join a Drive project without a Shared-Drive picker (used by
   *  archive mode). Optional — empty on GitHub-only/legacy rows or a
   *  server that doesn't record it. */
  sharedDriveId?: string
  /** Lore-backed project: the remote `lore://host:port/repo` URL clients
   *  clone from. When set, the welcome list routes this project to the
   *  Lore join flow instead of the Drive picker. Optional. */
  loreUrl?: string
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
  /** True after the server revoked this device (a 401 on refresh) —
   *  distinct from "never enrolled". The UI must not grant standalone-admin
   *  to a revoked device. Optional so a legacy snapshot still parses. */
  revoked?: boolean
}

export interface EnrollResult {
  success: boolean
  /** Populated only when success === true. */
  snapshot?: TeamSnapshot
  /** Populated only when success === false. */
  error?: string
}

/** Per-project state of the read-only archive mirror (archive mode). */
export interface ArchiveProjectStatus {
  /** Drive folder id — the canonical per-project key. */
  projectKey: string
  name: string
  /** Local directory this project is mirrored into. */
  localPath: string
  /** 'pending' = known but not yet synced this session; 'syncing' =
   *  download/sync in flight; 'idle' = up to date; 'error' = last
   *  attempt failed (see lastError). */
  state: 'pending' | 'syncing' | 'idle' | 'error'
  /** Last successful sync, or null if never synced this session. */
  lastSyncAt: number | null
  /** Files in the local mirror (from the manifest). */
  fileCount: number
  /** Download/sync progress 0–100 while state === 'syncing'. */
  percent: number
  /** Error from the last failed attempt, or null. */
  lastError: string | null
}

/** Whole-machine archive-mode status, pushed to the Archive Dashboard. */
export interface ArchiveStatus {
  /** True while the archive loop is running (device is in archive mode). */
  active: boolean
  /** Root directory all project mirrors live under. */
  archiveRoot: string
  /** When the loop last polled the server, or null. */
  lastTickAt: number | null
  projects: ArchiveProjectStatus[]
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
  restartToUpdate(): Promise<void>
  checkForUpdate(): Promise<{
    success: boolean
    currentVersion?: string
    latestVersion?: string
    updateAvailable?: boolean
    noReleasesYet?: boolean
    artifactPending?: boolean
    error?: string
  }>
  cancelUpdateRetry(): Promise<void>
  getAppVersion(): Promise<string>
  /** Best-effort OS hostname for pre-filling the enrollment wizard's
   *  Device Label field. Returns '' on any failure. */
  getOsHostname(): Promise<string>
  /** Best-effort OS username for pre-filling the wizard's display-
   *  name field. Returns '' on any failure. */
  getOsUsername(): Promise<string>
  openExternal(url: string): Promise<void>
  reportIssue(errorMessage: string): Promise<{ success: boolean; id?: number; error?: string }>
  /** Snapshot the open project to a timestamped sibling folder, detached
   *  from Drive (can't sync/publish). A local rollback point. `skipped` lists
   *  files that couldn't be copied (e.g. open/locked in SolidWorks). */
  backupProject(): Promise<{ success: boolean; path?: string; error?: string; skipped?: string[] }>
  generateDocument(type: 'bom' | 'manufacturing' | 'summary' | 'bom-by-subsystem'): Promise<{ success: boolean; filePath?: string; relPath?: string; pdfFilePath?: string; pdfRelPath?: string; pdfError?: string; error?: string }>
  openPath(absPath: string): Promise<{ success: boolean; error?: string }>
  revealInFolder(absPath: string): Promise<{ success: boolean; error?: string }>
  getAdminConfig(): Promise<AdminConfig>
  getGlobalAdmin(): Promise<GlobalAdminState>
  saveGlobalAdmin(config: GlobalAdminConfig): Promise<void>
  resetGlobalAdmin(): Promise<void>
  resetAllAppState(): Promise<void>
  saveAdminConfig(config: AdminConfig): Promise<void>
  syncCots(): Promise<{ success: boolean; cloned?: boolean; error?: string }>
  getPartMeta(filePath: string): Promise<PartMeta>
  getWhereUsed(filePath: string): Promise<string[]>
  getThumbnail(filePath: string, size: number): Promise<string | null>
  setReleaseState(filePath: string, state: ReleaseState, note?: string, location?: string): Promise<void>
  addComment(filePath: string, text: string): Promise<void>
  setManufacturingNotes(filePath: string, notes: string): Promise<void>
  setPartMass(filePath: string, mass: number | null): Promise<void>
  setPartCost(filePath: string, cost: number | null): Promise<void>
  getProjectTotals(): Promise<ProjectTotals>
  setManufacturingMethod(filePath: string, method: ManufacturingMethod | null): Promise<void>
  setManufacturingMaterial(filePath: string, material: string): Promise<void>
  setPurchaseInfo(filePath: string, patch: PartPurchaseInfo | null): Promise<void>
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
  onFileChange(callback: (files: FileEntry[]) => void): () => void
  consumePendingDeepLink(): Promise<DeepLinkPayload | null>
  onDeepLink(callback: (payload: DeepLinkPayload) => void): () => void
  onError(callback: (error: string) => void): () => void
  onUpdateAvailable(callback: (info: UpdateInfo) => void): () => void
  onUpdateDownloadProgress(callback: (progress: { percent: number }) => void): () => void
  onUpdateDownloaded(callback: () => void): () => void
  onUpdateRetryStatus(callback: (data: UpdateRetryStatus) => void): () => void
  onUpdateError(callback: (data: { message: string }) => void): () => void
  onPublishProgress(callback: (progress: PublishProgress) => void): () => void
  onJoinProgress(callback: (progress: PublishProgress) => void): () => void

  // Team server.
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
  /** Sign in with username + password to add this device to an existing account. */
  teamLoginDevice(args: {
    serverUrl: string
    username: string
    password: string
    deviceLabel?: string
  }): Promise<EnrollResult>
  /** Drop the local token + cache. Server-side audit row still records the device. */
  teamSignOut(): Promise<void>
  /** Returns the URL to open the admin web UI in a browser (or null when not enrolled). */
  teamAdminUiUrl(): Promise<string | null>
  /** Cheap health probe of the team server (`GET /api/health`).
   *  Used by the desktop UI to render a connectivity status dot.
   *  Returns 'not-enrolled' when no server URL is stored. */
  teamPingServer(): Promise<'reachable' | 'unreachable' | 'not-enrolled'>
  /** Subscribe to push notifications when the cached snapshot changes. */
  onTeamSnapshot(callback: (snapshot: TeamSnapshot) => void): () => void

  // ── Archive mode (read-only local mirror) ──
  /** Current archive-mirror status (cached; no network). */
  archiveGetStatus(): Promise<ArchiveStatus>
  /** Kick an immediate poll + sync pass instead of waiting for the timer. */
  archiveSyncNow(): Promise<ArchiveStatus>
  /** Open a folder picker to relocate the archive root, then restart the
   *  mirror against the new location. Returns the fresh status (unchanged
   *  if the user cancels). */
  archiveChooseRoot(): Promise<ArchiveStatus>
  /** Subscribe to push updates as projects download / sync. */
  onArchiveStatus(callback: (status: ArchiveStatus) => void): () => void

  // ── Google Drive storage backend ──
  /** Current Google sign-in state (cached; no network). */
  googleAuthStatus(): Promise<GoogleAuthStatus>
  /** Launch the OAuth loopback flow in the system browser; resolves
   *  once the user grants access. */
  googleSignIn(): Promise<GoogleAuthStatus>
  /** Revoke + forget the Google refresh token. */
  googleSignOut(): Promise<void>
  /** Shared Drives the signed-in user can see. */
  driveListSharedDrives(): Promise<DriveSharedDrive[]>
  /** Which Shared Drive contains this folder — lets the welcome list join an
   *  assigned project whose registry row never recorded a sharedDriveId.
   *  Null when the folder isn't visible to the signed-in account. */
  driveResolveSharedDrive(folderId: string): Promise<string | null>
  /** Top-level folders inside a Shared Drive (the project picker). */
  driveListFolders(sharedDriveId: string): Promise<DriveFolder[]>
  /** Download a Drive folder into a local dir and open it as the active
   *  project. Emits join-progress events while downloading. */
  driveJoinProject(args: {
    folderId: string
    sharedDriveId: string
    localPath: string
    name: string
  }): Promise<ProjectConfig>

  // ── Lore VCS storage backend ──
  /** Clone a `lore://` repository into a local dir and open it as the active
   *  project. Emits join-progress events while cloning (same channel as Drive). */
  loreJoinProject(args: {
    url: string
    localPath: string
    name: string
  }): Promise<ProjectConfig>
}

declare global {
  interface Window {
    api: IpcApi
  }
}

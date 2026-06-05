import { google, type drive_v3 } from 'googleapis'
import fs from 'fs/promises'
import { createWriteStream, createReadStream } from 'fs'
import { randomBytes } from 'crypto'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { getAuthClient, markAuthInvalid } from './google-auth'
import { currentSnapshot } from './teamServer'
import {
  loadManifest,
  saveManifest,
  createEmptyManifest,
  computeFileHash,
  getLocalChanges,
  loadStagingState,
  saveStagingState,
  createEmptyStagingState,
  type DriveManifest,
  type DriveFileEntry,
  type DriveStagingState
} from './drive-manifest'

// Hidden per-project folder that holds background-uploaded ("staged") files
// before they are published. `listAllFiles` skips it, so other clients never
// see or download staged work until the owner promotes it on publish.
const STAGING_FOLDER_NAME = '.framecad-staging'
import type { FileEntry, FileState } from '@shared/types'

declare const __FRAMECAD_GOOGLE_SHARED_DRIVE_IDS__: string

const BUILD_SHARED_DRIVE_ALLOWLIST = parseSharedDriveIds(
  (typeof __FRAMECAD_GOOGLE_SHARED_DRIVE_IDS__ !== 'undefined'
    ? __FRAMECAD_GOOGLE_SHARED_DRIVE_IDS__
    : '') ||
  process.env.FRAMECAD_GOOGLE_SHARED_DRIVE_IDS ||
  ''
)

function parseSharedDriveIds(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )
}

function effectiveSharedDriveAllowlist(): Set<string> {
  const serverIds = parseSharedDriveIds(currentSnapshot().team?.googleSharedDriveIds ?? '')
  return serverIds.size > 0 ? serverIds : BUILD_SHARED_DRIVE_ALLOWLIST
}

function sharedDriveAllowed(sharedDriveId: string): boolean {
  const allowlist = effectiveSharedDriveAllowlist()
  return allowlist.size === 0 || allowlist.has(sharedDriveId)
}

function assertSharedDriveAllowed(sharedDriveId: string): void {
  if (sharedDriveAllowed(sharedDriveId)) return
  throw new Error(
    'This Google Shared Drive is not approved for FrameCAD. Ask your admin to update FRAMECAD_GOOGLE_SHARED_DRIVE_IDS.'
  )
}

// Default per-request timeout for Drive metadata calls (list / folder create /
// trash / metadata update). Without it, googleapis waits forever on a hung /
// half-open socket (flaky venue WiFi, captive portals), so any IPC handler
// awaiting the call never returns and the app appears frozen. 30s converts an
// infinite hang into a recoverable error that withRetry can retry.
const DRIVE_META_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.FRAMECAD_DRIVE_TIMEOUT_MS ?? '', 10) || 30000
)
// Streaming transfers (file download / upload) legitimately take longer, so
// they override the default with a generous cap that still bounds a dead
// socket instead of hanging forever.
const DRIVE_TRANSFER_TIMEOUT_MS = Math.max(
  60000,
  parseInt(process.env.FRAMECAD_DRIVE_TRANSFER_TIMEOUT_MS ?? '', 10) || 600000
)

async function getDrive(): Promise<drive_v3.Drive> {
  const auth = await getAuthClient()
  if (!auth) throw new Error('Not signed in to Google. Please sign in first.')
  // `timeout` here is the gaxios default applied to every request on this
  // client; streaming calls below pass their own larger timeout.
  return google.drive({ version: 'v3', auth, timeout: DRIVE_META_TIMEOUT_MS })
}

// How many file transfers run at once. Drive throughput is dominated by
// per-request round-trip latency, not bandwidth, so transferring many files
// concurrently is ~10-20x faster than the old one-file-at-a-time loops.
// Overridable via env for tuning or rate-limit headroom.
const DRIVE_TRANSFER_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.FRAMECAD_DRIVE_CONCURRENCY ?? '', 10) || 16
)

// Run `fn` over every item with a bounded worker pool. Each worker pulls the
// next index until the list is drained, so at most `concurrency` transfers are
// in flight at any moment. Completion order is not guaranteed.
async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0
  const workerCount = Math.min(concurrency, items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

// Retry a transfer with exponential backoff. Running many requests in parallel
// makes transient 403 (rate limit) / 5xx responses more likely; one retry pass
// keeps a single blip from failing the whole sync/publish. `fn` must be
// self-contained (create fresh streams inside) since a stream can't be reused.
// True when a Drive API error means the target file no longer exists (404).
// Used to distinguish "already gone, stop tracking" from transient failures.
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: number; status?: number; response?: { status?: number } })
  return code?.code === 404 || code?.status === 404 || code?.response?.status === 404
}

// True when a Drive API error means our auth is dead (401 / invalid_grant /
// invalid_token). Retrying these is pointless (every attempt fails the same
// way, ~3.5s wasted) and they need a re-sign-in, not a backoff.
function isAuthError(err: unknown): boolean {
  const e = err as { code?: number; status?: number; response?: { status?: number }; message?: string }
  const status = e?.code ?? e?.status ?? e?.response?.status
  return status === 401 || /invalid_grant|invalid_token|unauthorized/i.test(e?.message ?? '')
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // A dead token won't recover on retry — drop the cached sign-in so the
      // UI prompts re-authentication, and fail fast instead of backing off.
      if (isAuthError(err)) {
        await markAuthInvalid().catch(() => {})
        break
      }
      if (attempt === attempts - 1) break
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
    }
  }
  throw lastErr
}

// Per-project serial queue for manifest read-modify-write operations. Every
// mutator (publish, sync, metadata push/pull) does loadManifest → mutate →
// saveManifest against the SAME drive-manifest.json. Without serialization two
// of them (e.g. a part-number reservation's pushMetadataFile racing a publish)
// each load an independent copy and the last save clobbers the other's
// manifest.files entries — a lost entry makes that file look `added` next sync,
// causing duplicate uploads / orphaned Drive bytes. This chains operations per
// project dir so each one only loads the manifest after the previous one saved.
const manifestLocks = new Map<string, Promise<unknown>>()
function withManifestLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  // Run after the prior op settles (success OR failure) — a failed mutator must
  // not wedge the queue for everyone behind it.
  const prev = manifestLocks.get(projectDir) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  // Store a non-rejecting tail so the chain never stays in a rejected state.
  manifestLocks.set(projectDir, run.then(() => {}, () => {}))
  return run
}

// Upload a local file as Drive media with retry. Each attempt uses a FRESH
// read stream (a consumed/aborted stream can't be replayed) and destroys it in
// a finally so a failed or mid-flight request never leaks an open file handle.
async function uploadMedia(
  localPath: string,
  call: (media: { body: Readable }) => Promise<{ data: drive_v3.Schema$File }>
): Promise<{ data: drive_v3.Schema$File }> {
  return withRetry(async () => {
    const stream = createReadStream(localPath)
    try {
      return await call({ body: stream })
    } finally {
      stream.destroy() // no-op once fully consumed; closes the fd on failure
    }
  })
}

// Download one Drive file to disk (with retry) and return the local file's
// hash/mtime/size for the manifest. Shared by the join + sync paths. Bytes
// land in a hidden sibling temp file and are renamed into place only on full
// success, so a failed download never leaves a truncated file at the real path
// (which would otherwise look like a local edit and get re-published).
async function downloadOne(
  drive: drive_v3.Drive,
  driveFileId: string,
  destPath: string
): Promise<{ hash: string; mtimeMs: number; size: number }> {
  const dir = path.dirname(destPath)
  await fs.mkdir(dir, { recursive: true })
  // Leading-dot name → ignored by both the chokidar watcher and getLocalChanges.
  const tmpPath = path.join(dir, `.${path.basename(destPath)}.framecad-dl`)
  try {
    await withRetry(async () => {
      const res = await drive.files.get(
        { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream', timeout: DRIVE_TRANSFER_TIMEOUT_MS }
      )
      await pipeline(res.data as Readable, createWriteStream(tmpPath))
    })
    try {
      await fs.rename(tmpPath, destPath)
    } catch (err) {
      // tmp is a sibling of dest so they're normally the same filesystem, but
      // bind/overlay mounts (WSL, Docker, mapped drives) can make rename fail
      // with EXDEV — fall back to copy + remove, which works across devices.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      try {
        await fs.copyFile(tmpPath, destPath)
      } catch (copyErr) {
        // A partial copyFile can leave a truncated file at destPath that would
        // look like a local edit and get re-published. Remove it so the path
        // stays "not downloaded" and the next sync retries cleanly.
        await fs.rm(destPath, { force: true }).catch(() => { /* may not exist */ })
        throw copyErr
      }
      // copy (unlike rename) leaves the source behind — remove it explicitly.
      await fs.rm(tmpPath, { force: true }).catch(() => { /* best effort */ })
    }
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => { /* nothing to clean up */ })
    throw err
  }
  const [hash, stat] = await Promise.all([computeFileHash(destPath), fs.stat(destPath)])
  return { hash, mtimeMs: stat.mtimeMs, size: stat.size }
}

export async function listSharedDrives(): Promise<{ id: string; name: string }[]> {
  const drive = await getDrive()
  const results: { id: string; name: string }[] = []
  let pageToken: string | undefined

  do {
    const res = await drive.drives.list({
      pageSize: 100,
      pageToken,
      fields: 'nextPageToken, drives(id, name)'
    })
    for (const d of res.data.drives ?? []) {
      if (d.id && d.name) results.push({ id: d.id, name: d.name })
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)

  return results.filter(d => sharedDriveAllowed(d.id))
}

export async function listDriveFolders(
  sharedDriveId: string
): Promise<{ id: string; name: string }[]> {
  assertSharedDriveAllowed(sharedDriveId)
  const drive = await getDrive()
  const results: { id: string; name: string }[] = []
  let pageToken: string | undefined

  do {
    const res = await drive.files.list({
      q: `'${sharedDriveId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      driveId: sharedDriveId,
      corpora: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 200,
      pageToken,
      fields: 'nextPageToken, files(id, name)'
    })
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) results.push({ id: f.id, name: f.name })
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

interface DownloadProgress {
  phase: string
  percent: number
  detail?: string
}

/**
 * Recursively list all files (not folders) under a Drive folder.
 */
async function listAllFiles(
  drive: drive_v3.Drive,
  folderId: string,
  basePath: string,
  driveId: string
): Promise<{ driveFileId: string; name: string; relativePath: string; modifiedTime: string; size: number }[]> {
  const results: { driveFileId: string; name: string; relativePath: string; modifiedTime: string; size: number }[] = []
  let pageToken: string | undefined

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      driveId,
      corpora: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 1000,
      pageToken,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)'
    })

    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name) continue
      // Never descend into the staging folder — its contents are unpublished
      // work-in-progress that must stay invisible to other clients' sync.
      if (f.mimeType === 'application/vnd.google-apps.folder' && f.name === STAGING_FOLDER_NAME) continue
      const relPath = basePath ? `${basePath}/${f.name}` : f.name

      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const children = await listAllFiles(drive, f.id, relPath, driveId)
        results.push(...children)
      } else {
        results.push({
          driveFileId: f.id,
          name: f.name,
          relativePath: relPath,
          modifiedTime: f.modifiedTime ?? new Date().toISOString(),
          size: parseInt(f.size ?? '0', 10)
        })
      }
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)

  return results
}

export async function downloadProject(
  folderId: string,
  sharedDriveId: string,
  localPath: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<DriveManifest> {
  assertSharedDriveAllowed(sharedDriveId)
  const drive = await getDrive()

  onProgress?.({ phase: 'Listing files', percent: 0 })
  const files = await listAllFiles(drive, folderId, '', sharedDriveId)

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  let downloadedBytes = 0

  const manifest = createEmptyManifest(folderId, sharedDriveId)

  // As in syncRemote/publishChanges: if a download worker throws, persist the
  // manifest entries for files that DID download before re-throwing. Without
  // this, a join interrupted partway (network drop, etc.) left a folder full
  // of real CAD files but NO manifest — "Open Project" then rejected it as
  // "not a FrameCAD project" and the only recovery was a full re-download.
  // With a partial manifest written, the folder opens and a normal Sync pulls
  // the remaining files (absent from the manifest → treated as new-remote).
  let transferErr: unknown
  try {
    await mapPool(files, DRIVE_TRANSFER_CONCURRENCY, async file => {
      const destPath = path.join(localPath, ...file.relativePath.split('/'))
      const { hash, mtimeMs, size } = await downloadOne(drive, file.driveFileId, destPath)

      manifest.files[file.relativePath] = {
        driveFileId: file.driveFileId,
        driveRevisionId: '',
        driveModifiedTime: file.modifiedTime,
        localContentHash: hash,
        localModifiedTime: mtimeMs,
        localSize: size
      }

      downloadedBytes += file.size
      onProgress?.({
        phase: 'Downloading',
        percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
        detail: file.relativePath
      })
    })
  } catch (err) {
    transferErr = err
  }

  if (transferErr) {
    await saveManifest(localPath, manifest)
    throw transferErr
  }

  onProgress?.({ phase: 'Done', percent: 100 })
  await saveManifest(localPath, manifest)
  return manifest
}

export async function downloadFile(
  driveFileId: string,
  localPath: string
): Promise<void> {
  const drive = await getDrive()
  await downloadOne(drive, driveFileId, localPath)
}

/**
 * Build a FileEntry[] tree from the local project directory, using the
 * drive manifest to determine file states. Matches the shape returned
 * by the existing git-based getStatus().
 */
export async function getLocalStatus(projectDir: string): Promise<FileEntry[]> {
  const manifest = await loadManifest(projectDir)
  if (!manifest) return []

  const changes = await getLocalChanges(projectDir, manifest)
  const changeMap = new Map(changes.map(c => [c.relativePath, c.type]))

  function stateFor(relativePath: string): FileState {
    const change = changeMap.get(relativePath)
    if (change === 'added') return 'untracked'
    if (change === 'modified') return 'modified'
    return 'synced'
  }

  return buildTree(projectDir, projectDir, stateFor)
}

async function buildTree(
  dir: string,
  rootDir: string,
  stateFor: (relativePath: string) => FileState
): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  let dirEntries
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return entries
  }

  // COTS/ is a separate read-only library mirrored in by syncCotsDrive;
  // keep it out of the project file tree (the git backend hides it the
  // same way via the COTS subpath) so it isn't treated as project parts.
  const IGNORED = ['.framecad', '.git', 'node_modules', 'COTS']

  for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || IGNORED.includes(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      const children = await buildTree(fullPath, rootDir, stateFor)
      entries.push({
        path: relativePath,
        name: entry.name,
        isDirectory: true,
        state: 'synced',
        children
      })
    } else if (entry.isFile()) {
      entries.push({
        path: relativePath,
        name: entry.name,
        isDirectory: false,
        state: stateFor(relativePath)
      })
    }
  }

  return entries
}

// Escape a value for use inside a Drive query string literal (the
// `name = '...'` clause). Single quotes and backslashes are the only
// metacharacters Drive's query grammar recognises inside a string.
function escapeQueryValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// Find the child folder named `name` under `parentId`, creating it if absent.
async function findOrCreateFolder(
  drive: drive_v3.Drive,
  sharedDriveId: string,
  parentId: string,
  name: string
): Promise<string> {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapeQueryValue(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    driveId: sharedDriveId,
    corpora: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: 'files(id, name)',
    pageSize: 1
  })
  const found = res.data.files?.[0]?.id
  if (found) return found
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true,
    fields: 'id'
  })
  return created.data.id!
}

/**
 * Resolve the Drive folder id for a project-relative directory path
 * (POSIX-separated; '' = project root), creating any missing folders
 * along the way. `cache` memoises resolved directories so a publish
 * touching many files in the same subtree resolves each folder once.
 * Seed it with `['', projectFolderId]` before the first call.
 */
async function ensureFolderPath(
  drive: drive_v3.Drive,
  sharedDriveId: string,
  rootFolderId: string,
  relDir: string,
  cache: Map<string, string>
): Promise<string> {
  const hit = cache.get(relDir)
  if (hit) return hit
  if (!relDir) {
    cache.set('', rootFolderId)
    return rootFolderId
  }
  const slash = relDir.lastIndexOf('/')
  const parentRel = slash >= 0 ? relDir.slice(0, slash) : ''
  const name = slash >= 0 ? relDir.slice(slash + 1) : relDir
  const parentId = await ensureFolderPath(drive, sharedDriveId, rootFolderId, parentRel, cache)

  const id = await findOrCreateFolder(drive, sharedDriveId, parentId, name)
  cache.set(relDir, id)
  return id
}

// ---------------------------------------------------------------------------
// Background staging
//
// While the user edits a checked-out file, we upload its bytes to a hidden
// Drive folder ahead of time so that "publish" only has to do a fast
// metadata move instead of a full upload. All staging state-file writes are
// serialised through `stageChain` (read-modify-write of one JSON file), and
// `stagingPaused` lets publish take exclusive control while it promotes.
// ---------------------------------------------------------------------------

let stageChain: Promise<unknown> = Promise.resolve()
let stagingPaused = false

// Don't background-stage files larger than this (default 50 MB, env-tunable).
const STAGE_MAX_BYTES = Math.max(
  1_000_000,
  parseInt(process.env.FRAMECAD_STAGE_MAX_BYTES ?? '', 10) || 50_000_000
)

function enqueueStage(fn: () => Promise<void>): Promise<void> {
  const run = stageChain.then(fn)
  stageChain = run.catch(() => { /* keep the chain alive after a failure */ })
  return run
}

async function getOrInitStagingState(projectDir: string): Promise<DriveStagingState> {
  const existing = await loadStagingState(projectDir)
  if (existing) return existing
  const fresh = createEmptyStagingState(randomBytes(6).toString('hex'))
  await saveStagingState(projectDir, fresh)
  return fresh
}

async function ensureStagingFolder(
  drive: drive_v3.Drive,
  projectDir: string,
  manifest: DriveManifest,
  state: DriveStagingState
): Promise<string> {
  if (state.stagingFolderId) return state.stagingFolderId
  const root = await findOrCreateFolder(drive, manifest.sharedDriveId, manifest.projectFolderId, STAGING_FOLDER_NAME)
  const deviceFolder = await findOrCreateFolder(drive, manifest.sharedDriveId, root, state.deviceTag)
  state.stagingFolderId = deviceFolder
  await saveStagingState(projectDir, state)
  return deviceFolder
}

/**
 * Upload the current bytes of `relativePath` to the staging folder (best
 * effort). No-op if the file is unchanged since it was last staged, if the
 * Shared Drive isn't approved, or if a publish is in progress. Safe to call
 * often — it self-debounces against the recorded staged hash.
 *
 * PRECONDITION (caller's responsibility): only stage a file the current user
 * holds the check-out lock on. The lock is what guarantees nobody else is
 * mutating/publishing that path concurrently. The sole caller — `tryStage` in
 * ipc.ts — enforces this; any new caller must do the same.
 */
export function stageFile(projectDir: string, relativePath: string): Promise<void> {
  return enqueueStage(async () => {
    if (stagingPaused) return
    const manifest = await loadManifest(projectDir)
    if (!manifest || !sharedDriveAllowed(manifest.sharedDriveId)) return

    const localPath = path.join(projectDir, ...relativePath.split('/'))
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(localPath)
    } catch {
      return // file vanished between watcher event and stage
    }
    // Skip pre-staging very large files: hashing + uploading them in the
    // background would tie up CPU/bandwidth for a long time, and publish's
    // upload path handles them anyway. The speed win of staging is for the
    // many small/medium parts.
    if (stat.size > STAGE_MAX_BYTES) return
    let hash: string
    try {
      hash = await computeFileHash(localPath)
    } catch {
      return // unreadable / vanished
    }

    const state = await getOrInitStagingState(projectDir)
    const existing = state.files[relativePath]
    if (existing && existing.stagedHash === hash) return // already staged latest bytes

    const drive = await getDrive()
    const stagingFolderId = await ensureStagingFolder(drive, projectDir, manifest, state)
    const resp = await uploadMedia(localPath, media =>
      existing?.stagedFileId
        ? drive.files.update({
            fileId: existing.stagedFileId,
            media,
            supportsAllDrives: true,
            fields: 'id'
          }, { timeout: DRIVE_TRANSFER_TIMEOUT_MS })
        : drive.files.create({
            requestBody: { name: relativePath.split('/').pop()!, parents: [stagingFolderId] },
            media,
            supportsAllDrives: true,
            fields: 'id'
          }, { timeout: DRIVE_TRANSFER_TIMEOUT_MS })
    )

    state.files[relativePath] = {
      stagedFileId: resp.data.id!,
      stagedHash: hash,
      stagedSize: stat.size,
      stagedAt: Date.now()
    }
    await saveStagingState(projectDir, state)
  })
}

/**
 * Reconcile staging state: trash every staged copy that is no longer needed
 * (file now synced, reverted, or deleted) plus any orphaned files left in
 * this device's staging folder by a crash. `keepRelPaths` is the set of
 * paths whose staged copy is still wanted (currently-changed files).
 * Promoted entries must already be removed by the caller — their fileId now
 * points at the live published file, not a staged copy.
 */
async function reconcileStaging(
  drive: drive_v3.Drive,
  projectDir: string,
  sharedDriveId: string,
  state: DriveStagingState,
  keepRelPaths: Set<string>
): Promise<void> {
  // Trash staged copies we no longer need. Only stop tracking an entry once
  // its file is confirmed gone (trash succeeded, or it was already absent) —
  // dropping it after a transient failure would orphan a live staged file.
  // State is saved at the end regardless of which trashes succeeded, so a
  // partial failure persists the progress that did happen and the rest is
  // retried next round (plus caught by the orphan sweep below).
  for (const [relPath, entry] of Object.entries(state.files)) {
    if (keepRelPaths.has(relPath)) continue
    try {
      await drive.files.update({ fileId: entry.stagedFileId, requestBody: { trashed: true }, supportsAllDrives: true, fields: 'id' })
      delete state.files[relPath]
    } catch (err) {
      // 404 → already gone; safe to forget. Anything else is transient: keep
      // the entry so a later reconcile retries the trash.
      if (isNotFound(err)) delete state.files[relPath]
    }
  }

  // Listing sweep: trash anything in the staging folder with NO state entry —
  // i.e. crash orphans whose staging.json record was lost. (Entries whose
  // trash failed transiently above are still tracked and so are intentionally
  // left for the primary trash loop to retry next round, not handled here.)
  // Scoped to this device's subfolder, so it never touches a teammate's work.
  if (state.stagingFolderId) {
    const tracked = new Set(Object.values(state.files).map(e => e.stagedFileId))
    try {
      const res = await drive.files.list({
        q: `'${state.stagingFolderId}' in parents and trashed = false`,
        driveId: sharedDriveId,
        corpora: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageSize: 1000,
        fields: 'files(id)'
      })
      for (const f of res.data.files ?? []) {
        if (f.id && !tracked.has(f.id)) {
          try { await drive.files.update({ fileId: f.id, requestBody: { trashed: true }, supportsAllDrives: true, fields: 'id' }) } catch { /* ignore */ }
        }
      }
    } catch { /* listing failed — skip the orphan sweep this round */ }
  }

  await saveStagingState(projectDir, state)
}

/**
 * Garbage-collect this project's staging area against the current working
 * tree. Best effort: silently does nothing if not signed in / no manifest.
 */
export async function gcStaging(projectDir: string): Promise<void> {
  return enqueueStage(async () => {
    if (stagingPaused) return // a publish owns staging right now; it reconciles itself
    const manifest = await loadManifest(projectDir)
    const state = await loadStagingState(projectDir)
    if (!manifest || !state) return
    if (!sharedDriveAllowed(manifest.sharedDriveId)) return
    let drive: drive_v3.Drive
    try {
      drive = await getDrive()
    } catch {
      return // not signed in
    }
    const changes = await getLocalChanges(projectDir, manifest)
    const keep = new Set(changes.filter(c => c.type === 'added' || c.type === 'modified').map(c => c.relativePath))
    await reconcileStaging(drive, projectDir, manifest.sharedDriveId, state, keep)
  })
}

// ---------------------------------------------------------------------------
// Shared metadata files (parts.json, .framecad/parts-meta.json, admin.json)
//
// These carry team-shared state that the git backend propagated via commit +
// push. On Drive they are synced explicitly, immediately (not via the
// debounced publish flow), because part-number reservation must be visible to
// teammates the instant it happens. Files under .framecad/ are normally
// excluded from the publish/sync walk, so managing them here by exact relPath
// is what gives them a sync path at all. Each write is download-latest →
// mutate (by the caller) → upload-now, recorded in the same manifest the
// publish flow uses so it never double-handles them.
// ---------------------------------------------------------------------------

// Resolve the Drive file id for a project-relative path WITHOUT creating any
// folders (unlike ensureFolderPath). Returns null if any path segment or the
// file itself doesn't exist on Drive yet.
async function findDriveFileId(
  drive: drive_v3.Drive,
  manifest: DriveManifest,
  relPath: string
): Promise<string | null> {
  const segments = relPath.split('/')
  const name = segments.pop()!
  let parentId = manifest.projectFolderId
  for (const seg of segments) {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and name = '${escapeQueryValue(seg)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      driveId: manifest.sharedDriveId,
      corpora: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'files(id)',
      pageSize: 1
    })
    const id = res.data.files?.[0]?.id
    if (!id) return null
    parentId = id
  }
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapeQueryValue(name)}' and trashed = false`,
    driveId: manifest.sharedDriveId,
    corpora: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: 'files(id)',
    pageSize: 1
  })
  return res.data.files?.[0]?.id ?? null
}

/**
 * Pull the latest Drive copy of one tracked metadata file over the local copy
 * so a read-modify-write sees teammates' latest first. Best effort: no-op if
 * not signed in, no manifest, or the file isn't on Drive yet — the caller then
 * just mutates whatever is on disk.
 */
export function pullMetadataFile(projectDir: string, relPath: string): Promise<void> {
  return withManifestLock(projectDir, () => pullMetadataFileImpl(projectDir, relPath))
}
async function pullMetadataFileImpl(projectDir: string, relPath: string): Promise<void> {
  const manifest = await loadManifest(projectDir)
  if (!manifest || !sharedDriveAllowed(manifest.sharedDriveId)) return
  let drive: drive_v3.Drive
  try { drive = await getDrive() } catch { return }
  const fileId = manifest.files[relPath]?.driveFileId ?? await findDriveFileId(drive, manifest, relPath)
  if (!fileId) return
  try {
    const meta = await drive.files.get({ fileId, fields: 'modifiedTime', supportsAllDrives: true })
    const destPath = path.join(projectDir, ...relPath.split('/'))
    const { hash, mtimeMs, size } = await downloadOne(drive, fileId, destPath)
    manifest.files[relPath] = {
      driveFileId: fileId,
      driveRevisionId: '',
      driveModifiedTime: meta.data.modifiedTime ?? new Date(mtimeMs).toISOString(),
      localContentHash: hash,
      localModifiedTime: mtimeMs,
      localSize: size
    }
    await saveManifest(projectDir, manifest)
  } catch { /* keep local copy on any failure */ }
}

/**
 * Upload the local copy of one metadata file to Drive immediately (create or
 * update), recording it in the manifest. Throws on failure so callers that
 * reserve part numbers can roll back, mirroring the git push-or-rollback path.
 */
export function pushMetadataFile(projectDir: string, relPath: string): Promise<void> {
  return withManifestLock(projectDir, () => pushMetadataFileImpl(projectDir, relPath))
}
async function pushMetadataFileImpl(projectDir: string, relPath: string): Promise<void> {
  const manifest = await loadManifest(projectDir)
  if (!manifest) throw new Error('No Drive manifest — this project is not a Drive project.')
  assertSharedDriveAllowed(manifest.sharedDriveId)
  const drive = await getDrive()
  const localPath = path.join(projectDir, ...relPath.split('/'))

  const slash = relPath.lastIndexOf('/')
  const relDir = slash >= 0 ? relPath.slice(0, slash) : ''
  const name = slash >= 0 ? relPath.slice(slash + 1) : relPath
  const folderCache = new Map<string, string>([['', manifest.projectFolderId]])
  const parentId = await ensureFolderPath(drive, manifest.sharedDriveId, manifest.projectFolderId, relDir, folderCache)

  const existingId = manifest.files[relPath]?.driveFileId ?? await findDriveFileId(drive, manifest, relPath)
  const resp = await uploadMedia(localPath, media =>
    existingId
      ? drive.files.update({ fileId: existingId, media, supportsAllDrives: true, fields: 'id, modifiedTime' }, { timeout: DRIVE_TRANSFER_TIMEOUT_MS })
      : drive.files.create({ requestBody: { name, parents: [parentId] }, media, supportsAllDrives: true, fields: 'id, modifiedTime' }, { timeout: DRIVE_TRANSFER_TIMEOUT_MS })
  )

  const [stat, hash] = await Promise.all([fs.stat(localPath), computeFileHash(localPath)])
  manifest.files[relPath] = {
    driveFileId: resp.data.id!,
    driveRevisionId: '',
    driveModifiedTime: resp.data.modifiedTime ?? new Date().toISOString(),
    localContentHash: hash,
    localModifiedTime: stat.mtimeMs,
    localSize: stat.size
  }
  await saveManifest(projectDir, manifest)
}

/**
 * Mirror a read-only COTS library Drive folder into the project's `COTS/`
 * subfolder. Replaces the git-clone COTS flow for Drive projects: the
 * library lives in its own Drive folder (set by the admin), and every
 * client downloads it on open / sync. Files are downloaded in parallel;
 * a file already present at the same byte size is skipped (COTS parts are
 * immutable once published, so size match is a safe "already have it").
 * Best-effort per file — one failure doesn't abort the rest.
 */
export async function syncCotsDrive(
  projectDir: string,
  cotsFolderId: string,
  sharedDriveId: string
): Promise<{ success: boolean; downloaded: number; error?: string }> {
  if (!cotsFolderId || !sharedDriveId) {
    return { success: false, downloaded: 0, error: 'No COTS Drive folder configured' }
  }
  assertSharedDriveAllowed(sharedDriveId)
  let drive: drive_v3.Drive
  try { drive = await getDrive() } catch (err) {
    return { success: false, downloaded: 0, error: (err as Error).message }
  }
  try {
    const files = await listAllFiles(drive, cotsFolderId, '', sharedDriveId)
    const cotsRoot = path.join(projectDir, 'COTS')
    let downloaded = 0
    await mapPool(files, DRIVE_TRANSFER_CONCURRENCY, async file => {
      const destPath = path.join(cotsRoot, ...file.relativePath.split('/'))
      try {
        const stat = await fs.stat(destPath)
        if (stat.size === file.size) return // already have this exact file
      } catch { /* not present — download it */ }
      await downloadOne(drive, file.driveFileId, destPath)
      downloaded++
    })
    return { success: true, downloaded }
  } catch (err) {
    return { success: false, downloaded: 0, error: (err as Error).message }
  }
}

export interface PublishChangesResult {
  uploaded: number
  deleted: number
  /** Project-relative paths changed in this publish (adds + deletes),
   *  for the team-server publish-history record. */
  changedPaths: string[]
}

/**
 * Push every local add / modify / delete up to Drive and reconcile the
 * manifest. Adds and modifications upload the file bytes (creating any
 * missing parent folders); deletions move the Drive file to trash
 * (recoverable, unlike a hard delete which on a Shared Drive needs
 * Content-Manager rights). The manifest is rewritten so the next
 * status pass shows everything synced.
 */
export function publishChanges(
  projectDir: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<PublishChangesResult> {
  return withManifestLock(projectDir, () => publishChangesImpl(projectDir, onProgress))
}
async function publishChangesImpl(
  projectDir: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<PublishChangesResult> {
  const manifest = await loadManifest(projectDir)
  if (!manifest) throw new Error('No Drive manifest — this project is not a Drive project.')
  assertSharedDriveAllowed(manifest.sharedDriveId)
  const drive = await getDrive()

  // Take exclusive control of staging: stop new background uploads and wait
  // for any in-flight one to finish before we read staging state / promote.
  stagingPaused = true
  try {
    // Wait for in-flight background staging to settle before we read/promote —
    // but never block publish forever on a wedged stage op. After the cap we
    // proceed; any not-yet-staged file just takes the normal upload path.
    await Promise.race([
      stageChain.catch(() => { /* ignore a failed background stage */ }),
      new Promise(resolve => setTimeout(resolve, 5000))
    ])
    const staging = await loadStagingState(projectDir)

    const changes = await getLocalChanges(projectDir, manifest)
    const adds = changes.filter(c => c.type === 'added' || c.type === 'modified')
    const dels = changes.filter(c => c.type === 'deleted')
    const total = adds.length + dels.length
    let done = 0

    // Resolve (and create) every needed parent folder up front, sequentially, so
    // the shared cache is fully populated before the parallel uploads read it.
    // Doing this concurrently would race: two uploads needing the same new folder
    // would both query-miss and both create it, leaving a duplicate on Drive.
    const folderCache = new Map<string, string>([['', manifest.projectFolderId]])
    const relDirOf = (relPath: string): string => {
      const slash = relPath.lastIndexOf('/')
      return slash >= 0 ? relPath.slice(0, slash) : ''
    }
    for (const relDir of new Set(adds.map(c => relDirOf(c.relativePath)))) {
      await ensureFolderPath(drive, manifest.sharedDriveId, manifest.projectFolderId, relDir, folderCache)
    }

    // Paths whose live published file IS the (just-moved) staged file — their
    // staging entry must be dropped before reconcile so it isn't mistaken for
    // a stale staged copy and trashed.
    const promoted: string[] = []

    // Serialise staging-state writes for this publish (mapPool runs callbacks
    // concurrently against one JSON file). Persisting each promoted entry's
    // removal right after its Drive move shrinks the crash window in which the
    // staged file has already been moved to its live location but staging.json
    // still references it as staged.
    let stagingSave: Promise<void> = Promise.resolve()
    const dropStagedEntry = (relPath: string): Promise<void> => {
      const s = staging
      if (!s) return Promise.resolve()
      delete s.files[relPath]
      stagingSave = stagingSave.then(() => saveStagingState(projectDir, s)).catch(() => { /* flushed again at publish end */ })
      return stagingSave
    }

    // If a transfer worker throws, we still persist the manifest entries for
    // the files that DID upload (below) before re-throwing — otherwise an
    // uploaded file with no manifest entry is orphaned on Drive and re-uploaded
    // next pass. Capture the first error and surface it after the save.
    let transferErr: unknown
    try {
    await mapPool(adds, DRIVE_TRANSFER_CONCURRENCY, async c => {
      const localPath = path.join(projectDir, ...c.relativePath.split('/'))
      const relDir = relDirOf(c.relativePath)
      const name = c.relativePath.slice(relDir ? relDir.length + 1 : 0)
      const parentId = folderCache.get(relDir)!
      const existing = manifest.files[c.relativePath]
      const [stat, hash] = await Promise.all([fs.stat(localPath), computeFileHash(localPath)])
      const staged = staging?.files[c.relativePath]

      let driveFileId: string
      let driveModifiedTime: string
      if (staged && staged.stagedHash === hash && staging?.stagingFolderId) {
        // Fast path: the bytes are already on Drive. Promote by moving the
        // staged file into place (metadata only — instant, any size).
        const resp = await withRetry<{ data: drive_v3.Schema$File }>(() =>
          drive.files.update({
            fileId: staged.stagedFileId,
            addParents: parentId,
            removeParents: staging.stagingFolderId!,
            requestBody: { name },
            supportsAllDrives: true,
            fields: 'id, modifiedTime'
          })
        )
        driveFileId = resp.data.id!
        driveModifiedTime = resp.data.modifiedTime ?? new Date().toISOString()
        // Drop the now-superseded published version (a different file id).
        if (existing?.driveFileId && existing.driveFileId !== driveFileId) {
          try {
            await drive.files.update({ fileId: existing.driveFileId, requestBody: { trashed: true }, supportsAllDrives: true, fields: 'id' })
          } catch { /* already gone */ }
        }
        promoted.push(c.relativePath)
        await dropStagedEntry(c.relativePath)
      } else {
        // Slow path: no current staged copy — upload the bytes now (parallel).
        // uploadMedia destroys the read stream on each attempt so retries don't
        // leak file descriptors.
        const resp = await uploadMedia(localPath, media =>
          existing?.driveFileId
            ? drive.files.update({
                fileId: existing.driveFileId,
                media,
                supportsAllDrives: true,
                fields: 'id, modifiedTime'
              }, { timeout: DRIVE_TRANSFER_TIMEOUT_MS })
            : drive.files.create({
                requestBody: { name, parents: [parentId] },
                media,
                supportsAllDrives: true,
                fields: 'id, modifiedTime'
              }, { timeout: DRIVE_TRANSFER_TIMEOUT_MS })
        )
        driveFileId = resp.data.id!
        driveModifiedTime = resp.data.modifiedTime ?? new Date().toISOString()
      }

      manifest.files[c.relativePath] = {
        driveFileId,
        driveRevisionId: '',
        driveModifiedTime,
        localContentHash: hash,
        localModifiedTime: stat.mtimeMs,
        localSize: stat.size
      }
      done++
      onProgress?.({ phase: 'Uploading', percent: total ? Math.round((done / total) * 100) : 0, detail: c.relativePath })
    })

    await mapPool(dels, DRIVE_TRANSFER_CONCURRENCY, async c => {
      const existing = manifest.files[c.relativePath]
      if (existing?.driveFileId) {
        try {
          await drive.files.update({
            fileId: existing.driveFileId,
            requestBody: { trashed: true },
            supportsAllDrives: true,
            fields: 'id'
          })
        } catch { /* already removed on Drive — converge anyway */ }
      }
      delete manifest.files[c.relativePath]
      done++
      onProgress?.({ phase: 'Deleting', percent: total ? Math.round((done / total) * 100) : 0, detail: c.relativePath })
    })
    } catch (err) {
      transferErr = err
    }

    // Flush any queued incremental staging saves, then persist once more so the
    // promoted-entry removals are durable BEFORE the manifest is saved. A
    // promoted file's staged id IS now the live published file; if that entry
    // survived on disk while the manifest marked the file synced, a later
    // reconcile would treat it as a stale staged copy and trash the live file.
    // Dropping it first makes that impossible even if a later step throws.
    if (staging) {
      await stagingSave.catch(() => { /* superseded by the save below */ })
      for (const p of promoted) delete staging.files[p]
      await saveStagingState(projectDir, staging)
    }

    manifest.lastSyncedAt = Date.now()
    await saveManifest(projectDir, manifest)

    // A worker threw mid-transfer: the successfully-uploaded files are now
    // durably recorded above, so re-throwing here won't orphan them. Surface
    // the failure to the user instead of reporting a clean publish; skip GC
    // (the next reconcile catches any leftover staged copies).
    if (transferErr) throw transferErr

    // Trash-only cleanup of staged copies that are no longer pending changes.
    // Safe to fail: it never deletes live files (promoted entries are already
    // gone above) and any leftover staged copy is caught on the next reconcile.
    if (staging) {
      const after = await getLocalChanges(projectDir, manifest)
      const keep = new Set(after.filter(c => c.type === 'added' || c.type === 'modified').map(c => c.relativePath))
      try {
        await reconcileStaging(drive, projectDir, manifest.sharedDriveId, staging, keep)
      } catch { /* best-effort GC — publish itself already succeeded */ }
    }

    onProgress?.({ phase: 'Done', percent: 100 })
    return {
      uploaded: adds.length,
      deleted: dels.length,
      changedPaths: [...adds.map(c => c.relativePath), ...dels.map(c => c.relativePath)]
    }
  } finally {
    stagingPaused = false
  }
}

export interface SyncRemoteResult {
  filesUpdated: number
}

/**
 * Pull teammates' changes down from Drive. New and remotely-modified
 * files are downloaded; files deleted on Drive are removed locally.
 * A file the user has modified locally is never clobbered — if both
 * sides changed, the local copy wins and the user resolves it on their
 * next publish (last-write-wins, but never a silent data loss).
 */
export function syncRemote(
  projectDir: string,
  onProgress?: (progress: DownloadProgress) => void,
  /** Project-relative paths this user holds a check-out lock on. The
   *  rename-reconcile must not move these out from under the held lock. */
  lockedByMe?: Set<string>
): Promise<SyncRemoteResult> {
  return withManifestLock(projectDir, () => syncRemoteImpl(projectDir, onProgress, lockedByMe))
}
async function syncRemoteImpl(
  projectDir: string,
  onProgress?: (progress: DownloadProgress) => void,
  lockedByMe?: Set<string>
): Promise<SyncRemoteResult> {
  const manifest = await loadManifest(projectDir)
  if (!manifest) throw new Error('No Drive manifest — this project is not a Drive project.')
  assertSharedDriveAllowed(manifest.sharedDriveId)
  const drive = await getDrive()

  onProgress?.({ phase: 'Listing files', percent: 0 })
  const remote = await listAllFiles(drive, manifest.projectFolderId, '', manifest.sharedDriveId)
  const remoteByPath = new Map(remote.map(r => [r.relativePath, r]))

  // Detect local edits up front so a remote change never overwrites a
  // file the user is actively working on.
  const localChanges = await getLocalChanges(projectDir, manifest)
  const locallyDirty = new Set(
    localChanges.filter(c => c.type === 'modified' || c.type === 'added').map(c => c.relativePath)
  )

  let updated = 0

  // Rename/move handling. Conflict detection keys on path, so a teammate's
  // rename (same Drive file id, new path) would otherwise look like a brand-new
  // file to download PLUS an orphaned old entry — wasting a full re-download
  // and, if the old path is locally dirty, leaving the SAME driveFileId under
  // two manifest keys (a corruption the rest of the code doesn't expect).
  // Reconcile by id instead: a remote file whose id we already track under a
  // different path that is itself gone from Drive is a move, not a copy.
  const manifestPathById = new Map<string, string>()
  for (const [p, e] of Object.entries(manifest.files)) {
    if (e.driveFileId) manifestPathById.set(e.driveFileId, p)
  }
  // New paths to keep OUT of the download set because handling them as a
  // download would duplicate an id we're preserving under the old path.
  const skipDownloadPaths = new Set<string>()
  for (const r of remote) {
    const oldPath = manifestPathById.get(r.driveFileId)
    if (!oldPath || oldPath === r.relativePath) continue // unchanged or untracked
    if (remoteByPath.has(oldPath)) continue              // old path still exists → a copy, not a move
    if (manifest.files[r.relativePath]) continue          // new path already tracked → not a simple rename
    if (locallyDirty.has(oldPath) || lockedByMe?.has(oldPath)) {
      // The user is editing OR holds a check-out lock on the renamed file. Keep
      // their copy under the old path (their lock + edits stay valid and
      // re-publish to the same Drive file id) and do NOT create a second entry
      // for the same id at the new path — renaming it out from under a held
      // lock would strand the server-side path-keyed lock and leave one
      // driveFileId under two manifest keys.
      skipDownloadPaths.add(r.relativePath)
      continue
    }
    // Something already exists at the new path locally (an untracked file the
    // user just created there) — don't clobber it; fall back to default sync.
    if (locallyDirty.has(r.relativePath)) continue
    // Clean move: rename the local file and migrate the manifest entry so the
    // normal change check below only re-downloads if the CONTENT also changed
    // (a pure Drive rename/move does not bump modifiedTime).
    const oldAbs = path.join(projectDir, ...oldPath.split('/'))
    const newAbs = path.join(projectDir, ...r.relativePath.split('/'))
    try {
      await fs.mkdir(path.dirname(newAbs), { recursive: true })
      await fs.rename(oldAbs, newAbs)
      manifest.files[r.relativePath] = manifest.files[oldPath]
      delete manifest.files[oldPath]
      updated++
    } catch {
      // Local move failed (e.g. file open in SolidWorks). Do NOT let the new
      // path download as a fresh copy — that would leave the same driveFileId
      // under both the old (still-present) and new manifest keys (the
      // two-keys-one-id corruption). Skip it; the old entry stays and the move
      // reconciles on a later sync once the file is closed.
      skipDownloadPaths.add(r.relativePath)
    }
  }

  // Pick the files that actually need pulling: new on Drive, or remotely
  // changed and not being edited locally (conflict guard — local copy wins).
  const toDownload = remote.filter(r => {
    if (skipDownloadPaths.has(r.relativePath)) return false
    const entry = manifest.files[r.relativePath]
    const isNew = !entry
    const remoteChanged = !!entry && entry.driveModifiedTime !== r.modifiedTime
    if (!isNew && !remoteChanged) return false
    if (!isNew && locallyDirty.has(r.relativePath)) return false
    return true
  })

  let done = 0
  const total = toDownload.length
  // As in publishChanges: if a download worker throws, persist the manifest
  // entries for files that DID download before re-throwing, so a partial sync
  // doesn't re-download everything (and re-flag completed files as changed).
  let transferErr: unknown
  try {
    await mapPool(toDownload, DRIVE_TRANSFER_CONCURRENCY, async r => {
      const destPath = path.join(projectDir, ...r.relativePath.split('/'))
      const { hash, mtimeMs, size } = await downloadOne(drive, r.driveFileId, destPath)
      manifest.files[r.relativePath] = {
        driveFileId: r.driveFileId,
        driveRevisionId: '',
        driveModifiedTime: r.modifiedTime,
        localContentHash: hash,
        localModifiedTime: mtimeMs,
        localSize: size
      }
      updated++
      done++
      onProgress?.({ phase: 'Downloading', percent: total ? Math.round((done / total) * 100) : 0, detail: r.relativePath })
    })
  } catch (err) {
    transferErr = err
  }

  if (transferErr) {
    // Persist what downloaded, then surface the failure. Skip the
    // remote-deletion sweep — we can't trust a partial remote listing.
    manifest.lastSyncedAt = Date.now()
    await saveManifest(projectDir, manifest)
    throw transferErr
  }

  // Files gone from Drive → delete locally, unless the user has local
  // edits to that path (then keep their copy).
  for (const relPath of Object.keys(manifest.files)) {
    if (remoteByPath.has(relPath)) continue
    if (locallyDirty.has(relPath)) continue
    const dest = path.join(projectDir, ...relPath.split('/'))
    try { await fs.rm(dest, { force: true }) } catch { /* ignore */ }
    delete manifest.files[relPath]
    updated++
  }

  manifest.lastSyncedAt = Date.now()
  await saveManifest(projectDir, manifest)
  onProgress?.({ phase: 'Done', percent: 100 })
  return { filesUpdated: updated }
}

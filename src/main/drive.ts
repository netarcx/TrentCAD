import { google, type drive_v3 } from 'googleapis'
import fs from 'fs/promises'
import { createWriteStream, createReadStream } from 'fs'
import { randomBytes } from 'crypto'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { getAuthClient } from './google-auth'
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

async function getDrive(): Promise<drive_v3.Drive> {
  const auth = await getAuthClient()
  if (!auth) throw new Error('Not signed in to Google. Please sign in first.')
  return google.drive({ version: 'v3', auth })
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

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === attempts - 1) break
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
    }
  }
  throw lastErr
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
        { responseType: 'stream' }
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
      await fs.copyFile(tmpPath, destPath)
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

  const IGNORED = ['.framecad', '.git', 'node_modules']

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
    let hash: string
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      ;[hash, stat] = await Promise.all([computeFileHash(localPath), fs.stat(localPath)])
    } catch {
      return // file vanished between watcher event and stage
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
          })
        : drive.files.create({
            requestBody: { name: relativePath.split('/').pop()!, parents: [stagingFolderId] },
            media,
            supportsAllDrives: true,
            fields: 'id'
          })
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

  // Listing sweep: trash anything in the staging folder we no longer track
  // (crash orphans, or entries whose trash failed above). Scoped to this
  // device's subfolder, so it never touches another teammate's staged work.
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

export interface PublishChangesResult {
  uploaded: number
  deleted: number
}

/**
 * Push every local add / modify / delete up to Drive and reconcile the
 * manifest. Adds and modifications upload the file bytes (creating any
 * missing parent folders); deletions move the Drive file to trash
 * (recoverable, unlike a hard delete which on a Shared Drive needs
 * Content-Manager rights). The manifest is rewritten so the next
 * status pass shows everything synced.
 */
export async function publishChanges(
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
    await stageChain.catch(() => { /* ignore a failed background stage */ })
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
              })
            : drive.files.create({
                requestBody: { name, parents: [parentId] },
                media,
                supportsAllDrives: true,
                fields: 'id, modifiedTime'
              })
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
    return { uploaded: adds.length, deleted: dels.length }
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
export async function syncRemote(
  projectDir: string,
  onProgress?: (progress: DownloadProgress) => void
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

  // Pick the files that actually need pulling: new on Drive, or remotely
  // changed and not being edited locally (conflict guard — local copy wins).
  const toDownload = remote.filter(r => {
    const entry = manifest.files[r.relativePath]
    const isNew = !entry
    const remoteChanged = !!entry && entry.driveModifiedTime !== r.modifiedTime
    if (!isNew && !remoteChanged) return false
    if (!isNew && locallyDirty.has(r.relativePath)) return false
    return true
  })

  let updated = 0
  let done = 0
  const total = toDownload.length
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

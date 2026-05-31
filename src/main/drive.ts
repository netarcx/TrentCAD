import { google, type drive_v3 } from 'googleapis'
import fs from 'fs/promises'
import { createWriteStream, createReadStream } from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { getAuthClient } from './google-auth'
import {
  loadManifest,
  saveManifest,
  createEmptyManifest,
  computeFileHash,
  getLocalChanges,
  type DriveManifest,
  type DriveFileEntry
} from './drive-manifest'
import type { FileEntry, FileState } from '@shared/types'

declare const __FRAMECAD_GOOGLE_SHARED_DRIVE_IDS__: string

const SHARED_DRIVE_ALLOWLIST = parseSharedDriveIds(
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

function sharedDriveAllowed(sharedDriveId: string): boolean {
  return SHARED_DRIVE_ALLOWLIST.size === 0 || SHARED_DRIVE_ALLOWLIST.has(sharedDriveId)
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

  for (const file of files) {
    const destPath = path.join(localPath, ...file.relativePath.split('/'))
    await fs.mkdir(path.dirname(destPath), { recursive: true })

    onProgress?.({
      phase: 'Downloading',
      percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
      detail: file.relativePath
    })

    const res = await drive.files.get(
      { fileId: file.driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    )

    const writeStream = createWriteStream(destPath)
    await pipeline(res.data as Readable, writeStream)

    const hash = await computeFileHash(destPath)
    const stat = await fs.stat(destPath)

    manifest.files[file.relativePath] = {
      driveFileId: file.driveFileId,
      driveRevisionId: '',
      driveModifiedTime: file.modifiedTime,
      localContentHash: hash,
      localModifiedTime: stat.mtimeMs,
      localSize: stat.size
    }

    downloadedBytes += file.size
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
  await fs.mkdir(path.dirname(localPath), { recursive: true })

  const res = await drive.files.get(
    { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  )

  const writeStream = createWriteStream(localPath)
  await pipeline(res.data as Readable, writeStream)
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

  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapeQueryValue(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    driveId: sharedDriveId,
    corpora: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: 'files(id, name)',
    pageSize: 1
  })

  let id = res.data.files?.[0]?.id ?? null
  if (!id) {
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      },
      supportsAllDrives: true,
      fields: 'id'
    })
    id = created.data.id!
  }
  cache.set(relDir, id)
  return id
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

  const changes = await getLocalChanges(projectDir, manifest)
  const adds = changes.filter(c => c.type === 'added' || c.type === 'modified')
  const dels = changes.filter(c => c.type === 'deleted')
  const total = adds.length + dels.length
  let done = 0

  const folderCache = new Map<string, string>([['', manifest.projectFolderId]])

  for (const c of adds) {
    onProgress?.({ phase: 'Uploading', percent: total ? Math.round((done / total) * 100) : 0, detail: c.relativePath })
    const localPath = path.join(projectDir, ...c.relativePath.split('/'))
    const slash = c.relativePath.lastIndexOf('/')
    const relDir = slash >= 0 ? c.relativePath.slice(0, slash) : ''
    const name = slash >= 0 ? c.relativePath.slice(slash + 1) : c.relativePath
    const parentId = await ensureFolderPath(drive, manifest.sharedDriveId, manifest.projectFolderId, relDir, folderCache)

    const existing = manifest.files[c.relativePath]
    const media = { body: createReadStream(localPath) }
    let resp: { data: drive_v3.Schema$File }
    if (existing?.driveFileId) {
      resp = await drive.files.update({
        fileId: existing.driveFileId,
        media,
        supportsAllDrives: true,
        fields: 'id, modifiedTime'
      })
    } else {
      resp = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media,
        supportsAllDrives: true,
        fields: 'id, modifiedTime'
      })
    }

    const stat = await fs.stat(localPath)
    const hash = await computeFileHash(localPath)
    manifest.files[c.relativePath] = {
      driveFileId: resp.data.id!,
      driveRevisionId: '',
      driveModifiedTime: resp.data.modifiedTime ?? new Date().toISOString(),
      localContentHash: hash,
      localModifiedTime: stat.mtimeMs,
      localSize: stat.size
    }
    done++
  }

  for (const c of dels) {
    onProgress?.({ phase: 'Deleting', percent: total ? Math.round((done / total) * 100) : 0, detail: c.relativePath })
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
  }

  manifest.lastSyncedAt = Date.now()
  await saveManifest(projectDir, manifest)
  onProgress?.({ phase: 'Done', percent: 100 })
  return { uploaded: adds.length, deleted: dels.length }
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

  let updated = 0
  const total = remote.length
  let i = 0
  for (const r of remote) {
    i++
    const entry = manifest.files[r.relativePath]
    const isNew = !entry
    const remoteChanged = !!entry && entry.driveModifiedTime !== r.modifiedTime
    if (!isNew && !remoteChanged) continue
    // Conflict guard: remote changed AND we have uncommitted local edits.
    if (!isNew && locallyDirty.has(r.relativePath)) continue

    onProgress?.({ phase: 'Downloading', percent: total ? Math.round((i / total) * 100) : 0, detail: r.relativePath })
    const destPath = path.join(projectDir, ...r.relativePath.split('/'))
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    const res = await drive.files.get(
      { fileId: r.driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    )
    await pipeline(res.data as Readable, createWriteStream(destPath))

    const stat = await fs.stat(destPath)
    const hash = await computeFileHash(destPath)
    manifest.files[r.relativePath] = {
      driveFileId: r.driveFileId,
      driveRevisionId: '',
      driveModifiedTime: r.modifiedTime,
      localContentHash: hash,
      localModifiedTime: stat.mtimeMs,
      localSize: stat.size
    }
    updated++
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

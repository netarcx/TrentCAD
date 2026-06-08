import fs from 'fs/promises'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import path from 'path'

export interface DriveFileEntry {
  driveFileId: string
  driveRevisionId: string
  driveModifiedTime: string
  localContentHash: string
  localModifiedTime: number
  localSize: number
}

export interface DriveManifest {
  projectFolderId: string
  sharedDriveId: string
  /** The Drive folder's own name, captured at join and refreshed on sync.
   *  This is the AUTHORITATIVE project name the GUI shows — the local folder
   *  name (which the user controls) is never used for display. Optional only
   *  for legacy manifests written before this field existed; those are
   *  back-filled from Drive on the next open/sync. */
  projectFolderName?: string
  lastSyncedAt: number
  files: Record<string, DriveFileEntry>
}

const MANIFEST_DIR = '.framecad'
const MANIFEST_NAME = 'drive-manifest.json'
const STAGING_NAME = 'drive-staging.json'

function manifestPath(projectDir: string): string {
  return path.join(projectDir, MANIFEST_DIR, MANIFEST_NAME)
}

/**
 * One background-uploaded ("staged") copy of a local file. The bytes live
 * in the project's hidden `.framecad-staging/<deviceTag>/` folder on Drive,
 * invisible to other clients' sync, until the user publishes — at which
 * point the staged file is promoted into place by a metadata-only move.
 * `stagedHash` is the SHA-256 of the bytes that were uploaded, so publish
 * can tell whether the staged copy is still current.
 */
export interface StagedEntry {
  stagedFileId: string
  stagedHash: string
  stagedSize: number
  stagedAt: number
}

export interface DriveStagingState {
  /** Random per-install tag; names this device's staging subfolder. */
  deviceTag: string
  /** Drive folder id of `.framecad-staging/<deviceTag>` (null until created). */
  stagingFolderId: string | null
  files: Record<string, StagedEntry>
}

export async function loadManifest(projectDir: string): Promise<DriveManifest | null> {
  try {
    const data = await fs.readFile(manifestPath(projectDir), 'utf-8')
    return JSON.parse(data) as DriveManifest
  } catch {
    return null
  }
}

export async function saveManifest(projectDir: string, manifest: DriveManifest): Promise<void> {
  const dir = path.join(projectDir, MANIFEST_DIR)
  await fs.mkdir(dir, { recursive: true })
  const dest = manifestPath(projectDir)
  const tmp = dest + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2))
  await fs.rename(tmp, dest)
}

export function createEmptyManifest(
  projectFolderId: string,
  sharedDriveId: string,
  projectFolderName?: string
): DriveManifest {
  return {
    projectFolderId,
    sharedDriveId,
    projectFolderName,
    lastSyncedAt: Date.now(),
    files: {}
  }
}

function stagingPath(projectDir: string): string {
  return path.join(projectDir, MANIFEST_DIR, STAGING_NAME)
}

export async function loadStagingState(projectDir: string): Promise<DriveStagingState | null> {
  try {
    const data = await fs.readFile(stagingPath(projectDir), 'utf-8')
    return JSON.parse(data) as DriveStagingState
  } catch {
    return null
  }
}

export async function saveStagingState(projectDir: string, state: DriveStagingState): Promise<void> {
  const dir = path.join(projectDir, MANIFEST_DIR)
  await fs.mkdir(dir, { recursive: true })
  const dest = stagingPath(projectDir)
  const tmp = dest + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, dest)
}

export function createEmptyStagingState(deviceTag: string): DriveStagingState {
  return { deviceTag, stagingFolderId: null, files: {} }
}

export function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// Content-hash cache keyed by absolute path → (mtime, size, hash). A status
// pass only hashes files whose mtime/size differ from the MANIFEST, but the
// manifest isn't updated until publish/sync — so a SolidWorks save that bumps
// mtimes without changing bytes re-hashed those (often large) assemblies on
// EVERY 500ms tick for the whole editing session. Caching by the file's own
// current (mtime,size) means we hash each distinct on-disk version once; an
// unchanged file is a Map hit, not a disk read + SHA-256.
const hashCache = new Map<string, { mtime: number; size: number; hash: string }>()

async function computeFileHashCached(absPath: string, mtime: number, size: number): Promise<string> {
  const cached = hashCache.get(absPath)
  if (cached && cached.mtime === mtime && cached.size === size) return cached.hash
  const hash = await computeFileHash(absPath)
  hashCache.set(absPath, { mtime, size, hash })
  return hash
}

/** Drop the content-hash cache (e.g. on project close) to bound memory. */
export function clearHashCache(): void {
  hashCache.clear()
}

export type ChangeType = 'modified' | 'added' | 'deleted'

export interface LocalChange {
  relativePath: string
  type: ChangeType
  localSize?: number
  localModifiedTime?: number
}

const IGNORED_PATTERNS = [
  /^\.framecad[\\/]/,
  /^\.git[\\/]/,
  // COTS/ is a read-only mirror of a separate Drive library (see
  // syncCotsDrive). It must never be published back into the project's
  // own Drive folder — the git backend gitignores it for the same reason.
  /^COTS[\\/]/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\./,
  /~\$/,
  /\.swp$/,
  /\.tmp$/,
  /Thumbs\.db$/i,
  /\.DS_Store$/
]

function isIgnored(relativePath: string): boolean {
  return IGNORED_PATTERNS.some(p => p.test(relativePath))
}

async function walkDir(
  dir: string,
  rootDir: string,
  results: Map<string, { mtime: number; size: number }>
): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/')

    if (isIgnored(relativePath)) continue

    if (entry.isDirectory()) {
      await walkDir(fullPath, rootDir, results)
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath)
        results.set(relativePath, { mtime: stat.mtimeMs, size: stat.size })
      } catch { /* file may have been deleted between readdir and stat */ }
    }
  }
}

/**
 * Compare local files against the drive manifest to detect changes.
 * Uses mtime + size as a fast first-pass; only computes SHA-256 when
 * those differ (avoiding expensive hashing for unchanged files).
 */
export async function getLocalChanges(
  projectDir: string,
  manifest: DriveManifest
): Promise<LocalChange[]> {
  const localFiles = new Map<string, { mtime: number; size: number }>()
  await walkDir(projectDir, projectDir, localFiles)

  const changes: LocalChange[] = []

  // Files whose mtime/size differ from the manifest need a SHA-256 to confirm a
  // real content change. Hash them CONCURRENTLY rather than one-at-a-time — on a
  // SolidWorks save that touches several large assemblies, serial hashing took
  // tens of seconds per status refresh and made the app feel frozen.
  const maybeModified: { relPath: string; local: { mtime: number; size: number } }[] = []
  for (const [relPath, local] of localFiles) {
    const entry = manifest.files[relPath]
    if (!entry) {
      changes.push({ relativePath: relPath, type: 'added', localSize: local.size, localModifiedTime: local.mtime })
      continue
    }
    if (local.mtime !== entry.localModifiedTime || local.size !== entry.localSize) {
      maybeModified.push({ relPath, local })
    }
  }

  const hashed = await Promise.all(
    maybeModified.map(async ({ relPath, local }) => {
      try {
        const hash = await computeFileHashCached(path.join(projectDir, relPath), local.mtime, local.size)
        return { relPath, local, hash }
      } catch {
        return null // file vanished / unreadable between walk and hash
      }
    })
  )
  for (const r of hashed) {
    if (!r) continue
    const entry = manifest.files[r.relPath]
    if (entry && r.hash !== entry.localContentHash) {
      changes.push({ relativePath: r.relPath, type: 'modified', localSize: r.local.size, localModifiedTime: r.local.mtime })
    }
  }

  for (const relPath of Object.keys(manifest.files)) {
    if (!localFiles.has(relPath)) {
      changes.push({ relativePath: relPath, type: 'deleted' })
    }
  }

  return changes
}

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

export function createEmptyManifest(projectFolderId: string, sharedDriveId: string): DriveManifest {
  return {
    projectFolderId,
    sharedDriveId,
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

  for (const [relPath, local] of localFiles) {
    const entry = manifest.files[relPath]
    if (!entry) {
      changes.push({ relativePath: relPath, type: 'added', localSize: local.size, localModifiedTime: local.mtime })
      continue
    }

    if (local.mtime !== entry.localModifiedTime || local.size !== entry.localSize) {
      let hash: string
      try {
        hash = await computeFileHash(path.join(projectDir, relPath))
      } catch {
        continue
      }
      if (hash !== entry.localContentHash) {
        changes.push({ relativePath: relPath, type: 'modified', localSize: local.size, localModifiedTime: local.mtime })
      }
    }
  }

  for (const relPath of Object.keys(manifest.files)) {
    if (!localFiles.has(relPath)) {
      changes.push({ relativePath: relPath, type: 'deleted' })
    }
  }

  return changes
}

/**
 * Orchestration layer for the Google Drive storage backend.
 *
 * Holds the currently-open Drive project (its local directory + the
 * ProjectConfig the renderer sees) and exposes the same verbs the git
 * backend does — sync, publish, status — so `ipc.ts` can route a
 * handler to Drive or git based on which kind of project is open.
 *
 * A Drive project is any local folder that contains a
 * `.framecad/drive-manifest.json` (written by `downloadProject` on
 * join). `openDriveProject` is what flips this module "active"; until
 * then `isOpen()` returns false and the git handlers run as before.
 */

import path from 'node:path'
import type { FileEntry, ProjectConfig, PublishProgress } from '@shared/types'
import {
  downloadProject,
  publishChanges,
  syncRemote,
  getLocalStatus,
  stageFile as driveStageFile,
  gcStaging as driveGcStaging
} from './drive'
import { loadManifest } from './drive-manifest'
import { addRecentProject } from './config'

interface OpenDriveProject {
  dir: string
  config: ProjectConfig
}

let current: OpenDriveProject | null = null

export function isOpen(): boolean {
  return current !== null
}

export function currentDir(): string | null {
  return current?.dir ?? null
}

export function currentConfig(): ProjectConfig | null {
  return current?.config ?? null
}

export function close(): void {
  current = null
}

/**
 * Mark a local folder as the active Drive project. Returns null when
 * the folder has no Drive manifest (caller should fall through to the
 * git open flow). Also refreshes the recent-projects list so the
 * welcome screen lists it.
 */
export async function open(dir: string): Promise<ProjectConfig | null> {
  const manifest = await loadManifest(dir)
  if (!manifest) return null
  const config: ProjectConfig = {
    name: path.basename(dir),
    path: dir,
    remote: '',
    backend: 'drive',
    driveFolderId: manifest.projectFolderId,
    sharedDriveId: manifest.sharedDriveId
  }
  current = { dir, config }
  await addRecentProject(config).catch(() => { /* best effort */ })
  // Sweep any staged copies left over from a previous session (best effort).
  void driveGcStaging(dir).catch(() => { /* not signed in / offline */ })
  return config
}

/**
 * Join a Drive project: download every file under `folderId` into
 * `localPath`, write the manifest, and make it the active project.
 * `onProgress` is forwarded to the renderer as a join-progress event by
 * the IPC handler.
 */
export async function join(
  folderId: string,
  sharedDriveId: string,
  localPath: string,
  name: string,
  onProgress?: (p: PublishProgress) => void
): Promise<ProjectConfig> {
  await downloadProject(folderId, sharedDriveId, localPath, prog => {
    onProgress?.({
      phase: prog.percent >= 100 ? 'done' : 'uploading',
      percent: prog.percent,
      detail: prog.detail
    })
  })
  const config: ProjectConfig = {
    name: name || path.basename(localPath),
    path: localPath,
    remote: '',
    backend: 'drive',
    driveFolderId: folderId,
    sharedDriveId
  }
  current = { dir: localPath, config }
  await addRecentProject(config).catch(() => { /* best effort */ })
  return config
}

export async function status(): Promise<FileEntry[]> {
  if (!current) return []
  return getLocalStatus(current.dir)
}

/**
 * Background-upload one file's current bytes to the staging area so a later
 * publish can promote it without re-uploading. Best effort and a no-op when
 * no Drive project is open.
 */
export async function stageFile(relativePath: string): Promise<void> {
  if (!current) return
  await driveStageFile(current.dir, relativePath)
}

export async function sync(onProgress?: (p: PublishProgress) => void): Promise<{
  success: boolean
  filesUpdated: number
  error?: string
}> {
  if (!current) return { success: false, filesUpdated: 0, error: 'No Drive project open' }
  try {
    const res = await syncRemote(current.dir, prog => {
      onProgress?.({
        phase: prog.percent >= 100 ? 'done' : 'uploading',
        percent: prog.percent,
        detail: prog.detail
      })
    })
    return { success: true, filesUpdated: res.filesUpdated }
  } catch (err) {
    return { success: false, filesUpdated: 0, error: (err as Error).message }
  }
}

export async function publish(onProgress?: (p: PublishProgress) => void): Promise<{
  success: boolean
  error?: string
  /** Paths changed in this publish — used to record team-server history. */
  changedPaths?: string[]
}> {
  if (!current) return { success: false, error: 'No Drive project open' }
  try {
    onProgress?.({ phase: 'preparing', percent: 0 })
    const result = await publishChanges(current.dir, prog => {
      onProgress?.({
        phase: prog.percent >= 100 ? 'done' : 'uploading',
        percent: prog.percent,
        detail: prog.detail
      })
    })
    onProgress?.({ phase: 'done', percent: 100 })
    return { success: true, changedPaths: result.changedPaths }
  } catch (err) {
    onProgress?.({ phase: 'error', error: (err as Error).message })
    return { success: false, error: (err as Error).message }
  }
}

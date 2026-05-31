/**
 * Backend-agnostic persistence for the team-shared metadata files
 * (parts.json, .framecad/parts-meta.json, .framecad/admin.json).
 *
 * These files carry state every teammate must see. The git backend
 * propagated them via commit + push; the Drive backend uploads them
 * immediately to the project's Drive folder. Callers (parts.ts, meta.ts,
 * admin.ts) go through here instead of touching git directly, so the same
 * reserve/edit code works on whichever backend is open.
 *
 * `relPath` is always project-root-relative, POSIX-separated
 * (e.g. 'parts.json', '.framecad/parts-meta.json').
 */

import * as driveProject from './drive-project'
import { pullMetadataFile, pushMetadataFile } from './drive'
import { pullRemoteFile, commitAndPushFile } from './git'

/** True when the open project uses the Drive backend. */
export function isDriveBackend(): boolean {
  return driveProject.isOpen()
}

/**
 * Refresh the local copy of a shared file from the team's latest before a
 * read-modify-write, so a reservation/edit never clobbers a teammate's.
 * Best effort on both backends.
 */
export async function pullSharedFile(relPath: string): Promise<void> {
  const dir = driveProject.currentDir()
  if (dir) {
    await pullMetadataFile(dir, relPath)
    return
  }
  await pullRemoteFile(relPath)
}

/**
 * Persist the local copy of a shared file to the team. On Drive this is an
 * immediate upload; on git it's a commit + push. Throws on failure so the
 * caller can roll back an in-memory reservation.
 */
export async function pushSharedFile(relPath: string, message: string): Promise<void> {
  const dir = driveProject.currentDir()
  if (dir) {
    await pushMetadataFile(dir, relPath)
    return
  }
  await commitAndPushFile(relPath, message)
}

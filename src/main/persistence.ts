/**
 * Persistence for the team-shared metadata files (parts.json,
 * .framecad/parts-meta.json, .framecad/admin.json).
 *
 * These files carry state every teammate must see. They are synced by
 * uploading them to the project's Drive folder immediately (not via the
 * debounced publish flow) so a part-number reservation or admin change is
 * visible to teammates the instant it happens. Callers (parts.ts, meta.ts,
 * admin.ts) go through here rather than touching the Drive layer directly.
 *
 * `relPath` is always project-root-relative, POSIX-separated
 * (e.g. 'parts.json', '.framecad/parts-meta.json').
 */

import { getActiveBackend } from './project-backend'

/**
 * Refresh the local copy of a shared file from the team's latest before a
 * read-modify-write, so a reservation/edit never clobbers a teammate's.
 * Best effort — no-op if no project is open. Routes to whichever storage
 * backend (Drive / Lore) currently has a project open.
 */
export async function pullSharedFile(relPath: string): Promise<void> {
  await getActiveBackend().pullSharedFile(relPath)
}

/**
 * Upload the local copy of a shared file to the project's storage backend.
 * Throws on failure so the caller can roll back an in-memory reservation.
 */
export async function pushSharedFile(relPath: string, _message: string): Promise<void> {
  await getActiveBackend().pushSharedFile(relPath)
}

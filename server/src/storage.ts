/**
 * Disk-usage scanner for the self-hosted LFS object store.
 *
 * Giftless writes objects under `<lfs-storage>/<org>/<repo>/<oid>`.
 * We use a fixed `framecad/<projectId>` prefix for every project, so
 * each project's footprint is one subtree we can walk with fs.stat.
 *
 * This module runs in the `framecad-server` container, which mounts
 * the LFS storage directory READ-ONLY (the giftless container is the
 * only writer). The mount path is configurable via `LFS_STORAGE_DIR`;
 * when missing or the path doesn't exist, scans return 0 silently so
 * a misconfigured operator just sees "0 bytes used" instead of 500s.
 *
 * Scan cost is dominated by readdir traversal — for a couple thousand
 * objects it's milliseconds. We still cache results in the `projects`
 * table so the admin Projects page doesn't pay it on every render;
 * the token-mint hot path re-scans + writes back the cached value.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

/** Subdirectory under the giftless storage root where THIS team
 *  server's projects live. Matches the URL prefix the desktop will
 *  send to giftless (`<lfs-url>/framecad/<id>/...`). */
const STORAGE_PREFIX = 'framecad'

/** Returns the absolute path of the directory holding a single
 *  project's LFS objects, or null if storage isn't configured. */
function projectDir(projectId: number): string | null {
  if (!config.lfsStorageDir) return null
  return path.join(config.lfsStorageDir, STORAGE_PREFIX, String(projectId))
}

/**
 * Walk a directory tree and sum the size of every regular file.
 * Symlinks (if any — giftless never creates them but a sysadmin
 * might) are followed and counted toward the total. Cycle detection
 * via a `visited` set on realpath keeps a circular symlink from
 * driving unbounded recursion. Missing directories return 0 — that's
 * what an empty project looks like before anyone has pushed anything.
 */
async function dirSize(absPath: string, visited = new Set<string>()): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(absPath, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  for (const entry of entries) {
    const child = path.join(absPath, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(child, visited)
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(child)
        total += stat.size
      } catch (err) {
        // Race: giftless might have just deleted this object. Skip it.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    } else if (entry.isSymbolicLink()) {
      try {
        const resolved = await fs.realpath(child)
        if (visited.has(resolved)) continue
        visited.add(resolved)
        const stat = await fs.stat(child)
        if (stat.isFile()) {
          total += stat.size
        } else if (stat.isDirectory()) {
          total += await dirSize(resolved, visited)
        }
      } catch (err) {
        // Broken symlink, permission denied, or loop — skip silently
        // rather than letting a misconfigured tree crash the scan.
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'ELOOP') throw err
      }
    }
  }
  return total
}

/**
 * Compute the current on-disk byte usage for a single project.
 * Returns 0 when LFS storage isn't configured (so the admin UI can
 * still render the quota column without erroring) or when the
 * project simply hasn't received any objects yet.
 */
export async function scanProjectStorage(projectId: number): Promise<number> {
  const dir = projectDir(projectId)
  if (!dir) return 0
  return dirSize(dir)
}

/** True iff the operator has wired LFS storage scanning into this
 *  process via LFS_STORAGE_DIR. When false, quota enforcement is
 *  skipped and the admin UI shows "Usage tracking off" alongside
 *  whatever quota was set. */
export function storageScanningEnabled(): boolean {
  return !!config.lfsStorageDir
}

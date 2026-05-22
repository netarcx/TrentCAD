import type { LockInfo } from '@shared/types'
import { getGit, refreshLfsAuthForOpenProject } from './git'

/**
 * Acquire a Git LFS lock on `filePath`. Idempotent when we already own
 * the lock; surfaces a clear "already checked out by <name>" error
 * when someone else holds it. Without this wrapper the LFS CLI's raw
 * "Lock exists" message lands in the UI verbatim — which auto-reported
 * as issue #1 (https://github.com/netarcx/FrameCAD/issues/1).
 */
export async function checkOut(filePath: string): Promise<void> {
  await refreshLfsAuthForOpenProject().catch(() => null)
  const g = getGit()
  try {
    await g.raw(['lfs', 'lock', filePath])
  } catch (err) {
    const msg = (err as Error).message || ''
    if (!/lock exists/i.test(msg)) throw err
    // LFS refused because a lock is already on file. Figure out whose.
    const { ours, theirs } = await verifyLocks()
    if (ours.some(l => l.path === filePath)) {
      // We already own it — make the operation idempotent.
      return
    }
    const stolen = theirs.find(l => l.path === filePath)
    if (stolen) {
      throw new Error(`Already checked out by ${stolen.owner}.`)
    }
    // Lock exists but neither ours nor theirs lists know it (likely
    // stale local state). Suggest a sync — that refreshes lock cache.
    throw new Error('Already locked — run Sync to refresh lock state, then try again.')
  }
}

/**
 * Force-release a Git LFS lock, even when it was acquired by someone
 * else. Used by the Admin panel's Locks tab to recover from a teammate
 * forgetting to check a file back in. Logs nothing locally — the LFS
 * server records the unlock against the caller's identity.
 */
export async function forceCheckIn(filePath: string): Promise<void> {
  const g = getGit()
  await g.raw(['lfs', 'unlock', '--force', filePath])
}

/**
 * Release a Git LFS lock on `filePath`. Idempotent when we don't hold
 * the lock; surfaces a clear message instead of LFS's raw error when
 * the file isn't locked or is locked by someone else.
 */
export async function checkIn(filePath: string): Promise<void> {
  await refreshLfsAuthForOpenProject().catch(() => null)
  const g = getGit()
  try {
    await g.raw(['lfs', 'unlock', filePath])
  } catch (err) {
    const msg = (err as Error).message || ''
    if (!/not locked|no matching|unable to find/i.test(msg) && !/lock.*does not exist/i.test(msg)) throw err
    // No lock to release — treat as a no-op so the UI doesn't bark
    // when the user double-clicks Check In.
  }
}

export async function getLocks(): Promise<LockInfo[]> {
  const g = getGit()
  try {
    const output = await g.raw(['lfs', 'locks', '--json'])
    const parsed = JSON.parse(output)

    if (!Array.isArray(parsed)) return []

    return parsed.map((lock: { path: string; owner: { name: string }; id: string }) => ({
      path: lock.path,
      owner: lock.owner?.name || 'unknown',
      id: lock.id
    }))
  } catch {
    try {
      const output = await g.raw(['lfs', 'locks'])
      const lines = output.trim().split('\n').filter(Boolean)
      return lines.map(line => {
        const parts = line.split('\t').map(s => s.trim())
        return {
          path: parts[0] || '',
          owner: parts[1] || 'unknown',
          id: parts[2]?.replace('ID:', '').trim() || ''
        }
      })
    } catch {
      return []
    }
  }
}

export async function verifyLocks(): Promise<{ ours: LockInfo[]; theirs: LockInfo[] }> {
  const g = getGit()
  try {
    const output = await g.raw(['lfs', 'locks', '--verify', '--json'])
    const parsed = JSON.parse(output)
    return {
      ours: (parsed.ours || []).map(mapLock),
      theirs: (parsed.theirs || []).map(mapLock)
    }
  } catch {
    return { ours: [], theirs: [] }
  }
}

function mapLock(lock: { path: string; owner: { name: string }; id: string }): LockInfo {
  return {
    path: lock.path,
    owner: lock.owner?.name || 'unknown',
    id: lock.id
  }
}

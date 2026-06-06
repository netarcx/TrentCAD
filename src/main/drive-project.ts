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
import { promises as fs } from 'node:fs'
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
import { getPolicies, currentSnapshot, listDriveLocks } from './teamServer'

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
  const serverProject = currentSnapshot().projects.find(p => p.driveFolderId === manifest.projectFolderId)
  const config: ProjectConfig = {
    name: serverProject?.name || path.basename(dir),
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

/** Flatten a status tree to the non-directory entries in the given states. */
function collectFiles(entries: FileEntry[], states: Set<string>, out: string[] = []): string[] {
  for (const e of entries) {
    if (!e.isDirectory && states.has(e.state)) out.push(e.path)
    if (e.children) collectFiles(e.children, states, out)
  }
  return out
}

/**
 * Enforce the team's publish policy (per-file size cap + blocked extensions)
 * before anything is uploaded. This is the real per-file backstop that used to
 * live in the git publish guard; it was lost when the Git backend was removed,
 * so a Drive publish had no size/extension check at all. Policies come from the
 * team server (getPolicies falls back to DEFAULT_TEAM_POLICIES offline/standalone,
 * matching the historical git behaviour). Throws — refusing the whole publish —
 * if any pending file violates, listing every offender.
 */
async function assertPublishAllowed(dir: string): Promise<void> {
  const policies = getPolicies()
  const pending = collectFiles(await getLocalStatus(dir), new Set(['modified', 'untracked']))
  const maxBytes = policies.maxFileSizeMb * 1024 * 1024
  const blocked = new Set(policies.blockedExtensions.map(e => e.toLowerCase()))
  const violations: string[] = []
  for (const rel of pending) {
    const dot = rel.lastIndexOf('.')
    const ext = dot >= 0 ? rel.slice(dot + 1).toLowerCase() : ''
    if (ext && blocked.has(ext)) {
      violations.push(`${rel} — .${ext} files are blocked by your team's settings`)
      continue
    }
    try {
      const st = await fs.stat(path.join(dir, ...rel.split('/')))
      if (st.size > maxBytes) {
        violations.push(`${rel} — ${(st.size / 1024 / 1024).toFixed(1)} MB exceeds the ${policies.maxFileSizeMb} MB limit`)
      }
    } catch { /* file vanished between status and stat — skip */ }
  }
  if (violations.length) {
    throw new Error(`Publish blocked by your team's settings:\n${violations.map(v => `  • ${v}`).join('\n')}`)
  }
}

/**
 * Enforce check-out locks before publishing. The lock is the PDM exclusivity
 * guarantee, but publish used to upload every changed file regardless — so a
 * user who never checked out (or whose lock view was stale) could silently
 * overwrite a teammate's revision (last-writer-wins). Here we refuse to
 * publish a MODIFIED file (an existing tracked file) that the publisher doesn't
 * hold the lock on. New (untracked) files need no lock.
 *
 * Standalone (un-enrolled) use has no team server / no locks, so it's exempt.
 * If we ARE enrolled but can't reach the server to verify, we block rather
 * than risk a blind overwrite (publish needs the network anyway).
 */
async function assertLocksHeld(dir: string, key: string): Promise<void> {
  const snap = currentSnapshot()
  if (!snap.enrolled) return // standalone — no team locks to honor
  const modified = collectFiles(await getLocalStatus(dir), new Set(['modified']))
  if (modified.length === 0) return
  let locks: { filePath: string; ownerMemberId: number; ownerName: string }[]
  try {
    locks = await listDriveLocks(key)
  } catch {
    throw new Error('Couldn’t verify check-outs with the team server. Connect to it and try again — publishing without a confirmed check-out could overwrite a teammate’s work.')
  }
  const myId = snap.me?.id
  const byPath = new Map(locks.map(l => [l.filePath, l]))
  const notHeld = modified.filter(p => byPath.get(p)?.ownerMemberId !== myId)
  if (notHeld.length) {
    const lines = notHeld.map(p => {
      const l = byPath.get(p)
      return l ? `${p} — checked out by ${l.ownerName}` : `${p} — you haven't checked this out`
    })
    throw new Error(`Check out these files before publishing changes to them:\n${lines.map(s => `  • ${s}`).join('\n')}`)
  }
}

/**
 * Background-upload one file's current bytes to the staging area so a later
 * publish can promote it without re-uploading. Best effort and a no-op when
 * no Drive project is open.
 */
export async function stageFile(relativePath: string): Promise<void> {
  if (!current) return
  // Don't background-upload a file the team policy would reject at publish —
  // staging it would put oversized bytes on the Shared Drive before the
  // publish guard ever runs (defeating "enforce before uploading anything").
  try {
    const st = await fs.stat(path.join(current.dir, ...relativePath.split('/')))
    if (st.size > getPolicies().maxFileSizeMb * 1024 * 1024) return
  } catch {
    return // file vanished — nothing to stage
  }
  await driveStageFile(current.dir, relativePath)
}

export async function sync(onProgress?: (p: PublishProgress) => void): Promise<{
  success: boolean
  filesUpdated: number
  error?: string
}> {
  if (!current) return { success: false, filesUpdated: 0, error: 'No Drive project open' }
  try {
    // Files this user holds a lock on — the rename-reconcile must not move
    // them out from under the held lock. Best effort: offline → no set → the
    // existing locally-dirty guard still protects actively-edited files.
    let lockedByMe: Set<string> | undefined
    try {
      const key = current.config.driveFolderId
      const myId = currentSnapshot().me?.id
      if (key && myId != null) {
        const locks = await listDriveLocks(key)
        lockedByMe = new Set(locks.filter(l => l.ownerMemberId === myId).map(l => l.filePath))
      }
    } catch { /* offline / not enrolled — skip the lock-aware guard */ }
    const res = await syncRemote(current.dir, prog => {
      onProgress?.({
        phase: prog.percent >= 100 ? 'done' : 'uploading',
        percent: prog.percent,
        detail: prog.detail
      })
    }, lockedByMe)
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
    // Enforce policy (size/extension) AND check-out locks BEFORE uploading.
    await assertPublishAllowed(current.dir)
    if (current.config.driveFolderId) {
      await assertLocksHeld(current.dir, current.config.driveFolderId)
    }
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

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
  getFolderName,
  setManifestFolderName,
  stageFile as driveStageFile,
  gcStaging as driveGcStaging
} from './drive'
import { loadManifest } from './drive-manifest'
import { joinTargetDir } from '@shared/paths'
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
  // The GUI name is locked to the Drive folder name. Legacy manifests (joined
  // before that field existed) have no name stored — back-fill it from Drive
  // once and persist, so later opens are fast and offline-safe. The registry
  // name / local basename are last-resort fallbacks only (offline + legacy).
  let driveName = manifest.projectFolderName
  if (!driveName) {
    const fetched = await getFolderName(manifest.projectFolderId)
    if (fetched) {
      driveName = fetched
      // Persist through the serialized manifest queue (never a bare save) so
      // the back-fill can't clobber a concurrent metadata/publish write.
      await setManifestFolderName(dir, fetched).catch(() => { /* best effort */ })
    }
  }
  const serverProject = currentSnapshot().projects.find(p => p.driveFolderId === manifest.projectFolderId)
  const config: ProjectConfig = {
    name: driveName || serverProject?.name || path.basename(dir),
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
 * Refuse join targets that would mix two projects into one tree.
 * Shared folders are poison: each project's sync/publish sees the
 * other's files as its own new files and cross-copies them into the
 * opposite Drive project. Three shapes to block:
 *  1. `dir` already holds a DIFFERENT project's manifest (re-joining
 *     the SAME project is fine — that's the partial-join repair path).
 *  2. `dir` sits INSIDE an existing project (an ancestor has a
 *     manifest) — the outer project would sync/publish the inner one.
 *  3. `dir` exists with foreign content and no manifest — the next
 *     publish would upload someone's unrelated files to the team Drive.
 */
async function assertJoinTargetSafe(dir: string, folderId: string): Promise<void> {
  const manifest = await loadManifest(dir)
  if (manifest && manifest.projectFolderId !== folderId) {
    throw new Error(
      `That folder already contains the FrameCAD project ` +
      `"${manifest.projectFolderName || path.basename(dir)}". Each project needs its own ` +
      `folder — pick a different save location.`
    )
  }

  for (let cur = path.dirname(dir); ; cur = path.dirname(cur)) {
    if (await loadManifest(cur)) {
      throw new Error(
        `That location is inside the FrameCAD project at "${cur}". ` +
        `Projects can't be nested — pick a folder outside it.`
      )
    }
    if (path.dirname(cur) === cur) break // filesystem root
  }

  if (!manifest) {
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    if (entries.length > 0) {
      throw new Error(
        `"${dir}" already exists and isn't empty. Joining into it would ` +
        `publish those files to the team's Shared Drive — pick a different ` +
        `save location (or empty that folder first).`
      )
    }
  }
}

/**
 * Join a Drive project: download every file under `folderId` into a
 * per-project subfolder of `savePath` (named after the Drive folder, so
 * two projects can never share a directory), write the manifest, and
 * make it the active project. `onProgress` is forwarded to the renderer
 * as a join-progress event by the IPC handler.
 */
export async function join(
  folderId: string,
  sharedDriveId: string,
  savePath: string,
  name: string,
  onProgress?: (p: PublishProgress) => void
): Promise<ProjectConfig> {
  // If the picked folder IS this project already (legacy layout from
  // before per-project subfolders, being re-joined to repair a partial
  // download), use it as-is. Otherwise same computation the renderer
  // previews (joinTargetDir): append the project's folder name unless
  // the picked folder is already named that.
  const pickedManifest = await loadManifest(savePath)
  const localPath = pickedManifest?.projectFolderId === folderId
    ? savePath
    : joinTargetDir(savePath, name, folderId, path.sep)
  await assertJoinTargetSafe(localPath, folderId)
  await downloadProject(folderId, sharedDriveId, localPath, prog => {
    onProgress?.({
      phase: prog.percent >= 100 ? 'done' : 'uploading',
      percent: prog.percent,
      detail: prog.detail
    })
  }, name)
  const config: ProjectConfig = {
    // `name` is the Drive folder name from the picker — the authoritative
    // display name, now also persisted in the manifest by downloadProject.
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
 * Recursively copy `src` → `dest`, SKIPPING (not aborting on) any file that
 * can't be read — e.g. a .sldprt/.sldasm the user has open in SolidWorks, which
 * holds an exclusive lock and makes a copy throw EBUSY/EPERM. Skipped files are
 * collected as project-relative paths so the caller can tell the user exactly
 * what was left out. A single locked file must not sink the whole snapshot — the
 * backup is most useful precisely while files are open.
 */
async function copyTreeResilient(src: string, dest: string, root: string, skipped: string[]): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyTreeResilient(from, to, root, skipped)
    } else if (entry.isFile()) {
      try {
        await fs.copyFile(from, to)
      } catch {
        skipped.push(path.relative(root, from).split(path.sep).join('/'))
      }
    }
    // Symlinks / sockets / fifos are ignored — projects are plain files + dirs.
  }
}

/**
 * Make a one-click local snapshot of the open project: a copy in a timestamped
 * sibling folder, DETACHED from Drive (the Drive manifest + staging state are
 * removed from the copy) so it can't sync or publish and won't be mistaken for
 * the live project. A pure rollback point the user can fall back on if a sync,
 * publish, or edit goes wrong. Files locked by another app (SolidWorks) are
 * skipped and reported rather than failing the whole backup. CAD files,
 * parts.json, and per-part metadata (parts-meta.json/admin.json) are preserved.
 */
export async function backup(): Promise<{ success: boolean; path?: string; error?: string; skipped?: string[] }> {
  if (!current) return { success: false, error: 'Open a project first, then back it up.' }
  try {
    // YYYY-MM-DD_HHMMSS — sorts chronologically and is filesystem-safe.
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
    const dest = path.join(path.dirname(current.dir), `${path.basename(current.dir)}-backup-${stamp}`)
    const skipped: string[] = []
    await copyTreeResilient(current.dir, dest, current.dir, skipped)
    // Detach the COPY from Drive by removing only the Drive-coupling files
    // (the manifest makes open() treat a folder as the live project; staging
    // state references Drive ids). Everything else under `.framecad` —
    // parts-meta.json, admin.json — is real project metadata and is kept, so
    // the snapshot is genuinely restorable. (Names per drive-manifest.ts.)
    await fs.rm(path.join(dest, '.framecad', 'drive-manifest.json'), { force: true }).catch(() => { /* none to remove */ })
    await fs.rm(path.join(dest, '.framecad', 'drive-staging.json'), { force: true }).catch(() => { /* none to remove */ })
    return { success: true, path: dest, skipped }
  } catch (err) {
    // A whole-operation failure now means something structural (can't create
    // the dest dir, out of disk) rather than one locked file.
    const code = (err as NodeJS.ErrnoException).code
    const msg = code === 'ENOSPC'
      ? 'Not enough disk space to create the backup.'
      : (err as Error).message
    return { success: false, error: msg }
  }
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
async function assertPublishAllowed(dir: string, pending: string[]): Promise<void> {
  const policies = getPolicies()
  const maxBytes = policies.maxFileSizeMb * 1024 * 1024
  const blocked = new Set(policies.blockedExtensions.map(e => e.toLowerCase()))
  // Probe each pending file CONCURRENTLY (the size check is an independent
  // fs.stat). Results are gathered back in `pending` order so the violation
  // list — which the user sees verbatim — is byte-identical to the serial pass.
  const perFile = await Promise.all(pending.map(async rel => {
    const dot = rel.lastIndexOf('.')
    const ext = dot >= 0 ? rel.slice(dot + 1).toLowerCase() : ''
    if (ext && blocked.has(ext)) {
      return `${rel} — .${ext} files are blocked by your team's settings`
    }
    try {
      const st = await fs.stat(path.join(dir, ...rel.split('/')))
      if (st.size > maxBytes) {
        return `${rel} — ${(st.size / 1024 / 1024).toFixed(1)} MB exceeds the ${policies.maxFileSizeMb} MB limit`
      }
    } catch { /* file vanished between status and stat — skip */ }
    return null
  }))
  const violations = perFile.filter((v): v is string => v !== null)
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
async function assertLocksHeld(key: string, allModified: string[]): Promise<void> {
  const snap = currentSnapshot()
  if (!snap.enrolled) return // standalone — no team locks to honor
  // parts.json is FrameCAD-managed shared metadata (part-number reservations),
  // written by the app — never something a user "checks out". A failed
  // metadata push can leave it locally dirty; requiring a lock on it would
  // block the publish with an error the user can't act on.
  const modified = allModified.filter(p => p !== 'parts.json')
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
    // Keep the GUI name in step with Drive: if the folder was renamed on
    // Drive, pick that up here and persist it. Best effort — a failed lookup
    // (offline mid-sync, perms) just leaves the existing name untouched. The
    // getFolderName fetch is done OUTSIDE the manifest lock; the persist goes
    // through the serialized queue so it can't clobber a concurrent write.
    if (current) {
      const liveName = await getFolderName(current.config.driveFolderId ?? '')
      if (liveName && liveName !== current.config.name) {
        current.config.name = liveName
        await setManifestFolderName(current.dir, liveName).catch(() => { /* best effort */ })
        // Also refresh the persisted recents entry so the welcome-screen name
        // matches the renamed folder without waiting for a reopen.
        await addRecentProject(current.config).catch(() => { /* best effort */ })
      }
    }
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
  const { dir, config } = current
  try {
    onProgress?.({ phase: 'preparing', percent: 0 })
    // Policy (size/extension) and check-out locks are enforced via the guard,
    // which publishChanges runs INSIDE its manifest lock against the exact
    // change set being uploaded. Asserting out here instead would race a
    // SolidWorks save landing while the publish waited on the lock — that file
    // would upload with no validation at all.
    const result = await publishChanges(dir, prog => {
      onProgress?.({
        phase: prog.percent >= 100 ? 'done' : 'uploading',
        percent: prog.percent,
        detail: prog.detail
      })
    }, async changes => {
      const pending = changes
        .filter(c => c.type === 'added' || c.type === 'modified')
        .map(c => c.relativePath)
      await assertPublishAllowed(dir, pending)
      if (config.driveFolderId) {
        const modified = changes.filter(c => c.type === 'modified').map(c => c.relativePath)
        await assertLocksHeld(config.driveFolderId, modified)
      }
    })
    onProgress?.({ phase: 'done', percent: 100 })
    return { success: true, changedPaths: result.changedPaths }
  } catch (err) {
    onProgress?.({ phase: 'error', error: (err as Error).message })
    return { success: false, error: (err as Error).message }
  }
}

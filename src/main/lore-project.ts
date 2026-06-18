/**
 * Orchestration layer for the Lore VCS storage backend — the peer of
 * `drive-project.ts`. Holds the currently-open Lore project (its local
 * directory + the ProjectConfig the renderer sees) and exposes the same verbs
 * (open / join / status / sync / publish / backup) so `project-backend.ts` can
 * route a handler to Lore or Drive based on which kind of project is open.
 *
 * A Lore project is any local folder that contains a `.lore/` directory (Lore
 * writes it on clone) plus a `.framecad/lore-meta.json` recording the
 * `lore://` remote URL + display name, so `open()` can rebuild ProjectConfig
 * offline without touching the SDK.
 *
 * Identity, locks, and publish history stay on the team server (same as Drive)
 * — Lore is only the storage byte-pusher here.
 */
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { FileEntry, ProjectConfig, PublishProgress } from '@shared/types'
import * as loreOps from './lore'
import { joinTargetDir } from '@shared/paths'
import { addRecentProject } from './config'
import { getPolicies, currentSnapshot, listDriveLocks } from './teamServer'

/** FrameCAD-level facts about a Lore project, stored in the working copy so
 *  open() doesn't have to hit the SDK/server just to build ProjectConfig. */
interface LoreMeta {
  loreUrl: string
  name: string
}

const META_REL = path.join('.framecad', 'lore-meta.json')

interface OpenLoreProject {
  dir: string
  config: ProjectConfig
}

let current: OpenLoreProject | null = null

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

/** The team-server lock/history key for the open Lore project = its remote
 *  `lore://` URL (stable + unique per project). Throws if none is open. */
export function projectKey(): string {
  const key = current?.config.loreUrl
  if (!key) throw new Error('No Lore project open (missing lore:// URL)')
  return key
}

/** The Lore commit author / lock owner = the enrolled team member's name. */
function identity(): string | undefined {
  return currentSnapshot().me?.displayName || undefined
}

async function readMeta(dir: string): Promise<LoreMeta | null> {
  try {
    const raw = await fs.readFile(path.join(dir, META_REL), 'utf-8')
    const meta = JSON.parse(raw) as LoreMeta
    return meta?.loreUrl ? meta : null
  } catch {
    return null
  }
}

async function writeMeta(dir: string, meta: LoreMeta): Promise<void> {
  await fs.mkdir(path.join(dir, '.framecad'), { recursive: true })
  await fs.writeFile(path.join(dir, META_REL), JSON.stringify(meta, null, 2))
}

/**
 * Best-effort recovery of the project's remote `lore://` URL from the Lore
 * repo's own `.lore/config.toml` (`remote_url = "lore://host:port"`), used only
 * when the FrameCAD lore-meta marker is missing/corrupt. This is the server
 * base URL and may lack the repo-path segment, so a fresh re-join restores the
 * exact URL — but it's enough to open the project instead of dead-ending.
 */
async function recoverUrlFromLoreConfig(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, '.lore', 'config.toml'), 'utf-8')
    const m = raw.match(/^\s*remote_url\s*=\s*"([^"]+)"/m)
    return m && m[1] ? m[1] : null
  } catch {
    return null
  }
}

async function hasLoreRepo(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(dir, '.lore'))
    return st.isDirectory()
  } catch {
    return false
  }
}

/**
 * Mark a local folder as the active Lore project. Returns null when the folder
 * isn't a Lore working copy (no `.lore/` + no lore-meta) so the caller can fall
 * through to the Drive open path.
 */
export async function open(dir: string): Promise<ProjectConfig | null> {
  let meta = await readMeta(dir)
  // Recovery: a valid .lore working copy whose FrameCAD marker was deleted or
  // corrupted must NOT be mislabeled "not a FrameCAD project". Rebuild the
  // marker from the Lore repo's own config (best-effort). If neither the marker
  // nor a .lore repo is present, it's genuinely not a Lore project → null.
  if (!meta) {
    if (!(await hasLoreRepo(dir))) return null
    const recovered = await recoverUrlFromLoreConfig(dir)
    if (!recovered) return null
    meta = { loreUrl: recovered, name: path.basename(dir) }
    await writeMeta(dir, meta).catch(() => { /* best effort */ })
  } else if (!(await hasLoreRepo(dir))) {
    return null
  }
  const config: ProjectConfig = {
    name: meta.name || path.basename(dir),
    path: dir,
    remote: meta.loreUrl,
    backend: 'lore',
    loreUrl: meta.loreUrl
  }
  current = { dir, config }
  await addRecentProject(config).catch(() => { /* best effort */ })
  return config
}

/**
 * Refuse join targets that would nest two projects or publish stray files —
 * the Lore peer of drive-project's assertJoinTargetSafe. Re-joining the SAME
 * lore:// URL into an existing copy is allowed (partial-clone repair).
 */
async function assertJoinTargetSafe(dir: string, url: string): Promise<void> {
  const meta = await readMeta(dir)
  if (meta && meta.loreUrl !== url) {
    throw new Error(
      `That folder already contains the FrameCAD project "${meta.name || path.basename(dir)}". ` +
      `Each project needs its own folder — pick a different save location.`
    )
  }
  // An ancestor that is itself a Lore project → nesting.
  for (let cur = path.dirname(dir); ; cur = path.dirname(cur)) {
    if (await hasLoreRepo(cur)) {
      throw new Error(
        `That location is inside the FrameCAD project at "${cur}". ` +
        `Projects can't be nested — pick a folder outside it.`
      )
    }
    if (path.dirname(cur) === cur) break
  }
  // Existing, non-empty, and not already this project → would publish strays.
  if (!meta) {
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    if (entries.length > 0) {
      throw new Error(
        `"${dir}" already exists and isn't empty. Joining into it would publish those ` +
        `files to the team's Lore server — pick a different save location (or empty it first).`
      )
    }
  }
}

/**
 * Join a Lore project: clone `url` into a per-project subfolder of `savePath`
 * (named after the project so two repos never share a directory), record the
 * lore-meta, and make it the active project.
 */
export async function join(
  url: string,
  savePath: string,
  name: string,
  onProgress?: (p: PublishProgress) => void
): Promise<ProjectConfig> {
  const existing = await readMeta(savePath)
  const localPath = existing?.loreUrl === url ? savePath : joinTargetDir(savePath, name, slugFromUrl(url), path.sep)
  await assertJoinTargetSafe(localPath, url)
  await loreOps.cloneRepo(url, localPath, identity(), onProgress)
  await writeMeta(localPath, { loreUrl: url, name })
  const config: ProjectConfig = {
    name: name || path.basename(localPath),
    path: localPath,
    remote: url,
    backend: 'lore',
    loreUrl: url
  }
  current = { dir: localPath, config }
  await addRecentProject(config).catch(() => { /* best effort */ })
  return config
}

/** Last path segment of a lore:// URL, as a fallback project folder name. */
function slugFromUrl(url: string): string {
  const seg = url.replace(/\/+$/, '').split('/').pop() ?? 'lore-project'
  return seg.replace(/[^A-Za-z0-9._-]/g, '-') || 'lore-project'
}

export async function status(): Promise<FileEntry[]> {
  if (!current) return []
  return loreOps.getStatus(current.dir)
}

export async function sync(onProgress?: (p: PublishProgress) => void): Promise<{
  success: boolean
  filesUpdated: number
  error?: string
}> {
  if (!current) return { success: false, filesUpdated: 0, error: 'No Lore project open' }
  try {
    const res = await loreOps.sync(current.dir, identity(), onProgress)
    // A merge conflict means a teammate changed a file you also changed. Don't
    // report success and silently leave the working copy in a conflicted state
    // (the user could then publish on top of an unresolved merge).
    if (res.conflict) {
      return {
        success: false,
        filesUpdated: res.filesUpdated,
        error: 'Sync hit a merge conflict — a teammate changed a file you also edited. Review the conflicted files, then publish.'
      }
    }
    return { success: true, filesUpdated: res.filesUpdated }
  } catch (err) {
    return { success: false, filesUpdated: 0, error: (err as Error).message }
  }
}

/**
 * Per-file policy backstop (size cap + blocked extensions) — the Lore peer of
 * drive-project's assertPublishAllowed. Throws, refusing the whole publish, if
 * any pending file violates.
 */
async function assertPublishAllowed(dir: string, pending: string[]): Promise<void> {
  const policies = getPolicies()
  const maxBytes = policies.maxFileSizeMb * 1024 * 1024
  const blocked = new Set(policies.blockedExtensions.map(e => e.toLowerCase()))
  const perFile = await Promise.all(pending.map(async rel => {
    const dot = rel.lastIndexOf('.')
    const ext = dot >= 0 ? rel.slice(dot + 1).toLowerCase() : ''
    if (ext && blocked.has(ext)) return `${rel} — .${ext} files are blocked by your team's settings`
    try {
      const st = await fs.stat(path.join(dir, ...rel.split('/')))
      if (st.size > maxBytes) {
        return `${rel} — ${(st.size / 1024 / 1024).toFixed(1)} MB exceeds the ${policies.maxFileSizeMb} MB limit`
      }
    } catch { /* vanished between scan and stat — skip */ }
    return null
  }))
  const violations = perFile.filter((v): v is string => v !== null)
  if (violations.length) {
    throw new Error(`Publish blocked by your team's settings:\n${violations.map(v => `  • ${v}`).join('\n')}`)
  }
}

/**
 * Enforce check-out locks before publishing a MODIFIED file, mirroring
 * drive-project's assertLocksHeld. Best-effort for the Lore experiment: if the
 * team server can't be reached or has no project row for this Lore key yet, we
 * don't block (Drive hard-blocks here — revisit once Lore projects are
 * registered server-side, see Phase 4).
 */
async function assertLocksHeld(key: string, modified: string[]): Promise<void> {
  const snap = currentSnapshot()
  if (!snap.enrolled) return
  const toCheck = modified.filter(p => p !== 'parts.json')
  if (toCheck.length === 0) return
  let locks: { filePath: string; ownerMemberId: number; ownerName: string }[]
  try {
    locks = await listDriveLocks(key)
  } catch {
    return // server unreachable / no Lore project row — don't block the experiment
  }
  const myId = snap.me?.id
  const byPath = new Map(locks.map(l => [l.filePath, l]))
  // Only block files a teammate holds — silence on files nobody locked.
  const heldByOther = toCheck.filter(p => {
    const l = byPath.get(p)
    return l && l.ownerMemberId !== myId
  })
  if (heldByOther.length) {
    const lines = heldByOther.map(p => `${p} — checked out by ${byPath.get(p)!.ownerName}`)
    throw new Error(`These files are checked out by a teammate — coordinate before publishing:\n${lines.map(s => `  • ${s}`).join('\n')}`)
  }
}

export async function publish(onProgress?: (p: PublishProgress) => void): Promise<{
  success: boolean
  error?: string
  changedPaths?: string[]
}> {
  if (!current) return { success: false, error: 'No Lore project open' }
  const { dir } = current
  try {
    onProgress?.({ phase: 'preparing', percent: 0 })
    // Compute changes BEFORE staging/commit (commit clears the dirty flags).
    // `deleted` must be included so a delete-only publish isn't short-circuited;
    // `isLocalAhead` means a prior publish committed but its push failed — we
    // still need to publish to flush that stranded commit.
    const { modified, untracked, deleted, isLocalAhead } = await loreOps.listChanges(dir)
    const changedPaths = [...modified, ...untracked, ...deleted]
    if (changedPaths.length === 0 && !isLocalAhead) {
      onProgress?.({ phase: 'done', percent: 100 })
      return { success: true, changedPaths: [] }
    }
    // Only stat existing files for the policy check; deleted ones are gone.
    await assertPublishAllowed(dir, [...modified, ...untracked])
    await assertLocksHeld(projectKey(), modified)
    // Atomic stage→commit→push (always pushes, flushing any stranded commit).
    const { committed } = await loreOps.publishWorkingTree(dir, identity(), '', onProgress)
    onProgress?.({ phase: 'done', percent: 100 })
    // History records only what THIS publish committed; a pure stranded-commit
    // flush (committed=false via isLocalAhead) records nothing.
    return { success: true, changedPaths: committed ? changedPaths : [] }
  } catch (err) {
    onProgress?.({ phase: 'error', error: (err as Error).message })
    return { success: false, error: (err as Error).message }
  }
}

/** Lore has no Drive-style staging area — publish stages the working tree. */
export async function stageFile(_relativePath: string): Promise<void> {
  /* no-op: Lore content-addresses on commit; there's nothing to pre-upload */
}

/**
 * Recursively copy `src` → `dest`, skipping (not aborting on) files locked by
 * another app (SolidWorks). Mirrors drive-project's copyTreeResilient.
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
  }
}

/**
 * One-click local snapshot, detached from Lore: a copy in a timestamped sibling
 * folder with `.lore/` and the lore-meta removed so it can't sync/publish and
 * isn't mistaken for the live project.
 */
export async function backup(): Promise<{ success: boolean; path?: string; error?: string; skipped?: string[] }> {
  if (!current) return { success: false, error: 'Open a project first, then back it up.' }
  try {
    const d = new Date()
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
    const dest = path.join(path.dirname(current.dir), `${path.basename(current.dir)}-backup-${stamp}`)
    const skipped: string[] = []
    await copyTreeResilient(current.dir, dest, current.dir, skipped)
    // Detach the copy: drop the Lore repo dir + the FrameCAD lore marker.
    await fs.rm(path.join(dest, '.lore'), { recursive: true, force: true }).catch(() => { /* none */ })
    await fs.rm(path.join(dest, META_REL), { force: true }).catch(() => { /* none */ })
    return { success: true, path: dest, skipped }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const msg = code === 'ENOSPC' ? 'Not enough disk space to create the backup.' : (err as Error).message
    return { success: false, error: msg }
  }
}

import path from 'path'
import fs from 'fs/promises'
import type { BulkMetaPatch, ManufacturingMethod, ManufacturingQueueItem, PartMeta, ProjectTotals, ReleaseState } from '@shared/types'
export type { BulkMetaPatch }
import { getProjectPath, getGit, pullRemoteFile, commitAndPushFile } from './git'
import { isSwAlive, queuePendingExport } from './export-queue'

const META_DIR = '.framecad'
const META_FILE = 'parts-meta.json'

// --- Debounced meta commit/push ---
// Saves are written to disk immediately so the UI stays responsive, but
// the git commit+push is deferred by 60 seconds. Each new meta write
// resets the timer so rapid edits collapse into a single commit.
const META_COMMIT_DELAY = 60_000
let metaCommitTimer: ReturnType<typeof setTimeout> | null = null
let pendingCommitMessages: string[] = []

function scheduleMetaCommit(message: string): void {
  pendingCommitMessages.push(message)
  if (metaCommitTimer) clearTimeout(metaCommitTimer)
  metaCommitTimer = setTimeout(flushMetaCommit, META_COMMIT_DELAY)
}

async function flushMetaCommit(): Promise<void> {
  metaCommitTimer = null
  const messages = pendingCommitMessages.splice(0)
  if (messages.length === 0) return
  const combined = messages.length === 1
    ? messages[0]
    : `[meta] ${messages.length} changes\n\n${messages.map(m => `- ${m}`).join('\n')}`
  try {
    await commitAndPushFile(metaRelPath(), combined)
  } catch (err) {
    // Log but don't crash — the local file is already saved. Next
    // mutation or manual publish will pick it up.
    console.error('[meta] deferred commit/push failed:', (err as Error).message)
  }
}

export { flushMetaCommit }

interface PartsMetaFile { [relPath: string]: PartMeta }

function metaAbsPath(): string {
  return path.join(getProjectPath(), META_DIR, META_FILE)
}

function metaRelPath(): string {
  return `${META_DIR}/${META_FILE}`
}

export async function loadAllMeta(): Promise<PartsMetaFile> {
  try {
    const raw = await fs.readFile(metaAbsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    // File might contain git conflict markers — try to salvage by
    // stripping markers and merging both sides of the conflict.
    try {
      const raw = await fs.readFile(metaAbsPath(), 'utf-8')
      if (raw.includes('<<<<<<<') && raw.includes('>>>>>>>')) {
        const merged = mergeConflictedJson(raw)
        if (merged) {
          await saveAllMeta(merged)
          return merged
        }
      }
    } catch { /* give up */ }
    return {}
  }
}

function mergeConflictedJson(raw: string): PartsMetaFile | null {
  // Extract both sides of the conflict and merge them (theirs as base,
  // ours on top so local edits win for any overlapping keys).
  try {
    const oursChunks: string[] = []
    const theirsChunks: string[] = []
    let section: 'none' | 'ours' | 'theirs' = 'none'
    for (const line of raw.split('\n')) {
      if (line.startsWith('<<<<<<<')) { section = 'ours'; continue }
      if (line.startsWith('=======')) { section = 'theirs'; continue }
      if (line.startsWith('>>>>>>>')) { section = 'none'; continue }
      if (section === 'ours') oursChunks.push(line)
      else if (section === 'theirs') theirsChunks.push(line)
      else { oursChunks.push(line); theirsChunks.push(line) }
    }
    const ours: PartsMetaFile = JSON.parse(oursChunks.join('\n') || '{}')
    const theirs: PartsMetaFile = JSON.parse(theirsChunks.join('\n') || '{}')
    return { ...theirs, ...ours }
  } catch {
    return null
  }
}

async function saveAllMeta(meta: PartsMetaFile): Promise<void> {
  const full = metaAbsPath()
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, JSON.stringify(meta, null, 2) + '\n')
}

/**
 * Move the parts-meta.json entry for `oldPath` to `newPath` after a
 * file rename. Called from parts.ts handleFileMoves so release state,
 * comments, mass/cost/method/material follow the file. No-op if the
 * source key doesn't exist or the destination is already populated
 * (we don't want to overwrite metadata on a path collision).
 *
 * Writes are local-only — the parts.json save cycle in parts.ts
 * commits both files in the same git operation so meta and manifest
 * stay in sync on push.
 */
export async function migrateMetaPath(oldPath: string, newPath: string): Promise<void> {
  if (oldPath === newPath) return
  const all = await loadAllMeta()
  if (!all[oldPath]) return
  if (all[newPath]) return
  all[newPath] = all[oldPath]
  delete all[oldPath]
  await saveAllMeta(all)
}

/**
 * Drop the parts-meta.json entry for a path that no longer exists on
 * disk. Used when parts.json detects a missing file and is about to
 * leave a tombstone — the part number stays reserved but the metadata
 * should not.
 */
export async function pruneMetaPath(filePath: string): Promise<void> {
  const all = await loadAllMeta()
  if (!all[filePath]) return
  delete all[filePath]
  await saveAllMeta(all)
}

/**
 * Return parts-meta.json keys that have no corresponding entry in the
 * given parts.json manifest. Used by checkManifestIntegrity to surface
 * orphans from before the migrateMetaPath / pruneMetaPath fixes landed.
 */
export async function findOrphanMetaPaths(manifestPaths: Set<string>): Promise<string[]> {
  const all = await loadAllMeta()
  return Object.keys(all).filter(p => !manifestPaths.has(p))
}

async function gitUsername(): Promise<string> {
  try {
    const value = (await getGit().getConfig('user.name')).value
    return value || 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function getPartMeta(filePath: string): Promise<PartMeta> {
  const all = await loadAllMeta()
  return all[filePath] || {}
}

async function modifyAndSync(
  filePath: string,
  mutator: (entry: PartMeta) => void,
  commitMessage: string
): Promise<void> {
  await pullRemoteFile(metaRelPath())
  const all = await loadAllMeta()
  const entry = all[filePath] || {}
  mutator(entry)
  all[filePath] = entry
  await saveAllMeta(all)
  scheduleMetaCommit(commitMessage)
}

/**
 * In-place mutator that expands a set of "trigger" paths (assemblies
 * moved to in-review) into every part under their folder subtree, also
 * marked in-review. Mutates `all` directly so the caller can fold the
 * cascade into the same write/commit cycle. Returns the number of
 * extra files that were touched. Manufactured parts are deliberately
 * skipped — re-reviewing something the shop already made would be
 * confusing.
 */
async function cascadeAssemblyInReview(
  all: PartsMetaFile,
  triggerPaths: string[],
  by: string,
  at: string,
  note: string | undefined
): Promise<number> {
  if (triggerPaths.length === 0) return 0
  const { loadManifest } = await import('./parts')
  const manifest = await loadManifest().catch(() => null)
  if (!manifest) return 0

  let count = 0
  const visited = new Set<string>()
  for (const trigger of triggerPaths) {
    const folder = path.posix.dirname(trigger.replace(/\\/g, '/'))
    const prefix = folder === '.' ? '' : folder + '/'
    for (const p of Object.keys(manifest.entries)) {
      if (p === trigger || visited.has(p)) continue
      const norm = p.replace(/\\/g, '/')
      if (prefix && !norm.startsWith(prefix)) continue
      const current = all[p]?.release?.state
      if (current === 'manufactured') continue
      all[p] = {
        ...(all[p] || {}),
        release: { state: 'in-review', by, at, note }
      }
      visited.add(p)
      count++
    }
  }
  return count
}

export async function setReleaseState(
  filePath: string,
  state: ReleaseState,
  note?: string
): Promise<void> {
  const by = await gitUsername()
  const at = new Date().toISOString()
  const trimmedNote = note?.trim() || undefined

  await pullRemoteFile(metaRelPath())
  const all = await loadAllMeta()
  all[filePath] = {
    ...(all[filePath] || {}),
    release: { state, by, at, note: trimmedNote }
  }

  let cascadeCount = 0
  if (state === 'in-review' && filePath.toLowerCase().endsWith('.sldasm')) {
    cascadeCount = await cascadeAssemblyInReview(all, [filePath], by, at, trimmedNote)
  }
  await saveAllMeta(all)

  const baseName = path.basename(filePath, path.extname(filePath))
  const msg = cascadeCount > 0
    ? `[release] ${baseName} → ${state} (+ ${cascadeCount} cascaded)`
    : `[release] ${baseName} → ${state}`
  scheduleMetaCommit(msg)

  // After a CAM-track part lands in "released", try to get an export
  // paired with it. If SolidWorks is open and listening we kick off an
  // async export task; otherwise the part shows up in the needs-export
  // queue and someone can batch-trigger from the admin panel later.
  if (state === 'released') {
    const method = all[filePath]?.manufacturingMethod
    const format = exportFormatFor(method)
    if (format && !(await exportExistsOnDisk(filePath, format)) && isSwAlive()) {
      queuePendingExport(getProjectPath(), filePath, format)
    }
  }
}

export async function addComment(filePath: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Comment cannot be empty')
  const author = await gitUsername()
  await modifyAndSync(
    filePath,
    entry => {
      if (!entry.comments) entry.comments = []
      entry.comments.push({
        id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        author,
        text: trimmed,
        at: new Date().toISOString()
      })
    },
    `[comment] ${path.basename(filePath)}: ${trimmed.slice(0, 40)}`
  )
}

export async function setManufacturingNotes(filePath: string, notes: string): Promise<void> {
  await modifyAndSync(
    filePath,
    entry => { entry.manufacturingNotes = notes },
    `[mfg-notes] ${path.basename(filePath)}`
  )
}

export async function setPartMass(filePath: string, mass: number | null): Promise<void> {
  if (mass !== null && (!isFinite(mass) || mass < 0)) {
    throw new Error('Mass must be a non-negative number')
  }
  await modifyAndSync(
    filePath,
    entry => {
      if (mass === null) delete entry.mass
      else entry.mass = mass
    },
    `[mass] ${path.basename(filePath)} = ${mass === null ? 'cleared' : `${mass} lb`}`
  )
}

export async function setPartCost(filePath: string, cost: number | null): Promise<void> {
  if (cost !== null && (!isFinite(cost) || cost < 0)) {
    throw new Error('Cost must be a non-negative number')
  }
  await modifyAndSync(
    filePath,
    entry => {
      if (cost === null) delete entry.cost
      else entry.cost = cost
    },
    `[cost] ${path.basename(filePath)} = ${cost === null ? 'cleared' : `$${cost}`}`
  )
}

export async function setManufacturingMethod(
  filePath: string,
  method: ManufacturingMethod | null
): Promise<void> {
  await modifyAndSync(
    filePath,
    entry => {
      if (method === null) delete entry.manufacturingMethod
      else entry.manufacturingMethod = method
    },
    `[mfg-method] ${path.basename(filePath)} = ${method ?? 'cleared'}`
  )
}

export async function setManufacturingMaterial(filePath: string, material: string): Promise<void> {
  await modifyAndSync(
    filePath,
    entry => {
      const trimmed = (material ?? '').trim()
      if (!trimmed) delete entry.manufacturingMaterial
      else entry.manufacturingMaterial = trimmed
    },
    `[mfg-material] ${path.basename(filePath)}`
  )
}

/**
 * Apply many per-path patches in a single pull/commit/push cycle. Used
 * by the renderer's edit queue so rapid cell edits and bulk-select
 * actions both collapse to one commit + push instead of N.
 *
 * `updates` may include the same field across many paths (bulk select)
 * or different fields per path (queued user edits) — both work. Returns
 * the count of patched entries.
 */
export async function bulkUpdateMeta(updates: Record<string, BulkMetaPatch>): Promise<number> {
  const entries = Object.entries(updates).filter(([, p]) => p && Object.keys(p).length > 0)
  if (entries.length === 0) return 0

  const by = await gitUsername()
  const now = new Date().toISOString()

  await pullRemoteFile(metaRelPath())
  const all = await loadAllMeta()

  let touched = 0
  const fieldCounts: Record<string, number> = {}
  let uniformRelease: ReleaseState | null | 'mixed' = null
  let uniformMethod: ManufacturingMethod | null | 'mixed' | undefined = undefined
  const assemblyInReviewTriggers: string[] = []

  for (const [filePath, patch] of entries) {
    const entry = all[filePath] || {}
    if (patch.release !== undefined) {
      entry.release = { state: patch.release, by, at: now }
      fieldCounts.release = (fieldCounts.release || 0) + 1
      if (uniformRelease === null) uniformRelease = patch.release
      else if (uniformRelease !== patch.release) uniformRelease = 'mixed'
      if (patch.release === 'in-review' && filePath.toLowerCase().endsWith('.sldasm')) {
        assemblyInReviewTriggers.push(filePath)
      }
    }
    if (patch.manufacturingMethod !== undefined) {
      if (patch.manufacturingMethod === null) delete entry.manufacturingMethod
      else entry.manufacturingMethod = patch.manufacturingMethod
      fieldCounts.method = (fieldCounts.method || 0) + 1
      if (uniformMethod === undefined) uniformMethod = patch.manufacturingMethod
      else if (uniformMethod !== patch.manufacturingMethod) uniformMethod = 'mixed'
    }
    if (patch.manufacturingMaterial !== undefined) {
      const trimmed = (patch.manufacturingMaterial ?? '').trim()
      if (!trimmed) delete entry.manufacturingMaterial
      else entry.manufacturingMaterial = trimmed
      fieldCounts.material = (fieldCounts.material || 0) + 1
    }
    if (patch.mass !== undefined) {
      if (patch.mass === null) delete entry.mass
      else if (isFinite(patch.mass) && patch.mass >= 0) entry.mass = patch.mass
      fieldCounts.mass = (fieldCounts.mass || 0) + 1
    }
    if (patch.cost !== undefined) {
      if (patch.cost === null) delete entry.cost
      else if (isFinite(patch.cost) && patch.cost >= 0) entry.cost = patch.cost
      fieldCounts.cost = (fieldCounts.cost || 0) + 1
    }
    if (patch.manufacturingNotes !== undefined) {
      const trimmed = (patch.manufacturingNotes ?? '').trim()
      if (!trimmed) delete entry.manufacturingNotes
      else entry.manufacturingNotes = trimmed
      fieldCounts.notes = (fieldCounts.notes || 0) + 1
    }
    all[filePath] = entry
    touched++
  }

  const cascadeCount = await cascadeAssemblyInReview(
    all, assemblyInReviewTriggers, by, now, undefined
  )
  await saveAllMeta(all)

  const labelParts: string[] = []
  if (fieldCounts.release) {
    labelParts.push(uniformRelease === 'mixed' ? `release×${fieldCounts.release}` : `release=${uniformRelease}`)
  }
  if (fieldCounts.method) {
    const m = uniformMethod === 'mixed' ? `method×${fieldCounts.method}` :
      `method=${uniformMethod ?? 'cleared'}`
    labelParts.push(m)
  }
  if (fieldCounts.material) labelParts.push(`material×${fieldCounts.material}`)
  if (fieldCounts.mass) labelParts.push(`mass×${fieldCounts.mass}`)
  if (fieldCounts.cost) labelParts.push(`cost×${fieldCounts.cost}`)
  if (fieldCounts.notes) labelParts.push(`notes×${fieldCounts.notes}`)
  if (cascadeCount > 0) labelParts.push(`+${cascadeCount} cascaded`)
  const msg = `[bulk-meta] ${touched} part${touched === 1 ? '' : 's'}: ${labelParts.join(', ')}`
  scheduleMetaCommit(msg)
  return touched
}

/**
 * Format expected for the CAM-ready export paired with a released part:
 *   cnc   → .step  (also accept .stp on disk)
 *   print → .stl
 * Anything else returns null — no export is required.
 */
export function exportFormatFor(method: ManufacturingMethod | undefined): 'step' | 'stl' | null {
  if (method === 'cnc') return 'step'
  if (method === 'print') return 'stl'
  return null
}

/**
 * Resolve where the paired export should live for a given source file.
 * The export sits next to the source with the same basename. Returns
 * project-relative path.
 */
export function expectedExportRelPath(srcRelPath: string, format: 'step' | 'stl'): string {
  const ext = path.extname(srcRelPath)
  const base = srcRelPath.slice(0, srcRelPath.length - ext.length)
  return `${base}.${format}`
}

/**
 * Does the paired export already exist on disk? For STEP we also accept
 * the `.stp` alias so manual exports from other tools count.
 */
async function exportExistsOnDisk(srcRelPath: string, format: 'step' | 'stl'): Promise<boolean> {
  const projectPath = getProjectPath()
  const candidates = format === 'step'
    ? [expectedExportRelPath(srcRelPath, 'step'), srcRelPath.slice(0, -path.extname(srcRelPath).length) + '.stp']
    : [expectedExportRelPath(srcRelPath, 'stl')]
  for (const rel of candidates) {
    try {
      await fs.access(path.join(projectPath, rel))
      return true
    } catch { /* not present, try next */ }
  }
  return false
}

/**
 * Build the manufacturing queue — every part currently in the "released"
 * state, ready for the shop to make. Ordered oldest-first so the earliest
 * approvals get worked first. CAM-required parts (cnc/print) get a
 * `needsExport` flag when their paired .step/.stl is missing on disk.
 */
export async function getManufacturingQueue(): Promise<ManufacturingQueueItem[]> {
  const all = await loadAllMeta()
  const items: ManufacturingQueueItem[] = []
  for (const [filePath, entry] of Object.entries(all)) {
    if (entry.release?.state !== 'released') continue
    const method = entry.manufacturingMethod || 'other'
    const format = exportFormatFor(method)
    const item: ManufacturingQueueItem = {
      path: filePath,
      method,
      material: entry.manufacturingMaterial,
      mass: entry.mass,
      notes: entry.manufacturingNotes,
      releasedBy: entry.release.by,
      releasedAt: entry.release.at
    }
    if (format && !(await exportExistsOnDisk(filePath, format))) {
      item.needsExport = format
      item.expectedExportPath = expectedExportRelPath(filePath, format)
    }
    items.push(item)
  }
  items.sort((a, b) => (a.releasedAt || '').localeCompare(b.releasedAt || ''))
  return items
}

/**
 * Sum mass and cost across every entry in parts-meta.json. Counts also
 * how many entries have each field populated so the UI can show
 * "(based on N of M parts)".
 */
export async function getProjectTotals(): Promise<ProjectTotals> {
  const all = await loadAllMeta()
  const totals: ProjectTotals = { mass: 0, cost: 0, partsWithMass: 0, partsWithCost: 0, totalParts: 0 }
  for (const key of Object.keys(all)) {
    totals.totalParts++
    const entry = all[key]
    if (typeof entry.mass === 'number' && entry.mass > 0) {
      totals.mass += entry.mass
      totals.partsWithMass++
    }
    if (typeof entry.cost === 'number' && entry.cost > 0) {
      totals.cost += entry.cost
      totals.partsWithCost++
    }
  }
  return totals
}

/**
 * Walk a FileEntry tree and stamp each entry with release state + comment
 * count from the in-memory meta map. Mirrors annotatePartNumbers in parts.ts.
 */
export function annotateMeta(
  entries: Array<{ path: string; isDirectory: boolean; children?: unknown[]; releaseState?: ReleaseState; commentCount?: number }>,
  meta: PartsMetaFile,
  gitPrefix = ''
): void {
  for (const entry of entries) {
    if (!entry.isDirectory) {
      const key = gitPrefix ? `${gitPrefix}/${entry.path}` : entry.path
      const m = meta[key]
      if (m?.release?.state) entry.releaseState = m.release.state
      if (m?.comments?.length) entry.commentCount = m.comments.length
    }
    if (entry.children) {
      annotateMeta(entry.children as typeof entries, meta, gitPrefix)
    }
  }
}

import path from 'path'
import fs from 'fs/promises'
import type { FileEntry, PartsManifest, PartEntry, PartType } from '@shared/types'
import { getProjectPath } from './project-paths'
import { pullSharedFile, pushSharedFile } from './persistence'
import { getBuildDefaultPrefix } from './branding'

const MANIFEST_FILE = 'parts.json'
const SOLIDWORKS_EXTS = new Set(['.sldprt', '.sldasm', '.slddrw'])

async function isCotsProject(): Promise<boolean> {
  // Read .framecad/admin.json directly to avoid a circular import with admin.ts.
  // COTS-library projects skip the entire part-numbering layer.
  try {
    const adminFile = path.join(getProjectPath(), '.framecad', 'admin.json')
    const raw = await fs.readFile(adminFile, 'utf-8')
    return JSON.parse(raw).isCotsProject === true
  } catch {
    return false
  }
}

async function isImportedProject(): Promise<boolean> {
  // As above. An imported project preserves its existing part numbers, so
  // auto-assign runs in legacy (filename-as-number) mode and never imposes
  // the YY-prefix scheme on files that already carry numbers.
  try {
    const adminFile = path.join(getProjectPath(), '.framecad', 'admin.json')
    const raw = await fs.readFile(adminFile, 'utf-8')
    return JSON.parse(raw).isImportedProject === true
  } catch {
    return false
  }
}
function defaultPrefix(): string {
  const yy = new Date().getFullYear().toString().slice(-2)
  // Build-time default first (forks set FRAMECAD_DEFAULT_PROJECT_PREFIX).
  // If the baked-in value already has a year, take it as-is; if it's
  // just the team segment (e.g. "1234"), prepend the current year.
  // Falls back to a neutral placeholder when nothing's set — the user
  // can rename via the admin panel.
  const baked = getBuildDefaultPrefix()
  if (baked) return /^\d{2}-/.test(baked) ? baked : `${yy}-${baked}`
  return `${yy}-TEAM`
}

let manifestLock: Promise<void> = Promise.resolve()

/** The part-number conflicts surfaced by the most recent reconcile pass
 *  (offline-created numbers a teammate had already taken). Exposed over the
 *  local REST API so the SolidWorks add-in can show + guide the fix. */
let lastNumberConflicts: Array<{ path: string; current: string; suggested: string }> = []
export function getNumberConflicts(): Array<{ path: string; current: string; suggested: string }> {
  return lastNumberConflicts
}

/**
 * Serialise a parts.json read-modify-write against every other one. ALL
 * mutators (create part/assembly, syncManifest, reconcile — from both the IPC
 * renderer path AND the localhost REST add-in path, since they share this one
 * module) must go through here, or two concurrent pull→modify→push cycles can
 * clobber each other (each writes the whole file via atomic temp+rename, so the
 * loser's entry — including a just-created part — silently vanishes).
 */
function withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = manifestLock.then(fn)
  manifestLock = p.then(() => {}, () => {})
  return p
}

/** True if any entry (optionally other than `exceptPath`) already carries this
 *  part number — so a server-suggested counter that's free in the registry but
 *  already used in this project's parts.json can't create a duplicate. */
function isNumberTaken(manifest: PartsManifest, partNumber: string, exceptPath?: string): boolean {
  for (const [p, e] of Object.entries(manifest.entries)) {
    if (p !== exceptPath && e.partNumber === partNumber) return true
  }
  return false
}

function emptyManifest(): PartsManifest {
  return {
    prefix: defaultPrefix(),
    nextCounters: {},
    nextAssemblyCounters: {},
    entries: {},
    assemblies: {}
  }
}

function ensureYearPrefix(manifest: PartsManifest): PartsManifest {
  const yy = new Date().getFullYear().toString().slice(-2)
  if (manifest.prefix && !/^\d{2}-/.test(manifest.prefix)) {
    manifest.prefix = `${yy}-${manifest.prefix}`
  }
  return manifest
}

export async function loadManifest(): Promise<PartsManifest> {
  let data: string
  try {
    data = await fs.readFile(path.join(getProjectPath(), MANIFEST_FILE), 'utf-8')
  } catch {
    return emptyManifest() // no manifest yet — fresh project
  }
  try {
    return ensureYearPrefix(JSON.parse(data))
  } catch {
    // Genuine corruption (e.g. a crash truncated parts.json). Do NOT fall
    // back to an empty manifest — that would re-issue part numbers from 1,
    // drop every tombstone, and the deferred push would propagate the damage
    // team-wide. Fail loudly so the file can be restored instead.
    throw new Error('parts.json could not be parsed — it may be corrupted. Refusing to overwrite it; restore it (Sync, or from a teammate) and retry.')
  }
}

/**
 * "Where used" for a given part: the assembly (.sldasm) files that
 * sit in this part's folder OR any ancestor folder up to the project
 * root. We use folder containment as the relationship because the
 * team's part-numbering convention already groups parts by their
 * containing assembly folder (e.g. Drivetrain/Frame.sldprt is part of
 * Drivetrain/Drivetrain.sldasm). Doesn't crack open .sldasm bytes to
 * inspect actual references — that'd be a Windows-only Solidworks
 * round-trip and is overkill for the current workflow.
 *
 * Returns paths ordered closest-to-the-part first.
 */
export async function findWhereUsed(filePath: string): Promise<string[]> {
  const manifest = await loadManifest()
  const norm = filePath.replace(/\\/g, '/')
  const folder = path.posix.dirname(norm)
  if (folder === '.') return []

  // Build the list of ancestor folder prefixes, deepest first.
  const ancestors: string[] = []
  let cursor = folder
  while (cursor && cursor !== '.') {
    ancestors.push(cursor)
    const next = path.posix.dirname(cursor)
    if (next === cursor) break
    cursor = next
  }

  const out: string[] = []
  for (const folderPath of ancestors) {
    const folderPrefix = folderPath + '/'
    for (const p of Object.keys(manifest.entries)) {
      if (p === filePath) continue
      const pn = p.replace(/\\/g, '/')
      if (!pn.toLowerCase().endsWith('.sldasm')) continue
      // Direct child of this ancestor folder (not deeper).
      if (!pn.startsWith(folderPrefix)) continue
      const rest = pn.slice(folderPrefix.length)
      if (rest.includes('/')) continue
      if (!out.includes(p)) out.push(p)
    }
  }
  return out
}

export async function saveManifest(manifest: PartsManifest): Promise<void> {
  const filePath = path.join(getProjectPath(), MANIFEST_FILE)
  // Atomic write (temp + rename) so a crash mid-write can't truncate
  // parts.json (which loadManifest now refuses to silently treat as empty).
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n')
  await fs.rename(tmp, filePath)
}

export function classifyFile(filename: string): PartType | null {
  const ext = path.extname(filename).toLowerCase()
  if (!SOLIDWORKS_EXTS.has(ext)) return null
  switch (ext) {
    case '.sldprt': return 'part'
    case '.sldasm': return 'assembly'
    case '.slddrw': return 'drawing'
    default: return null
  }
}

function getScope(relPath: string): string {
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
  return dir
}

/**
 * First path segment of any non-empty relative path, treated as a folder
 * path. Used to scope part numbers to the top-level subsystem folder
 * regardless of how deeply nested a file or sub-folder is.
 *
 * Examples (folder paths):
 *   ''                       -> ''            (root scope)
 *   'Drivetrain'             -> 'Drivetrain'
 *   'Drivetrain/Wheels'      -> 'Drivetrain'
 *   'Drivetrain/Wheels/Hub'  -> 'Drivetrain'
 *
 * For a file path, pass the file's containing folder (getScope) — not
 * the file path itself, otherwise a root-level file would be treated as
 * its own top-level folder.
 */
function topLevelSegment(folderPath: string): string {
  if (!folderPath) return ''
  const idx = folderPath.indexOf('/')
  return idx === -1 ? folderPath : folderPath.slice(0, idx)
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Reserve and return a 2-digit number for a top-level subsystem folder
 * (Drivetrain, Intake, etc.). The number is shared by everything inside
 * that folder, no matter how deep — sub-folders do NOT get their own
 * dash-segment in the part number anymore (which was the v0.7.x bug:
 * `26-2129-01-02-003` instead of `26-2129-01-003`).
 */
function ensureTopLevelFolderNumber(manifest: PartsManifest, topLevel: string): string {
  if (manifest.assemblies[topLevel]) return manifest.assemblies[topLevel]
  const counter = manifest.nextAssemblyCounters[''] || 1
  const num = pad2(counter)
  manifest.nextAssemblyCounters[''] = counter + 1
  manifest.assemblies[topLevel] = num
  return num
}

/**
 * Find the next available 3-digit counter for parts under `topLevel`,
 * scanning existing entries so we never collide with a number that's
 * already been assigned (covers both fresh assignments and entries
 * carried over from the old multi-dash scheme on the same install).
 */
function nextCounterFor(manifest: PartsManifest, topLevel: string, topNumber: string): number {
  let max = (manifest.nextCounters[topLevel] || 1) - 1
  const re = topLevel === ''
    ? new RegExp(`^${escapeRegex(manifest.prefix)}-(\\d{3})$`)
    : new RegExp(`^${escapeRegex(manifest.prefix)}-${escapeRegex(topNumber)}-(\\d{3})$`)
  for (const e of Object.values(manifest.entries)) {
    const m = e.partNumber.match(re)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max + 1
}

function findLinkedPart(
  manifest: PartsManifest,
  drawingPath: string
): { path: string; entry: PartEntry } | null {
  const baseName = path.basename(drawingPath, path.extname(drawingPath))
  const dir = getScope(drawingPath)

  for (const [entryPath, entry] of Object.entries(manifest.entries)) {
    if (entry.type === 'drawing') continue
    const entryBase = path.basename(entryPath, path.extname(entryPath))
    const entryDir = getScope(entryPath)
    if (entryBase === baseName && entryDir === dir) {
      return { path: entryPath, entry }
    }
  }
  return null
}

export function assignPartNumber(manifest: PartsManifest, relPath: string): PartEntry | null {
  if (manifest.entries[relPath]) return manifest.entries[relPath]

  const filename = path.basename(relPath)
  const type = classifyFile(filename)
  if (!type) return null

  // Legacy mode: project pre-dates FrameCAD's numbering scheme. Use the
  // filename (sans extension) as the "part number" so the existing
  // folder structure and file names show up unchanged in the UI. Still
  // store an entry so meta, drawings, and where-used lookups have
  // something to key off.
  if (manifest.legacyMode) {
    const baseName = path.basename(filename, path.extname(filename))
    const entry: PartEntry = {
      partNumber: baseName,
      assignedAt: new Date().toISOString(),
      type
    }
    if (type === 'drawing') {
      // Drawings still pair with the same-named part / assembly via the
      // base-name match — that's how legacy projects keep drawings and
      // models in sync. linkedTo is best-effort.
      const linked = Object.entries(manifest.entries).find(([p, e]) => {
        if (e.type === 'drawing') return false
        return path.basename(p, path.extname(p)) === baseName
      })
      if (linked) entry.linkedTo = linked[0]
    }
    manifest.entries[relPath] = entry
    return entry
  }

  const scope = getScope(relPath)
  const topLevel = topLevelSegment(getScope(relPath))

  if (type === 'drawing') {
    const linked = findLinkedPart(manifest, relPath)
    if (linked) {
      const entry: PartEntry = {
        partNumber: linked.entry.partNumber,
        assignedAt: new Date().toISOString(),
        type: 'drawing',
        linkedTo: linked.path
      }
      manifest.entries[relPath] = entry
      return entry
    }
  }

  let partNumber: string
  if (topLevel === '') {
    // File sits at the project root
    const counter = nextCounterFor(manifest, '', '')
    partNumber = `${manifest.prefix}-${pad3(counter)}`
    manifest.nextCounters[''] = counter + 1
  } else {
    const topNumber = ensureTopLevelFolderNumber(manifest, topLevel)

    // The single "main" assembly directly inside a top-level folder gets
    // the bare `prefix-XX` number (e.g. Drivetrain/drivetrain.sldasm ->
    // 26-2129-01). Every other file under the top-level — including
    // sub-folder assemblies — gets a regular counter-based number.
    if (type === 'assembly' && scope === topLevel) {
      const asmNumber = `${manifest.prefix}-${topNumber}`
      const alreadyUsed = Object.values(manifest.entries).some(
        e => e.type === 'assembly' && e.partNumber === asmNumber
      )
      if (!alreadyUsed) {
        const entry: PartEntry = {
          partNumber: asmNumber,
          assignedAt: new Date().toISOString(),
          type: 'assembly',
          // Auto-numbered locally (this is the sync/scan path, which can't make
          // a server round-trip). Mark provisional so reconcilePartNumbers
          // registers it with the team server on the next online open.
          provisional: true
        }
        manifest.entries[relPath] = entry
        return entry
      }
    }
    const counter = nextCounterFor(manifest, topLevel, topNumber)
    partNumber = `${manifest.prefix}-${topNumber}-${pad3(counter)}`
    manifest.nextCounters[topLevel] = counter + 1
  }

  const entry: PartEntry = {
    partNumber,
    assignedAt: new Date().toISOString(),
    type,
    // Auto-numbered locally — see the bare-assembly branch above. Reconciled
    // (registered, or safely re-labelled on a clash) on the next online open.
    provisional: true
  }
  manifest.entries[relPath] = entry
  return entry
}

async function collectSolidWorksFiles(dirPath: string, relativeTo: string): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      // withFileTypes lets readdir report file-vs-directory directly, so the
      // common case skips the per-entry fs.stat round-trip. Symlinks still need
      // a stat to resolve their target type — matching the original (which
      // stat'd every entry, thereby following symlinks).
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    const subdirs: string[] = []
    for (const entry of entries) {
      const item = entry.name
      if (item.startsWith('.') || item === 'COTS') continue
      const fullPath = path.join(dir, item)
      let isDir = entry.isDirectory()
      let isFileLike = entry.isFile()
      if (entry.isSymbolicLink()) {
        // Resolve the link target the way the previous stat-based walk did.
        const stat = await fs.stat(fullPath).catch(() => null)
        if (!stat) continue
        isDir = stat.isDirectory()
        isFileLike = !isDir
      }
      if (isDir) {
        subdirs.push(fullPath)
      } else if (isFileLike && classifyFile(item)) {
        const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/')
        results.push(relPath)
      }
    }
    for (const sub of subdirs) await walk(sub)
  }

  await walk(dirPath)
  results.sort()
  return results
}

async function handleFileMoves(manifest: PartsManifest, currentPaths: Set<string>): Promise<void> {
  const missing: [string, PartEntry][] = []

  for (const [entryPath, entry] of Object.entries(manifest.entries)) {
    if (!currentPaths.has(entryPath)) {
      missing.push([entryPath, entry])
    }
  }

  // Lazy-import to avoid a circular dep between parts.ts and meta.ts.
  // meta.ts already imports from git.ts which has no parts dependency.
  const meta = await import('./meta')

  for (const [oldPath, entry] of missing) {
    const filename = path.basename(oldPath)
    let found = false

    for (const currentPath of currentPaths) {
      if (path.basename(currentPath) === filename && !manifest.entries[currentPath]) {
        manifest.entries[currentPath] = entry
        delete manifest.entries[oldPath]
        // Drag the parts-meta.json entry along so release state,
        // comments, mass/cost/method/material survive the rename
        // instead of orphaning at the old path key.
        try { await meta.migrateMetaPath(oldPath, currentPath) } catch { /* best effort */ }
        found = true
        break
      }
    }

    if (!found) {
      // File was deleted — leave the tombstone so the number is never
      // reused, but prune the corresponding meta entry. The metadata
      // belonged to the file, not the number.
      try { await meta.pruneMetaPath(oldPath) } catch { /* best effort */ }
    }
  }
}

async function syncManifestImpl(): Promise<PartsManifest> {
  const projectDir = getProjectPath()
  const manifest = await loadManifest()
  const swFiles = await collectSolidWorksFiles(projectDir, projectDir)
  const currentPaths = new Set(swFiles)

  // Imported project (explicit admin flag): the team brought in files that
  // already have part numbers (a previous season, another team, a non-FrameCAD
  // source). Force legacy mode so auto-assign adopts each file by its filename
  // and NEVER imposes the scheme — even when the manifest already has entries
  // (which the first-open auto-detect below would miss). This is the
  // user-declared "don't change my part numbers" switch.
  if (await isImportedProject()) {
    manifest.legacyMode = true
  } else if (manifest.legacyMode === undefined && Object.keys(manifest.entries).length === 0 && swFiles.length > 0) {
    // Legacy-mode auto-detect: this is a first-time open if the manifest
    // has zero entries yet. If there are SolidWorks files on disk anyway,
    // the project pre-dates FrameCAD and the team already has filenames
    // they care about — switch to legacy mode so we don't rename anything.
    // Explicit `legacyMode: false` (toggled by the user later) wins.
    manifest.legacyMode = true
  }

  await handleFileMoves(manifest, currentPaths)

  // Assign assemblies first (folders with .sldasm), then parts, then drawings
  const assemblies = swFiles.filter(f => classifyFile(path.basename(f)) === 'assembly')
  const parts = swFiles.filter(f => classifyFile(path.basename(f)) === 'part')
  const drawings = swFiles.filter(f => classifyFile(path.basename(f)) === 'drawing')

  for (const file of assemblies) assignPartNumber(manifest, file)
  for (const file of parts) assignPartNumber(manifest, file)
  for (const file of drawings) assignPartNumber(manifest, file)

  await saveManifest(manifest)
  return manifest
}

/**
 * Toggle the project's `legacyMode` flag. Flipping the bit doesn't
 * rewrite existing entries — once a part has a number (filename or
 * scheme), it keeps that number forever, because SolidWorks assembly
 * references hash on the filename. Only NEW files added after the
 * flip pick up the other side's behavior. Persists + commits parts.json
 * the same way createNewPart does.
 */
export async function setLegacyMode(enabled: boolean): Promise<void> {
  await pullSharedFile(MANIFEST_FILE)
  const projectDir = getProjectPath()
  const snapshot = await fs.readFile(path.join(projectDir, MANIFEST_FILE), 'utf-8').catch(() => null)
  const manifest = await loadManifest()
  manifest.legacyMode = !!enabled
  await saveManifest(manifest)
  try {
    await pushSharedFile(MANIFEST_FILE, enabled ? 'legacy mode on' : 'legacy mode off')
  } catch (err) {
    if (snapshot !== null) {
      await fs.writeFile(path.join(projectDir, MANIFEST_FILE), snapshot)
    }
    throw err
  }
}

export function syncManifest(): Promise<PartsManifest> {
  const p = manifestLock.then(async () => {
    if (await isCotsProject()) return emptyManifest()
    return syncManifestImpl()
  })
  manifestLock = p.then(() => {}, () => {})
  return p
}

/** The open project's Drive folder id — the key the team server coordinates
 *  part numbers (and locks) under. Read straight from drive-manifest.json (the
 *  same import-free pattern as isCotsProject) to avoid pulling the Electron-
 *  dependent drive layer into this module. Null when there's no Drive project
 *  (e.g. unit tests) → callers fall back to provisional numbers. */
async function projectKey(): Promise<string | null> {
  try {
    const f = path.join(getProjectPath(), '.framecad', 'drive-manifest.json')
    const id = JSON.parse(await fs.readFile(f, 'utf-8')).projectFolderId
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * Reserve a scheme part number via the team server so two clients can't take
 * the same one. The client owns all formatting: `build(counter)` returns the
 * full number + the file path it would own for a given counter. We claim;
 * on a server-reported collision we jump to the next free counter and re-claim;
 * when the server is unreachable (or there's no project) we fall back to the
 * locally-computed number marked `provisional`, to be reconciled later.
 *
 * Returns the final number + path + the counter actually used (so the caller
 * can advance its local nextCounters) + whether it's provisional.
 */
async function claimNumber(
  scope: string,
  initialCounter: number,
  build: (counter: number) => { partNumber: string; filePath: string },
  isTaken?: (partNumber: string) => boolean,
): Promise<{ partNumber: string; filePath: string; counter: number; provisional: boolean }> {
  const key = await projectKey()
  // Advance past any counter whose formatted number is ALREADY used in this
  // project's parts.json. The server registry only knows CLAIMED numbers, so on
  // a team that adopted it mid-season it can hand back a counter that's free in
  // the registry but already taken locally — accepting it would duplicate a
  // number. This guard (used for both the offline fallback and every claim
  // candidate) keeps the result unique locally too.
  let c = initialCounter
  const bump = (n: number): number => {
    let v = n
    while (isTaken && isTaken(build(v).partNumber)) v++
    return v
  }
  c = bump(c)
  if (!key) {
    const b = build(c)
    return { ...b, counter: c, provisional: true }
  }
  const team = await import('./teamServer')
  for (let attempt = 0; attempt < 200; attempt++) {
    const b = build(c)
    try {
      const res = await team.claimPartNumber(key, {
        partNumber: b.partNumber, scope, counter: c, filePath: b.filePath,
      })
      if (res.ok) return { ...b, counter: c, provisional: false }
      // Collision — jump to the server's next free counter (or just bump),
      // then skip past anything already used locally.
      c = bump(typeof res.nextCounter === 'number' && res.nextCounter > c ? res.nextCounter : c + 1)
    } catch {
      // Server unreachable / not enrolled → keep working offline with the
      // current candidate; the reconcile pass finalises it on reconnect.
      const b2 = build(c)
      return { ...b2, counter: c, provisional: true }
    }
  }
  // Pathological (200 consecutive collisions) — fall back to provisional.
  const bf = build(c)
  return { ...bf, counter: c, provisional: true }
}

/**
 * Recover the claim coordinates (server scope + numeric counter + a formatter)
 * from a scheme part number, so a provisional entry can be re-claimed. Returns
 * null for legacy/imported (filename-based) numbers — those are unique by
 * filename and never coordinated through the server.
 */
function deriveClaimCoords(
  manifest: PartsManifest,
  relPath: string,
  partNumber: string,
): { scope: string; counter: number; format: (c: number) => string } | null {
  const prefix = manifest.prefix
  if (!partNumber.startsWith(prefix + '-')) return null
  const rest = partNumber.slice(prefix.length + 1)
  const dir = getScope(relPath)
  let m = rest.match(/^(\d{2})-(\d{3})$/)        // prefix-XX-YYY (scoped part)
  if (m) {
    const xx = m[1]
    const topLevel = topLevelSegment(dir)
    return { scope: `part:${topLevel}`, counter: parseInt(m[2], 10), format: c => `${prefix}-${xx}-${pad3(c)}` }
  }
  m = rest.match(/^(\d{3})$/)                    // prefix-YYY (root part)
  if (m) return { scope: 'part:', counter: parseInt(m[1], 10), format: c => `${prefix}-${pad3(c)}` }
  m = rest.match(/^(\d{2})$/)                    // prefix-XX (bare top-level assembly)
  if (m) return { scope: 'asm:', counter: parseInt(m[1], 10), format: c => `${prefix}-${pad2(c)}` }
  return null
}

/**
 * Finalise part numbers that were assigned while the team server was
 * unreachable (the `provisional` flag). For each, re-claim its number now:
 *  - free → confirmed, the flag is cleared;
 *  - already taken (a teammate grabbed it while we were offline) → reported as
 *    a conflict with a suggested free number. We do NOT auto-rename the file
 *    (renaming a file that's named by its number can break SolidWorks
 *    references) — the user resolves it in SolidWorks and FrameCAD's normal
 *    rename-tracking takes over.
 * No-ops (and makes no network call) when there are no provisional entries.
 */
export function reconcilePartNumbers(): Promise<{
  reconciled: number
  conflicts: Array<{ path: string; current: string; suggested: string }>
}> {
  const p = manifestLock.then(async () => {
    const empty = { reconciled: 0, conflicts: [] as Array<{ path: string; current: string; suggested: string }> }
    const key = await projectKey()
    if (!key) return empty
    let manifest = await loadManifest()
    const localProvisional = Object.entries(manifest.entries).filter(([, e]) => e.provisional)
    if (localProvisional.length === 0) { lastNumberConflicts = []; return empty }
    // Pull the team's latest so we reconcile against current numbers. The pull
    // OVERWRITES local parts.json, so re-attach any provisional entry it drops:
    // an offline-created part lives ONLY in our local copy until reconciled —
    // losing it here would silently discard the user's offline work.
    try {
      await pullSharedFile(MANIFEST_FILE)
      manifest = await loadManifest()
    } catch { /* keep our local copy */ }
    for (const [relPath, entry] of localProvisional) {
      if (!manifest.entries[relPath]) manifest.entries[relPath] = entry
    }

    const team = await import('./teamServer')
    let changed = false
    let reconciled = 0
    const conflicts: Array<{ path: string; current: string; suggested: string }> = []
    for (const [relPath, entry] of Object.entries(manifest.entries)) {
      if (!entry.provisional) continue
      const coords = deriveClaimCoords(manifest, relPath, entry.partNumber)
      if (!coords) { delete entry.provisional; changed = true; continue }
      // A file literally NAMED by its number (a "+ Part" file) can't be
      // renumbered without renaming the file — a ref-break risk — so a clash
      // is surfaced for the user to fix in SolidWorks. A number that's only a
      // metadata LABEL on an arbitrarily-named (auto-numbered) file can be
      // safely re-labelled in place. That distinction drives clash handling.
      const namedByNumber = path.basename(relPath, path.extname(relPath)) === entry.partNumber
      // Skip any counter whose number is already used by ANOTHER local entry —
      // the server registry can lag parts.json (mid-season adoption), so a
      // suggested counter free in the registry may already be taken here.
      const localFree = (n: number): number => {
        let v = n
        while (isNumberTaken(manifest, coords.format(v), relPath)) v++
        return v
      }
      let candidate = entry.partNumber // claim its OWN number first
      let c = coords.counter
      let offline = false
      for (let attempt = 0; attempt < 200; attempt++) {
        let res: { ok: boolean; reassigned: boolean; nextCounter?: number }
        try {
          res = await team.claimPartNumber(key, { partNumber: candidate, scope: coords.scope, counter: c, filePath: relPath })
        } catch {
          offline = true
          break
        }
        if (res.ok) {
          if (candidate !== entry.partNumber) {
            entry.partNumber = candidate // relabelled
            // Drawings that inherited the old number by value follow the relabel.
            for (const e of Object.values(manifest.entries)) {
              if (e.type === 'drawing' && e.linkedTo === relPath) e.partNumber = candidate
            }
          }
          delete entry.provisional
          reconciled++
          changed = true
          break
        }
        // Collision.
        if (namedByNumber) {
          // Can't safely relabel a file named by its number — suggest the next
          // number free both in the registry and locally, for a manual fix.
          conflicts.push({ path: relPath, current: entry.partNumber, suggested: coords.format(localFree(res.nextCounter ?? c + 1)) })
          break // keep provisional until the user resolves it
        }
        c = localFree(typeof res.nextCounter === 'number' && res.nextCounter > c ? res.nextCounter : c + 1)
        candidate = coords.format(c)
      }
      if (offline) break // server went away — stop; we'll reconcile again later
    }
    if (changed) {
      await saveManifest(manifest)
      try { await pushSharedFile(MANIFEST_FILE, 'reconcile part numbers') } catch { /* best effort */ }
    }
    lastNumberConflicts = conflicts
    return { reconciled, conflicts }
  })
  manifestLock = p.then(() => {}, () => {})
  return p
}

/**
 * Move a manifest entry (and its metadata + linked drawings) from one path to
 * another BY IDENTITY — used when the SolidWorks add-in reports a SW-native
 * rename / Save-As. Deterministic, unlike the desktop's basename-guess rename
 * tracking: the add-in tells us exactly which old path became which new path.
 *
 * If `oldRel` still exists on disk it was a Save-As COPY (both files present),
 * not a rename — we leave the old entry alone and let the new file get
 * auto-numbered on the next sync. We only MOVE the entry when the old file is
 * gone. Paths are project-root-relative, POSIX-separated. Returns whether an
 * entry was moved.
 */
export function renameEntry(oldRel: string, newRel: string): Promise<{ moved: boolean }> {
  return withManifestLock(async () => {
    if (!oldRel || !newRel || oldRel === newRel) return { moved: false }
    if (await isCotsProject()) return { moved: false }
    // Save-As copy (old file still on disk) → not a rename; don't move.
    try {
      await fs.access(path.join(getProjectPath(), ...oldRel.split('/')))
      return { moved: false }
    } catch { /* old file is gone → genuine rename, proceed */ }

    await pullSharedFile(MANIFEST_FILE)
    const manifest = await loadManifest()
    const entry = manifest.entries[oldRel]
    if (!entry) return { moved: false }                    // old path wasn't tracked
    if (manifest.entries[newRel]) return { moved: false }  // target already tracked

    manifest.entries[newRel] = entry
    delete manifest.entries[oldRel]
    // Drawings that pointed at the old path follow the rename.
    for (const e of Object.values(manifest.entries)) {
      if (e.linkedTo === oldRel) e.linkedTo = newRel
    }
    const meta = await import('./meta')
    try { await meta.migrateMetaPath(oldRel, newRel) } catch { /* best effort */ }

    await saveManifest(manifest)
    try { await pushSharedFile(MANIFEST_FILE, `rename ${oldRel} → ${newRel}`) } catch { /* best effort */ }
    return { moved: true }
  })
}

export function createNewPart(
  folder: string,
  description?: string
): Promise<{ partNumber: string; filePath: string }> {
  // Serialise against syncManifest / reconcile / the REST add-in path so two
  // concurrent parts.json writers can't clobber each other.
  return withManifestLock(() => createNewPartImpl(folder, description))
}

async function createNewPartImpl(
  folder: string,
  description?: string
): Promise<{ partNumber: string; filePath: string }> {
  if (await isCotsProject()) {
    throw new Error('COTS library projects do not use part numbers')
  }
  // Pull the latest parts.json from the team so we don't reserve a number
  // someone else already took
  await pullSharedFile(MANIFEST_FILE)

  const projectDir = getProjectPath()
  const manifest = await loadManifest()

  // Compute the next number locally, then CLAIM it from the team server so a
  // teammate can't take the same one. `build(c)` formats the number + the file
  // path it would own; claimNumber bumps the counter on a server collision and
  // falls back to a provisional number when offline.
  const topLevel = topLevelSegment(folder)
  let scope: string
  let initialCounter: number
  let build: (c: number) => { partNumber: string; filePath: string }
  if (topLevel === '') {
    scope = 'part:'
    initialCounter = nextCounterFor(manifest, '', '')
    build = c => {
      const pn = `${manifest.prefix}-${pad3(c)}`
      return { partNumber: pn, filePath: folder ? `${folder}/${pn}.sldprt` : `${pn}.sldprt` }
    }
  } else {
    const topNumber = ensureTopLevelFolderNumber(manifest, topLevel)
    scope = `part:${topLevel}`
    initialCounter = nextCounterFor(manifest, topLevel, topNumber)
    build = c => {
      const pn = `${manifest.prefix}-${topNumber}-${pad3(c)}`
      return { partNumber: pn, filePath: `${folder}/${pn}.sldprt` }
    }
  }

  const claimed = await claimNumber(scope, initialCounter, build, pn => isNumberTaken(manifest, pn))
  const partNumber = claimed.partNumber
  const relPath = claimed.filePath
  manifest.nextCounters[topLevel] = claimed.counter + 1
  const fullPath = path.resolve(projectDir, relPath)
  if (!fullPath.startsWith(projectDir + path.sep)) {
    throw new Error('Part path escapes project directory')
  }

  // Ensure parent folder exists so the user can save there from SolidWorks.
  // Do NOT create the .sldprt file — an empty file is not a valid SolidWorks
  // document and the program reports it as corrupt.
  await fs.mkdir(path.dirname(fullPath), { recursive: true })

  manifest.entries[relPath] = {
    partNumber,
    assignedAt: new Date().toISOString(),
    type: 'part',
    description,
    ...(claimed.provisional ? { provisional: true } : {})
  }

  await saveManifest(manifest)
  // A server-confirmed number is propagated to the team immediately. If that
  // push fails — or the number is provisional because we were offline — keep
  // the entry locally and mark it provisional so the reconcile pass re-claims
  // and re-pushes it on reconnect. We DON'T roll back: the number is already
  // claimed server-side (or will be on reconcile), so it's never a silent
  // ghost reservation, and the user gets a usable part either way.
  if (!claimed.provisional) {
    try {
      await pushSharedFile(MANIFEST_FILE, partNumber)
    } catch {
      manifest.entries[relPath].provisional = true
      await saveManifest(manifest)
    }
  }
  return { partNumber, filePath: relPath }
}

export function createNewAssembly(
  parentFolder: string,
  name: string,
  description?: string
): Promise<{ partNumber: string; filePath: string }> {
  return withManifestLock(() => createNewAssemblyImpl(parentFolder, name, description))
}

async function createNewAssemblyImpl(
  parentFolder: string,
  name: string,
  description?: string
): Promise<{ partNumber: string; filePath: string }> {
  if (await isCotsProject()) {
    throw new Error('COTS library projects do not use part numbers')
  }
  // Path-traversal guard (mirrors createSubsystem). parentFolder + name reach
  // here from the renderer AND the localhost REST API (the SolidWorks add-in),
  // and the REST /api/parts/new-assembly route does NOT sanitize them. Reject
  // names with separators/traversal up front, and verify the resolved path
  // stays inside the project below.
  if (!name.trim() || /[\\/:"*?<>|]/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid assembly name')
  }
  await pullSharedFile(MANIFEST_FILE)

  const projectDir = getProjectPath()
  const manifest = await loadManifest()

  const folderPath = parentFolder ? `${parentFolder}/${name}` : name
  const topLevel = topLevelSegment(folderPath)

  // Compute the number locally, then CLAIM it from the team server (bump on a
  // collision, provisional when offline) — see createNewPart.
  let partNumber: string
  let relPath: string
  let provisional = false
  if (parentFolder === '') {
    const existing = manifest.assemblies[folderPath]
    if (existing) {
      // The top-level folder ALREADY has a number (its parts use it) — reuse it
      // verbatim. We must NOT re-claim/bump it: a collision would reassign the
      // folder's XX and desync every part already numbered under it.
      partNumber = `${manifest.prefix}-${existing}`
      relPath = `${folderPath}/${partNumber}.sldasm`
    } else {
      // Brand-new top-level subsystem folder → claim the bare `prefix-XX`
      // number (scope "asm:") so two clients can't both grab the same XX.
      const initialXX = manifest.nextAssemblyCounters[''] || 1
      const claimed = await claimNumber('asm:', initialXX, c => {
        const pn = `${manifest.prefix}-${pad2(c)}`
        return { partNumber: pn, filePath: `${folderPath}/${pn}.sldasm` }
      }, pn => isNumberTaken(manifest, pn))
      partNumber = claimed.partNumber
      relPath = claimed.filePath
      provisional = claimed.provisional
      manifest.assemblies[folderPath] = pad2(claimed.counter)
      manifest.nextAssemblyCounters[''] = Math.max(manifest.nextAssemblyCounters[''] || 1, claimed.counter + 1)
    }
  } else {
    // Nested assembly: shares its top-level folder's number and gets a regular
    // 3-digit counter, same as a part would.
    const topNumber = ensureTopLevelFolderNumber(manifest, topLevel)
    const initialCounter = nextCounterFor(manifest, topLevel, topNumber)
    const claimed = await claimNumber(`part:${topLevel}`, initialCounter, c => {
      const pn = `${manifest.prefix}-${topNumber}-${pad3(c)}`
      return { partNumber: pn, filePath: `${folderPath}/${pn}.sldasm` }
    }, pn => isNumberTaken(manifest, pn))
    partNumber = claimed.partNumber
    relPath = claimed.filePath
    provisional = claimed.provisional
    manifest.nextCounters[topLevel] = claimed.counter + 1
  }

  const fullPath = path.join(projectDir, relPath)
  // Final guard: a `..`-laden parentFolder must not let the assembly escape
  // the project directory.
  if (!fullPath.startsWith(projectDir + path.sep)) {
    throw new Error('Assembly path escapes project directory')
  }

  // Create the assembly folder but not the .sldasm itself (an empty .sldasm
  // is invalid and SolidWorks reports it as corrupt). Drop a .gitkeep so the
  // empty folder is tracked until the user saves the assembly there.
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(path.join(path.dirname(fullPath), '.gitkeep'), '').catch(() => {})

  manifest.entries[relPath] = {
    partNumber,
    assignedAt: new Date().toISOString(),
    type: 'assembly',
    description,
    ...(provisional ? { provisional: true } : {})
  }

  await saveManifest(manifest)
  // See createNewPart: confirmed → push now; provisional/push-failure → keep the
  // entry marked provisional for the reconcile pass. No rollback.
  if (!provisional) {
    try {
      await pushSharedFile(MANIFEST_FILE, partNumber)
    } catch {
      manifest.entries[relPath].provisional = true
      await saveManifest(manifest)
    }
  }
  return { partNumber, filePath: relPath }
}

export async function createSubsystem(
  parentFolder: string,
  name: string
): Promise<{ folderPath: string }> {
  const trimmed = name.trim()
  if (!trimmed || /[\\/:"*?<>|]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid folder name')
  }
  const projectDir = getProjectPath()
  const folderPath = parentFolder ? `${parentFolder}/${trimmed}` : trimmed
  const fullPath = path.join(projectDir, folderPath)
  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    throw new Error('Folder path escapes project directory')
  }
  await fs.mkdir(fullPath, { recursive: true })
  await fs.writeFile(path.join(fullPath, '.gitkeep'), '')
  return { folderPath }
}

/**
 * Walk the file tree and annotate each file entry with its part
 * number + description from the manifest.
 *
 * `gitPrefix` is prepended to each entry.path before looking it up
 * in `manifest.entries` — that's how subpath-relative tree paths
 * (e.g. `Drivetrain/swerve.sldprt`) map back to the git-relative
 * keys the manifest stores (e.g. `2026 Rebuilt/Drivetrain/swerve.sldprt`).
 * Pass an empty string (the default) when no subpath is configured.
 */
export function annotatePartNumbers(entries: FileEntry[], manifest: PartsManifest, gitPrefix = ''): void {
  for (const entry of entries) {
    if (!entry.isDirectory) {
      const key = gitPrefix ? `${gitPrefix}/${entry.path}` : entry.path
      const hit = manifest.entries[key]
      if (hit) {
        entry.partNumber = hit.partNumber
        entry.partDescription = hit.description
      }
    }
    if (entry.children) {
      annotatePartNumbers(entry.children, manifest, gitPrefix)
    }
  }
}

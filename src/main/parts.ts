import path from 'path'
import fs from 'fs/promises'
import type { FileEntry, PartsManifest, PartEntry, PartType } from '@shared/types'
import { getProjectPath, pullPartsJson, pushPartsJson } from './git'
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
  try {
    const filePath = path.join(getProjectPath(), MANIFEST_FILE)
    const data = await fs.readFile(filePath, 'utf-8')
    return ensureYearPrefix(JSON.parse(data))
  } catch {
    return emptyManifest()
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
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2) + '\n')
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

function findLinkedPart(manifest: PartsManifest, drawingPath: string): PartEntry | null {
  const baseName = path.basename(drawingPath, path.extname(drawingPath))
  const dir = getScope(drawingPath)

  for (const [entryPath, entry] of Object.entries(manifest.entries)) {
    if (entry.type === 'drawing') continue
    const entryBase = path.basename(entryPath, path.extname(entryPath))
    const entryDir = getScope(entryPath)
    if (entryBase === baseName && entryDir === dir) {
      return entry
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
        partNumber: linked.partNumber,
        assignedAt: new Date().toISOString(),
        type: 'drawing',
        linkedTo: Object.entries(manifest.entries).find(([, e]) => e === linked)?.[0]
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
          type: 'assembly'
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
    type
  }
  manifest.entries[relPath] = entry
  return entry
}

async function collectSolidWorksFiles(dirPath: string, relativeTo: string): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    let items: string[]
    try {
      items = await fs.readdir(dir)
    } catch {
      return
    }

    for (const item of items) {
      if (item.startsWith('.') || item === 'COTS') continue
      const fullPath = path.join(dir, item)
      const stat = await fs.stat(fullPath).catch(() => null)
      if (!stat) continue

      if (stat.isDirectory()) {
        await walk(fullPath)
      } else if (classifyFile(item)) {
        const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/')
        results.push(relPath)
      }
    }
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

  // Legacy-mode auto-detect: this is a first-time open if the manifest
  // has zero entries yet. If there are SolidWorks files on disk anyway,
  // the project pre-dates FrameCAD and the team already has filenames
  // they care about — switch to legacy mode so we don't rename anything.
  // Explicit `legacyMode: false` (toggled by the user later) wins.
  if (manifest.legacyMode === undefined && Object.keys(manifest.entries).length === 0 && swFiles.length > 0) {
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
  await pullPartsJson()
  const projectDir = getProjectPath()
  const snapshot = await fs.readFile(path.join(projectDir, MANIFEST_FILE), 'utf-8').catch(() => null)
  const manifest = await loadManifest()
  manifest.legacyMode = !!enabled
  await saveManifest(manifest)
  try {
    await pushPartsJson(enabled ? 'legacy mode on' : 'legacy mode off')
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

export async function getPartNumber(relPath: string): Promise<string | null> {
  const manifest = await loadManifest()
  return manifest.entries[relPath]?.partNumber ?? null
}

export async function createNewPart(
  folder: string,
  description?: string
): Promise<{ partNumber: string; filePath: string }> {
  if (await isCotsProject()) {
    throw new Error('COTS library projects do not use part numbers')
  }
  // Pull the latest parts.json from the team so we don't reserve a number
  // someone else already took
  await pullPartsJson()

  const projectDir = getProjectPath()
  const snapshot = await fs.readFile(path.join(projectDir, MANIFEST_FILE), 'utf-8').catch(() => null)
  const manifest = await loadManifest()

  let partNumber: string
  const topLevel = topLevelSegment(folder)
  if (topLevel === '') {
    const counter = nextCounterFor(manifest, '', '')
    partNumber = `${manifest.prefix}-${pad3(counter)}`
    manifest.nextCounters[''] = counter + 1
  } else {
    const topNumber = ensureTopLevelFolderNumber(manifest, topLevel)
    const counter = nextCounterFor(manifest, topLevel, topNumber)
    partNumber = `${manifest.prefix}-${topNumber}-${pad3(counter)}`
    manifest.nextCounters[topLevel] = counter + 1
  }

  const fileName = `${partNumber}.sldprt`
  const relPath = folder ? `${folder}/${fileName}` : fileName
  const fullPath = path.join(projectDir, relPath)

  // Ensure parent folder exists so the user can save there from SolidWorks.
  // Do NOT create the .sldprt file — an empty file is not a valid SolidWorks
  // document and the program reports it as corrupt.
  await fs.mkdir(path.dirname(fullPath), { recursive: true })

  manifest.entries[relPath] = {
    partNumber,
    assignedAt: new Date().toISOString(),
    type: 'part',
    description
  }

  await saveManifest(manifest)
  try {
    await pushPartsJson(partNumber)
  } catch (err) {
    // Push failed — restore the previous manifest so we don't leave a
    // ghost reservation that other team members don't know about
    if (snapshot !== null) {
      await fs.writeFile(path.join(projectDir, MANIFEST_FILE), snapshot)
    }
    throw err
  }
  return { partNumber, filePath: relPath }
}

export async function createNewAssembly(
  parentFolder: string,
  name: string,
  description?: string
): Promise<{ partNumber: string; filePath: string }> {
  if (await isCotsProject()) {
    throw new Error('COTS library projects do not use part numbers')
  }
  await pullPartsJson()

  const projectDir = getProjectPath()
  const snapshot = await fs.readFile(path.join(projectDir, MANIFEST_FILE), 'utf-8').catch(() => null)
  const manifest = await loadManifest()

  const folderPath = parentFolder ? `${parentFolder}/${name}` : name
  const topLevel = topLevelSegment(folderPath)

  let partNumber: string
  if (parentFolder === '') {
    // Creating a brand-new top-level subsystem folder — gets the bare
    // `prefix-XX` assembly number
    const topNumber = ensureTopLevelFolderNumber(manifest, folderPath)
    partNumber = `${manifest.prefix}-${topNumber}`
  } else {
    // Nested assembly: shares its top-level folder's number and gets a
    // regular 3-digit counter, same as a part would
    const topNumber = ensureTopLevelFolderNumber(manifest, topLevel)
    const counter = nextCounterFor(manifest, topLevel, topNumber)
    partNumber = `${manifest.prefix}-${topNumber}-${pad3(counter)}`
    manifest.nextCounters[topLevel] = counter + 1
  }

  const fileName = `${partNumber}.sldasm`
  const relPath = `${folderPath}/${fileName}`
  const fullPath = path.join(projectDir, relPath)

  // Create the assembly folder but not the .sldasm itself (an empty .sldasm
  // is invalid and SolidWorks reports it as corrupt). Drop a .gitkeep so the
  // empty folder is tracked until the user saves the assembly there.
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(path.join(path.dirname(fullPath), '.gitkeep'), '').catch(() => {})

  manifest.entries[relPath] = {
    partNumber,
    assignedAt: new Date().toISOString(),
    type: 'assembly',
    description
  }

  await saveManifest(manifest)
  try {
    await pushPartsJson(partNumber)
  } catch (err) {
    if (snapshot !== null) {
      await fs.writeFile(path.join(projectDir, MANIFEST_FILE), snapshot)
    }
    throw err
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

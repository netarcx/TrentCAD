import http from 'http'
import path from 'path'
import type { BrowserWindow } from 'electron'
import type { FileEntry, ProjectConfig, PartMeta } from '@shared/types'
import * as partsOps from './parts'
import * as driveProject from './drive-project'
import * as teamServer from './teamServer'
import { toGitRel, toProjectRel, getEffectiveProjectRoot, getProjectSubpath } from './paths'
import {
  clearPendingExports,
  completePendingExport,
  findPendingExport,
  listPendingExports,
  markSwSeen
} from './export-queue'

// Lock key for the open Drive project = its Drive folder id (server
// migration v15). Throws if no Drive project is open.
function restDriveKey(): string {
  const key = driveProject.currentConfig()?.driveFolderId
  if (!key) throw new Error('No Drive project open')
  return key
}

// Drive locks shaped like the git LockInfo the add-in expects.
async function restDriveLocks(): Promise<{ path: string; owner: string; id: string }[]> {
  const locks = await teamServer.listDriveLocks(restDriveKey())
  return locks.map(l => ({ path: l.filePath, owner: l.ownerName, id: String(l.ownerMemberId) }))
}

// Stamp lock state onto a Drive file tree (mirrors ipc's getDriveStatusWithLocks).
function applyDriveLocks(
  entries: FileEntry[],
  locks: { path: string; owner: string; id: string }[],
  myId?: number
): void {
  const byPath = new Map(locks.map(l => [l.path, l]))
  const walk = (list: FileEntry[]): void => {
    for (const entry of list) {
      if (!entry.isDirectory) {
        const lock = byPath.get(entry.path)
        if (lock) {
          entry.lockedBy = lock.owner
          entry.state = lock.id === String(myId ?? '') ? 'locked-by-you' : 'locked-by-other'
        }
      }
      if (entry.children) walk(entry.children)
    }
  }
  walk(entries)
}

const DEFAULT_PORT = 42129
const MAX_BODY_SIZE = 1024 * 64 // 64 KB

let server: http.Server | null = null
let currentProject: ProjectConfig | null = null
let activePort: number | null = null
/** Set by setupIpc so the SW add-in can request FrameCAD's main window come to the front. */
let getMainWindowRef: (() => BrowserWindow | null) | null = null

interface PendingCreate {
  id: string
  type: 'part' | 'assembly'
  relativePath: string
  absolutePath: string
  partNumber?: string
}

const pendingCreates: PendingCreate[] = []
let pendingIdCounter = 1

export function queuePendingCreate(
  type: 'part' | 'assembly',
  /** Git-relative path (manifest key). Callers in ipc.ts get this
   *  directly from partsOps. We compute the absolute path from this
   *  before translating to a subpath-relative form for the add-in. */
  relativePath: string,
  partNumber?: string
): void {
  if (!currentProject) return
  // Absolute path = gitRoot/<gitRelPath>. Stays correct regardless
  // of subpath because the input is the canonical git-rel form.
  const absolutePath = path.join(currentProject.path, relativePath)
  // Display path that the SW add-in shows to the user — subpath-rel
  // so it matches what FrameCAD's UI uses, no leading "2026 Rebuilt/" prefix.
  const displayRel = toProjectRel(relativePath) ?? relativePath
  pendingCreates.push({
    id: `pc-${Date.now()}-${pendingIdCounter++}`,
    type,
    relativePath: displayRel,
    absolutePath,
    partNumber
  })
}

let writeLock: Promise<void> = Promise.resolve()

/**
 * Mirror of ipc.ts broadcastStatus — push a fresh getStatus() to the
 * renderer so views (file tree, AdminPage, ManufacturingQueue) pick up
 * meta changes made over REST from the SolidWorks add-in. The chokidar
 * watcher ignores `.framecad/`, so meta writes need an explicit nudge.
 */
function broadcastStatus(): void {
  const win = getMainWindowRef?.()
  if (!win || win.isDestroyed()) return
  const statusFiles = driveProject.status()
  statusFiles
    .then(files => { if (!win.isDestroyed()) win.webContents.send('file-change', files) })
    .catch(() => {})
}

function serialWrite<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    writeLock = writeLock.then(async () => {
      try {
        resolve(await fn())
      } catch (err) {
        reject(err)
      }
    })
  })
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS })
  res.end(JSON.stringify(data))
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Sanitize a `?path=…` query param so callers can't break out of the
 * project directory via `..` segments, absolute paths, or back-slash
 * mixed traversal. The REST API binds to 127.0.0.1 and is only
 * "reached" by the SolidWorks add-in, but the input is still
 * untrusted (anything running on the user's machine could hit it —
 * a CAD macro, another local tool, etc.), so paths are treated like
 * any other untrusted input.
 *
 * Returns the canonicalised, project-relative POSIX-style path, or
 * null if the path is missing/invalid/escapes the project root.
 */
function sanitizeProjectRelPath(input: string | null): string | null {
  if (!input) return null
  // Reject paths that include any absolute-path marker or NUL byte.
  // Normalize and re-check after — path.normalize collapses `.` and
  // `..` but doesn't refuse them.
  if (input.includes('\0')) return null
  if (path.isAbsolute(input)) return null
  // path.normalize uses the OS separator; convert to POSIX style so
  // comparisons and downstream consumers (parts.json keys are stored
  // with forward slashes) work consistently.
  const normalized = path.normalize(input).split(path.sep).join('/')
  // After normalize, a `..` segment that escapes the root remains a
  // leading `..` (e.g. `../etc/passwd` normalizes to `../etc/passwd`).
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') return null
  // Strip any leading `./` for consistency with manifest keys.
  return normalized.replace(/^\.\//, '')
}

function findEntry(entries: FileEntry[], targetPath: string): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === targetPath) return entry
    if (entry.children) {
      const found = findEntry(entry.children, targetPath)
      if (found) return found
    }
  }
  return null
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  // Every incoming REST call comes from the SW add-in (the renderer
  // goes through IPC), so any request is proof of life. The export
  // queue uses this to gate auto-export at release time.
  markSwSeen()

  const route = `${req.method} ${url.pathname}`

  try {
    switch (route) {
      case 'GET /api/health': {
        // Project.path is the EFFECTIVE project root — gitRoot when no
        // subpath is set, gitRoot/<subpath> when one is. This lets the
        // SolidWorks add-in's ToRelativePath/ToAbsolutePath logic keep
        // treating Project.path as "the project root" and naturally
        // produce subpath-relative paths in its REST calls; the REST
        // boundary then translates back to git-relative.
        let projectForClient: ProjectConfig | null = currentProject
        if (currentProject) {
          projectForClient = {
            ...currentProject,
            path: getEffectiveProjectRoot(currentProject.path),
          }
        }
        json(res, 200, {
          running: true,
          project: projectForClient,
          projectSubpath: getProjectSubpath() || undefined,
        })
        return
      }

      case 'GET /api/status': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const files = await driveProject.status()
        try {
          applyDriveLocks(files, await restDriveLocks(), teamServer.currentSnapshot().me?.id)
        } catch { /* offline — local status only */ }
        json(res, 200, files)
        return
      }

      case 'GET /api/file': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const filePath = sanitizeProjectRelPath(url.searchParams.get('path'))
        if (!filePath) {
          json(res, 400, { error: 'Missing or invalid path parameter' })
          return
        }
        // status() returns a tree of subpath-relative paths, so the
        // lookup here uses the subpath-relative path as-is.
        const driveFiles = await driveProject.status()
        const driveEntry = findEntry(driveFiles, filePath)
        if (!driveEntry) { json(res, 404, { error: 'File not found' }); return }
        // Drive sync pulls remote changes wholesale; no cheap per-file probe.
        json(res, 200, { ...driveEntry, newerOnRemote: false })
        return
      }

      case 'GET /api/locks': {
        json(res, 200, await restDriveLocks())
        return
      }

      case 'GET /api/coord-state': {
        // Endpoint name kept (and shape preserved) so the SolidWorks
        // add-in's existing CoordStateDto + role-gating logic keep
        // working without an add-in code change. Backing data source
        // is now the team-server cache rather than the old
        // coordination-repo clone, but the contract is the same.
        try {
          const team = await import('./teamServer')
          const snap = team.currentSnapshot()
          json(res, 200, {
            configured: snap.enrolled,
            role: snap.me?.role ?? null,
            isMember: snap.enrolled,
          })
        } catch {
          json(res, 200, { configured: false, role: null, isMember: false })
        }
        return
      }

      case 'POST /api/checkout': {
        const body = parseJson(await readBody(req)) as { path?: string } | null
        const safePath = sanitizeProjectRelPath(body?.path ?? null)
        if (!safePath) {
          json(res, 400, { error: 'Missing or invalid path in request body' })
          return
        }
        try {
          await serialWrite(() => teamServer.acquireDriveLock(restDriveKey(), safePath))
          json(res, 200, { success: true })
        } catch (err) {
          json(res, 500, { success: false, error: (err as Error).message })
        }
        return
      }

      case 'POST /api/checkin': {
        const body = parseJson(await readBody(req)) as { path?: string } | null
        const safePath = sanitizeProjectRelPath(body?.path ?? null)
        if (!safePath) {
          json(res, 400, { error: 'Missing or invalid path in request body' })
          return
        }
        try {
          await serialWrite(() => teamServer.releaseDriveLock(restDriveKey(), safePath))
          json(res, 200, { success: true })
        } catch (err) {
          json(res, 500, { success: false, error: (err as Error).message })
        }
        return
      }

      case 'POST /api/sync': {
        const driveResult = await serialWrite(() => driveProject.sync())
        json(res, driveResult.success ? 200 : 500, driveResult)
        return
      }

      case 'POST /api/publish': {
        const body = parseJson(await readBody(req)) as { message?: string } | null
        // Drive publish doesn't require a message (the team-server history
        // entry just gets a blank label). Flush any deferred meta commit first
        // (mirrors the IPC publish handler) so a just-made release-state/mass/
        // cost edit ships with this publish instead of on the 60s timer.
        const driveResult = await serialWrite(async () => {
          await (await import('./meta')).flushMetaCommit()
          return driveProject.publish()
        })
        if (driveResult.success && (driveResult.changedPaths?.length ?? 0) > 0) {
          teamServer.recordDrivePublish(restDriveKey(), (body?.message ?? '').trim(), driveResult.changedPaths ?? [])
            .catch(() => { /* best effort */ })
        }
        json(res, driveResult.success ? 200 : 500, driveResult)
        return
      }

      case 'GET /api/parts': {
        const manifest = await partsOps.loadManifest()
        json(res, 200, manifest)
        return
      }

      case 'POST /api/parts/new-part': {
        const body = parseJson(await readBody(req)) as { folder?: string; description?: string } | null
        // Empty folder = project root. Otherwise sanitize: reject
        // absolute paths and any traversal that would escape the
        // project root.
        const rawFolder = body?.folder ?? ''
        const folder = rawFolder === '' ? '' : sanitizeProjectRelPath(rawFolder)
        if (folder === null) {
          json(res, 400, { error: 'Invalid folder path' })
          return
        }
        const result = await serialWrite(() => partsOps.createNewPart(toGitRel(folder), body?.description))
        // Translate the returned file path back to subpath-relative for the
        // add-in (so its ToAbsolutePath() against the subpath-prefixed
        // Project.path lands on the actual file on disk).
        const displayPath = toProjectRel(result.filePath) ?? result.filePath
        json(res, 200, { success: true, ...result, filePath: displayPath })
        return
      }

      case 'POST /api/part-mass-auto': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const body = parseJson(await readBody(req)) as { path?: string; mass?: number } | null
        const safePath = sanitizeProjectRelPath(body?.path ?? null)
        if (!safePath || typeof body?.mass !== 'number') {
          json(res, 400, { error: 'Missing or invalid path, or non-numeric mass' })
          return
        }
        try {
          // Lazy import so rest.ts doesn't pull in meta on load
          const meta = await import('./meta')
          await serialWrite(() => meta.setPartMass(toGitRel(safePath), body.mass!))
          broadcastStatus()
          json(res, 200, { success: true })
        } catch (err) {
          json(res, 500, { success: false, error: (err as Error).message })
        }
        return
      }

      case 'POST /api/focus': {
        // Bring FrameCAD's main window to the foreground. Used by the
        // SW add-in's "Show in FrameCAD" button so the user doesn't
        // have to alt-tab to find it.
        const win = getMainWindowRef?.()
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          json(res, 200, { success: true })
        } else {
          json(res, 503, { success: false, error: 'FrameCAD window unavailable' })
        }
        return
      }

      case 'GET /api/meta': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const url = new URL(req.url || '', 'http://localhost')
        const filePath = sanitizeProjectRelPath(url.searchParams.get('path'))
        if (!filePath) { json(res, 400, { error: 'Missing or invalid path query param' }); return }
        try {
          const meta = await import('./meta')
          const result = await meta.getPartMeta(toGitRel(filePath))
          json(res, 200, result)
        } catch (err) {
          json(res, 500, { error: (err as Error).message })
        }
        return
      }

      case 'POST /api/release-state': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const body = parseJson(await readBody(req)) as { path?: string; state?: string; note?: string } | null
        const safePath = sanitizeProjectRelPath(body?.path ?? null)
        if (!safePath || !body?.state) {
          json(res, 400, { error: 'Missing or invalid path, or missing state' })
          return
        }
        const validStates = ['draft', 'in-review', 'released', 'manufactured']
        if (!validStates.includes(body.state)) {
          json(res, 400, { error: `Invalid state. Expected one of: ${validStates.join(', ')}` })
          return
        }
        try {
          const meta = await import('./meta')
          await serialWrite(() => meta.setReleaseState(
            toGitRel(safePath),
            body.state as 'draft' | 'in-review' | 'released' | 'manufactured',
            body.note
          ))
          broadcastStatus()
          json(res, 200, { success: true })
        } catch (err) {
          json(res, 500, { success: false, error: (err as Error).message })
        }
        return
      }

      case 'GET /api/title-block-data': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const filePath = sanitizeProjectRelPath(url.searchParams.get('path'))
        if (!filePath) { json(res, 400, { error: 'Missing or invalid path' }); return }
        try {
          const parts = await import('./parts')
          const manifest = await parts.loadManifest()
          // Manifest keys are git-relative; translate the incoming
          // subpath-relative path to look up the entry.
          const gitPath = toGitRel(filePath)
          const entry = manifest.entries[gitPath]
          // Drawings link to a part via `linkedTo` and share its number.
          // For mass/material, pull from the LINKED part's metadata if
          // it exists; fall back to the drawing's own meta otherwise.
          // `linkedTo` is stored as git-relative, so no translation needed.
          const linkedPath = entry?.linkedTo || gitPath
          const meta = await import('./meta')
          const linkedMeta = await meta.getPartMeta(linkedPath).catch(() => ({} as Partial<PartMeta>))
          // Designer = the enrolled team member — same identity used as the
          // publish author.
          const identity = { name: teamServer.currentSnapshot().me?.displayName ?? '', email: '' }
          const today = new Date()
          const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
          const massLb = typeof linkedMeta.mass === 'number' ? linkedMeta.mass : null
          json(res, 200, {
            partNumber: entry?.partNumber ?? '',
            description: entry?.description ?? '',
            material: linkedMeta.manufacturingMaterial ?? '',
            mass: massLb !== null ? `${massLb.toFixed(3)} lb` : '',
            designer: identity.name || '',
            date
          })
        } catch (err) {
          json(res, 500, { error: (err as Error).message })
        }
        return
      }

      case 'POST /api/material': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const body = parseJson(await readBody(req)) as { path?: string; material?: string } | null
        const safePath = sanitizeProjectRelPath(body?.path ?? null)
        if (!safePath || typeof body?.material !== 'string') {
          json(res, 400, { error: 'Missing or invalid path, or material' })
          return
        }
        try {
          const meta = await import('./meta')
          await serialWrite(() => meta.setManufacturingMaterial(toGitRel(safePath), body.material!))
          broadcastStatus()
          json(res, 200, { success: true })
        } catch (err) {
          json(res, 500, { success: false, error: (err as Error).message })
        }
        return
      }

      case 'POST /api/manufacturing-method': {
        // SolidWorks add-in sets manufacturing method directly so the
        // designer doesn't have to alt-tab to FrameCAD to make their
        // part show up on the shop-floor queue.
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const body = parseJson(await readBody(req)) as { path?: string; method?: string | null } | null
        const safePath = sanitizeProjectRelPath(body?.path ?? null)
        if (!safePath) { json(res, 400, { error: 'Missing or invalid path' }); return }
        const validMethods = ['print', 'cnc', 'manual', 'other']
        const method = body?.method === null || body?.method === '' ? null : body?.method
        if (method !== null && method !== undefined && !validMethods.includes(method)) {
          json(res, 400, { error: `Invalid method. Expected one of: ${validMethods.join(', ')}, or null to clear` })
          return
        }
        try {
          const meta = await import('./meta')
          await serialWrite(() => meta.setManufacturingMethod(
            toGitRel(safePath),
            method as 'print' | 'cnc' | 'manual' | 'other' | null
          ))
          broadcastStatus()
          json(res, 200, { success: true })
        } catch (err) {
          json(res, 500, { success: false, error: (err as Error).message })
        }
        return
      }

      case 'POST /api/comments': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const body = parseJson(await readBody(req)) as { path?: string; text?: string } | null
        const safePath = sanitizeProjectRelPath(body?.path ?? null)
        if (!safePath || !body?.text || !body.text.trim()) {
          json(res, 400, { error: 'Missing or invalid path, or empty text' })
          return
        }
        try {
          const meta = await import('./meta')
          await serialWrite(() => meta.addComment(toGitRel(safePath), body.text!.trim()))
          broadcastStatus()
          json(res, 200, { success: true })
        } catch (err) {
          json(res, 500, { success: false, error: (err as Error).message })
        }
        return
      }

      case 'POST /api/stage': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const body = parseJson(await readBody(req)) as { path?: string } | null
        const safePath = sanitizeProjectRelPath(body?.path ?? null)
        if (!safePath) { json(res, 400, { error: 'Missing or invalid path' }); return }
        // Drive has no staging index — publish uploads the working tree directly.
        json(res, 200, { success: true })
        return
      }

      case 'GET /api/pending-creates': {
        json(res, 200, pendingCreates)
        return
      }

      case 'POST /api/pending-creates/done': {
        const body = parseJson(await readBody(req)) as { id?: string } | null
        if (!body?.id) {
          json(res, 400, { error: 'Missing id' })
          return
        }
        const idx = pendingCreates.findIndex(p => p.id === body.id)
        if (idx >= 0) pendingCreates.splice(idx, 1)
        json(res, 200, { success: true })
        return
      }

      case 'GET /api/pending-exports': {
        json(res, 200, listPendingExports())
        return
      }

      case 'POST /api/pending-exports/done': {
        if (!currentProject) { json(res, 503, { error: 'No project open' }); return }
        const body = parseJson(await readBody(req)) as { id?: string; error?: string } | null
        if (!body?.id) {
          json(res, 400, { error: 'Missing id' })
          return
        }
        const task = findPendingExport(body.id)
        if (!task) {
          // Already cleared or unknown — idempotent ack.
          json(res, 200, { success: true })
          return
        }
        // If the add-in reported a failure, drop the task without
        // staging anything; the part stays in needs-export status.
        if (body.error) {
          completePendingExport(body.id)
          console.warn(`Export failed for ${task.sourceRelPath} (${task.format}): ${body.error}`)
          broadcastStatus()
          json(res, 200, { success: true })
          return
        }
        // Persist the new export alongside the source — uploads to Drive.
        try {
          const { pushSharedFile } = await import('./persistence')
          await serialWrite(() => pushSharedFile(task.targetRelPath, `[export] ${path.basename(task.targetRelPath)}`))
          completePendingExport(body.id)
          broadcastStatus()
          json(res, 200, { success: true })
        } catch (err) {
          // File didn't actually land — leave the task in the queue so a
          // retry can pick it up.
          json(res, 500, { success: false, error: (err as Error).message })
        }
        return
      }

      case 'POST /api/parts/new-subsystem': {
        const body = parseJson(await readBody(req)) as {
          parentFolder?: string
          name?: string
        } | null
        if (!body?.name) {
          json(res, 400, { error: 'Missing name for subsystem' })
          return
        }
        // parentFolder is subpath-relative from the add-in's perspective;
        // partsOps wants git-relative. Translate in, translate the
        // returned folderPath back out.
        const result = await serialWrite(() =>
          partsOps.createSubsystem(toGitRel(body.parentFolder ?? ''), body.name!)
        )
        const displayFolder = toProjectRel(result.folderPath) ?? result.folderPath
        json(res, 200, { success: true, ...result, folderPath: displayFolder })
        return
      }

      case 'POST /api/parts/new-assembly': {
        const body = parseJson(await readBody(req)) as {
          parentFolder?: string
          name?: string
          description?: string
        } | null
        if (!body?.name) {
          json(res, 400, { error: 'Missing name for assembly' })
          return
        }
        const result = await serialWrite(() =>
          partsOps.createNewAssembly(toGitRel(body.parentFolder ?? ''), body.name!, body.description)
        )
        const displayPath = toProjectRel(result.filePath) ?? result.filePath
        json(res, 200, { success: true, ...result, filePath: displayPath })
        return
      }

      default:
        json(res, 404, { error: 'Not found' })
    }
  } catch (err) {
    if (!res.headersSent) {
      json(res, 500, { error: (err as Error).message })
    }
  }
}

export function startRestServer(project?: ProjectConfig, port?: number): void {
  if (project) currentProject = project

  if (server) return

  activePort = port || Number(process.env.FRAMECAD_API_PORT) || DEFAULT_PORT

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' })
    })
  })

  server.listen(activePort, '127.0.0.1', () => {
    console.log(`FrameCAD REST API running on http://127.0.0.1:${activePort}`)
  })

  server.on('error', (err) => {
    console.error('REST API server error:', err.message)
  })
}

export function setRestProject(project: ProjectConfig): void {
  currentProject = project
  clearPendingExports()
}

export function setRestMainWindow(getter: () => BrowserWindow | null): void {
  getMainWindowRef = getter
}

export function clearRestProject(): void {
  currentProject = null
  clearPendingExports()
}

export function stopRestServer(): void {
  if (server) {
    server.close()
    server = null
    activePort = null
    currentProject = null
  }
}

export function getRestPort(): number | null {
  return activePort
}

/**
 * Stateless wrapper over the Lore VCS SDK (`@lore-vcs/sdk` — a koffi/FFI
 * binding to Epic Games' Lore C library). This is the Lore-backend peer of
 * `drive.ts`: clone / status / stage+commit+push / sync against a local Lore
 * working copy and its remote `lore://` server.
 *
 * It emits the SAME `FileEntry` tree and result shapes the renderer + `useGit`
 * already expect from the Drive backend, so the storage swap is invisible above
 * the IPC boundary. Identity, locks, and publish history stay on the team
 * server (see `project-backend.ts` + `ipc.ts`) — Lore here is purely the
 * byte-pusher that replaces Google Drive.
 *
 * `relPath` values are always project-root-relative, POSIX-separated.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileEntry, FileState, PublishProgress } from '@shared/types'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { lore } from '@lore-vcs/sdk'

// LoreEventTag values pinned to the SDK's enum (v0.8.x). Used as literals so a
// `declare enum` import never has to resolve to a runtime value at build time.
// (see node_modules/@lore-vcs/sdk/dist/types/enums/index.d.ts)
const TAG = {
  ERROR: 1,
  COMPLETE: 2,
  END: 5,
  STATUS_REVISION: 151, // header — carries isLocalAhead
  STATUS_FILE: 152,
  STATUS_SUMMARY: 154,
  SYNC_FILE: 177,
  SYNC_REVISION: 179, // carries flagMerge / flagConflict
  PUSH_FRAGMENT_PROGRESS: 69
} as const

// LoreFileAction: KEEP=0, ADD=1, DELETE=2, MOVE=3, COPY=4
const ACTION = { KEEP: 0, ADD: 1, DELETE: 2, MOVE: 3, COPY: 4 } as const
// LoreNodeType: DIRECTORY=0, FILE=1, LINK=2
const NODE_FILE = 1

// The SDK's event objects, narrowed to what we read. The full union is huge and
// generic; a wrapper only needs the tag + an opaque data bag.
interface LoreEvt {
  tag: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

interface Globals {
  repositoryPath: string
  /** Team member display name → Lore commit author / lock owner. */
  identity?: string
}

const globals = (dir: string, identity?: string): Globals => ({ repositoryPath: dir, identity })

// ── Serialize ALL Lore SDK calls in this process ──────────────────────────
// repositoryStatus({scan:true}) PERSISTS refreshed dirty flags into the staged
// state — it is effectively a WRITE — and it runs on the high-frequency file-
// watcher path. It must never overlap stage/commit/push/sync against the same
// .lore repo. FrameCAD opens one project at a time, so a single FIFO queue is
// sufficient (the Drive backend's equivalent is drive.ts `withManifestLock`).
let opChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  // Chain regardless of the previous op's outcome so one failure doesn't wedge
  // the queue. Callers still see their own op's rejection via `next`.
  const next = opChain.then(fn, fn)
  opChain = next.then(() => undefined, () => undefined)
  return next as Promise<T>
}

/**
 * Run one fluent SDK operation to completion.
 *
 * CRITICAL: the SDK frees an event's `data` payload the moment its callback
 * returns — reading `event.data` after `waitAsync()` throws "Event payload can
 * be decoded only inside the event callback handler". So ALL `.data` access MUST
 * happen inside `onEvent` (the `.tag` number stays valid afterward, `.data`
 * does not). This helper never retains events.
 *
 * Failure surfaces three ways and we honor all of them: `waitAsync()` rejects
 * (hard error), an ERROR event fires (`data.errorInner` is the message), or a
 * COMPLETE event reports a non-zero `status` (soft failure that does NOT reject).
 * The last two used to be ignored, so a failed push could be reported as success.
 */
async function run(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
  onEvent?: (e: LoreEvt) => void
): Promise<void> {
  let errMsg: string | null = null
  let completeStatus: number | null = null
  try {
    await build()
      .callback((e: LoreEvt) => {
        if (e.tag === TAG.ERROR) {
          const m = e.data?.errorInner // LoreErrorEventData = { errorType, errorInner }
          if (m) errMsg = String(m)
        } else if (e.tag === TAG.COMPLETE) {
          const s = e.data?.status // LoreCompleteEventData.status — non-zero = failure
          if (typeof s === 'number') completeStatus = s
        }
        onEvent?.(e)
      })
      .waitAsync()
  } catch (err) {
    // LoreError carries cloned event records ({ tag, tagName, data }) — the text
    // lives in data.errorInner; `.message` is the ctor-joined errorInner.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const le = err as any
    const fromError =
      le?.loreErrors?.[0]?.data?.errorInner ?? le?.message ?? errMsg ?? 'Lore operation failed'
    throw new Error(String(fromError))
  }
  if (errMsg) throw new Error(errMsg)
  if (completeStatus !== null && completeStatus !== 0) {
    throw new Error(`Lore operation reported failure (status ${completeStatus})`)
  }
}

const IGNORED_DIRS = new Set(['.framecad', '.git', '.lore', 'node_modules', 'COTS'])

/**
 * Walk the working tree into the `FileEntry` shape the renderer expects,
 * mirroring drive.ts' private `buildTree`: skip dotfiles, FrameCAD/Lore
 * metadata, COTS, and the root `parts.json` row; default state `synced` and let
 * `stateFor` override for changed files. Lock state is overlaid later (ipc.ts).
 * Pure filesystem read — safe to run unserialized.
 */
async function buildTree(
  dir: string,
  rootDir: string,
  stateFor: (relPath: string) => FileState
): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
    if (entry.isFile() && dir === rootDir && entry.name === 'parts.json') continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(rootDir, full).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      out.push({
        path: rel,
        name: entry.name,
        isDirectory: true,
        state: 'synced',
        children: await buildTree(full, rootDir, stateFor)
      })
    } else if (entry.isFile()) {
      out.push({ path: rel, name: entry.name, isDirectory: false, state: stateFor(rel) })
    }
  }
  return out
}

/**
 * Map a Lore file `action` to a FrameCAD FileState.
 * Lore has no MODIFY action: a changed-in-place file is KEEP + flagDirty.
 * DELETE is handled separately (the file is gone from disk — not a tree row,
 * but publish still needs to know about it).
 */
function fileStateFromEvent(action: number): FileState | null {
  if (action === ACTION.ADD) return 'untracked'
  if (action === ACTION.DELETE) return null
  return 'modified' // KEEP (dirty), MOVE, COPY → an existing tracked file changed
}

interface ScanResult {
  states: Map<string, FileState>
  /** Deleted (on-disk-removed) tracked paths — needed by publish. */
  deleted: string[]
  /** Local branch holds commits not yet on the remote (e.g. a prior push failed). */
  isLocalAhead: boolean
}

/**
 * Scan the working copy once and return per-file change state + deletions + the
 * local-ahead flag. Reads ALL event data inside the callback (payload is freed
 * after). Serialized by callers.
 */
async function scanStatus(dir: string): Promise<ScanResult> {
  const states = new Map<string, FileState>()
  const deleted: string[] = []
  let isLocalAhead = false
  await run(
    () => lore.repositoryStatus({ repositoryPath: dir }, { staged: true, scan: true }),
    e => {
      if (e.tag === TAG.STATUS_REVISION) {
        if (e.data?.isLocalAhead) isLocalAhead = true
        return
      }
      if (e.tag !== TAG.STATUS_FILE || !e.data) return
      if (e.data.type !== undefined && e.data.type !== NODE_FILE) return
      const rel = String(e.data.path).replace(/\\/g, '/')
      const action = Number(e.data.action)
      if (action === ACTION.DELETE) { deleted.push(rel); return }
      const st = fileStateFromEvent(action)
      if (st) states.set(rel, st)
    }
  )
  return { states, deleted, isLocalAhead }
}

/**
 * Build the project file tree with Lore change-state overlaid.
 * On a scan failure we LOG and rethrow rather than silently returning a
 * fully-clean tree (which would show the user's modified work as already
 * synced). The file-watcher path swallows the throw and keeps the prior tree;
 * an initial-load failure surfaces a real error instead of false "all synced".
 */
export async function getStatus(dir: string): Promise<FileEntry[]> {
  let states: Map<string, FileState>
  try {
    states = (await serialize(() => scanStatus(dir))).states
  } catch (err) {
    console.error('[lore] status scan failed:', (err as Error).message)
    throw err
  }
  return buildTree(dir, dir, rel => states.get(rel) ?? 'synced')
}

/** The modified / untracked / deleted paths and whether the branch is ahead. */
export async function listChanges(dir: string): Promise<{
  modified: string[]
  untracked: string[]
  deleted: string[]
  isLocalAhead: boolean
}> {
  const { states, deleted, isLocalAhead } = await serialize(() => scanStatus(dir))
  const modified: string[] = []
  const untracked: string[] = []
  for (const [rel, st] of states) {
    if (st === 'modified') modified.push(rel)
    else if (st === 'untracked') untracked.push(rel)
  }
  return { modified, untracked, deleted, isLocalAhead }
}

/**
 * Clone `url` into `localPath` (whole-file working copy — NOT `--virtual`/
 * `--bare`, so SolidWorks finds real assembly files on disk). Forwards per-file
 * progress, and emits a terminal `error` event so the join modal can't stick at
 * "preparing 0%" on failure.
 */
export async function cloneRepo(
  url: string,
  localPath: string,
  identity: string | undefined,
  onProgress?: (p: PublishProgress) => void
): Promise<void> {
  await fs.mkdir(localPath, { recursive: true })
  onProgress?.({ phase: 'preparing', percent: 0 })
  console.log(`[lore] clone start: ${url} -> ${localPath} (identity=${identity ?? 'none'})`)
  let seen = 0
  try {
    await serialize(() => run(
      () => lore.repositoryClone({ repositoryPath: localPath, identity }, { repositoryUrl: url }),
      e => {
        if (e.tag === TAG.SYNC_FILE) {
          seen++
          onProgress?.({ phase: 'uploading', detail: e.data?.path ? String(e.data.path) : `${seen} files` })
        }
      }
    ))
  } catch (err) {
    console.error('[lore] clone failed:', (err as Error).message)
    onProgress?.({ phase: 'error', error: (err as Error).message })
    throw err
  }
  console.log(`[lore] clone done: ${seen} files`)
  onProgress?.({ phase: 'done', percent: 100 })
}

// ── Raw (unserialized) steps — only called from within a `serialize()` block ──
async function rawStageAll(dir: string, identity?: string): Promise<void> {
  await run(() => lore.fileStage(globals(dir, identity), { paths: ['.'], scan: true }))
}

async function rawCommit(dir: string, identity: string | undefined, message: string): Promise<boolean> {
  try {
    await run(() => lore.revisionCommit(globals(dir, identity), { message: message || 'Publish' }))
    return true
  } catch (err) {
    if (/nothing to commit|no changes|empty commit/i.test((err as Error).message)) return false
    throw err
  }
}

async function rawPush(
  dir: string,
  identity: string | undefined,
  onProgress?: (p: PublishProgress) => void
): Promise<void> {
  try {
    await run(
      () => lore.branchPush(globals(dir, identity), {}),
      e => {
        if (e.tag === TAG.PUSH_FRAGMENT_PROGRESS) {
          const d = e.data // { complete, count, bytesTransferred, bytesTotal }
          if (d && typeof d.bytesTotal === 'number' && d.bytesTotal > 0) {
            onProgress?.({ phase: 'uploading', percent: Math.round((Number(d.bytesTransferred) / d.bytesTotal) * 100) })
          }
        }
      }
    )
  } catch (err) {
    // A push with nothing new is a success for FrameCAD's one-button publish.
    if (/nothing to push|up.?to.?date|already up/i.test((err as Error).message)) return
    throw err
  }
}

/** Stage the whole working tree (used by the shared-metadata push path). */
export async function stageAll(dir: string, identity?: string): Promise<void> {
  await serialize(() => rawStageAll(dir, identity))
}

/**
 * Atomically stage → (validate) → commit → push the working tree as ONE
 * serialized unit, so a watcher status-scan can't interleave between commit and
 * push. Always pushes (even when commit found nothing) to flush any commit
 * stranded by a previous failed push — so committed-but-unpushed changes can't
 * be lost forever.
 *
 * `guard` (if given) runs AFTER staging, against the EXACT staged change set
 * (re-scanned here), and may throw to abort before commit/push. Validating the
 * staged set — not a snapshot taken before publish() did its slow, networked
 * lock check — is what stops a file saved during that window from being
 * committed and pushed with no policy/lock check (the Drive backend does the
 * same via publishChanges' in-lock guard). Returns whether THIS call produced a
 * new commit plus the exact paths that were staged (for history).
 */
export async function publishWorkingTree(
  dir: string,
  identity: string | undefined,
  message: string,
  onProgress?: (p: PublishProgress) => void,
  guard?: (changes: { modified: string[]; untracked: string[]; deleted: string[] }) => Promise<void>
): Promise<{ committed: boolean; changedPaths: string[] }> {
  return serialize(async () => {
    await rawStageAll(dir, identity)
    // Re-scan the staged state so the guard (and the recorded history) reflect
    // exactly what commit will capture, not a pre-flight snapshot.
    const { states, deleted } = await scanStatus(dir)
    const modified: string[] = []
    const untracked: string[] = []
    for (const [rel, st] of states) {
      if (st === 'modified') modified.push(rel)
      else if (st === 'untracked') untracked.push(rel)
    }
    if (guard) await guard({ modified, untracked, deleted })
    const committed = await rawCommit(dir, identity, message)
    await rawPush(dir, identity, onProgress)
    return { committed, changedPaths: [...modified, ...untracked, ...deleted] }
  })
}

/**
 * Pull the latest remote revision into the working copy. `forwardChanges` keeps
 * local edits when fast-forwarding so a checked-out file isn't clobbered. Also
 * reports whether the sync produced a staged merge / conflict (the SYNC_REVISION
 * event's flags) so the caller can refuse to silently leave a conflicted tree.
 */
export async function sync(
  dir: string,
  identity: string | undefined,
  onProgress?: (p: PublishProgress) => void
): Promise<{ filesUpdated: number; conflict: boolean; merged: boolean }> {
  return serialize(async () => {
    let filesUpdated = 0
    let conflict = false
    let merged = false
    onProgress?.({ phase: 'preparing', percent: 0 })
    await run(
      () => lore.revisionSync(globals(dir, identity), { forwardChanges: true }),
      e => {
        if (e.tag === TAG.SYNC_FILE) {
          filesUpdated++
          onProgress?.({ phase: 'uploading', detail: e.data?.path ? String(e.data.path) : undefined })
        } else if (e.tag === TAG.SYNC_REVISION) {
          if (e.data?.flagConflict) conflict = true
          if (e.data?.flagMerge) merged = true
        }
      }
    )
    onProgress?.({ phase: 'done', percent: 100 })
    return { filesUpdated, conflict, merged }
  })
}

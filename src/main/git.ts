import simpleGit, { SimpleGit } from 'simple-git'
import path from 'path'
import os from 'os'
import { createReadStream } from 'fs'
import fs from 'fs/promises'
import type { FileEntry, FileState, HistoryEntry, PartsManifest, PublishProgress, PublishResult, SyncResult } from '@shared/types'
import { GITHUB_AUTH_REQUIRED_SENTINEL, LFS_UNREACHABLE_SENTINEL } from '@shared/types'
import { getLocks, verifyLocks } from './locking'
import { loadManifest, syncManifest, annotatePartNumbers } from './parts'
import { loadAllMeta, annotateMeta } from './meta'
import { getGitHubToken } from './auth'
import { getBuildDefaultPrefix, getBuildDefaultTeamName, getBuildDefaultIssueRepo } from './branding'
import { lookupProjectByRemote, getLfsToken, getPolicies } from './teamServer'

// Large binary or text-based CAD files that go through Git LFS. `-text` keeps
// git from running line-ending conversion on the file; `merge=lfs` uses the
// LFS merge driver which conflicts on any divergent pointer instead of
// attempting a content merge.
const LFS_PATTERNS = [
  // SolidWorks
  '*.sldprt', '*.SLDPRT',
  '*.sldasm', '*.SLDASM',
  '*.slddrw', '*.SLDDRW',
  '*.sldlfp', '*.SLDLFP',
  // CAD interchange
  '*.step', '*.STEP', '*.stp', '*.STP',
  '*.iges', '*.IGES', '*.igs', '*.IGS',
  '*.stl', '*.STL',
  '*.3dxml', '*.3DXML',
  '*.dwg', '*.DWG',
  '*.dxf', '*.DXF',
  '*.obj', '*.OBJ',
  '*.x_t', '*.X_T', '*.x_b', '*.X_B',
  // Documents and images that CAD users tend to commit alongside their parts
  '*.pdf', '*.PDF',
  '*.png', '*.PNG', '*.jpg', '*.JPG', '*.jpeg', '*.JPEG', '*.bmp', '*.BMP',
  // Archives + installers. These DON'T really belong in a CAD repo, but
  // teams regularly Pack-and-Go into a zip or drop a CacheCAD installer
  // alongside their files. Without LFS coverage these silently exceed
  // GitHub's 100 MB per-file hard limit and the whole push gets rejected
  // (pre-receive hook declined). LFS them defensively so a stray drop
  // doesn't nuke a 3+ GB publish.
  '*.zip', '*.ZIP',
  '*.rar', '*.RAR',
  '*.7z', '*.7Z',
  '*.tar', '*.TAR',
  '*.gz', '*.GZ',
  '*.exe', '*.EXE',
  '*.msi', '*.MSI'
]

// Smaller text-format CAD/SolidWorks files that should NEVER be merged
// line-by-line. The `binary` macro expands to `-text -diff -merge` — git
// disables its text merge and surfaces a conflict instead of mangling the
// file's structure.
const NEVER_MERGE_PATTERNS = [
  '*.swstate', '*.SWSTATE',
  '*.swsettings', '*.SWSETTINGS',
  '*.swproj', '*.SWPROJ',
  '*.slddst', '*.SLDDST',
  '*.sldset', '*.SLDSET',
  '*.sldsymb', '*.SLDSYMB',
  '*.scad', '*.SCAD',
  '*.gcode', '*.GCODE'
]

/**
 * Compose the initial README.md for a fresh FrameCAD project. The
 * GitHub repo page is the first thing teammates see, so this should
 * orient a brand-new user without making them read external docs.
 *
 * The `framecad://join?url=<remote>` link opens FrameCAD straight into
 * the Join Project flow with the URL prefilled (see `app.setAsDefault\
 * ProtocolClient('framecad')` in main/index.ts).
 */
function buildProjectReadme(name: string, remote: string): string {
  const cleanRemote = (remote || '').trim()
  const joinHttpsUrl = cleanRemote || '<paste this repo URL>'
  const deepLink = cleanRemote ? `framecad://join?url=${encodeURIComponent(cleanRemote)}` : ''
  const teamName = getBuildDefaultTeamName() || 'an FRC team'
  const issueRepo = getBuildDefaultIssueRepo() || 'netarcx/FrameCAD'

  // shields.io renders a badge image GitHub-side that looks like a
  // button, so the deep link reads as an obvious call-to-action
  // instead of a plain hyperlink. `for-the-badge` is the tall pill
  // style; the message text after the dash is what shows on the
  // right side of the badge. Color matches the app accent.
  const badgeUrl = 'https://img.shields.io/badge/Open%20in-FrameCAD-2563eb?style=for-the-badge'
  const deepLinkBlock = deepLink
    ? `## Quick add to FrameCAD

[![Open in FrameCAD](${badgeUrl})](${deepLink})

Clicking that button from this README opens the FrameCAD desktop app
and jumps straight into the Join Project flow with the URL prefilled.
If nothing happens, you don't have FrameCAD installed yet — download
the latest release from [FrameCAD releases](https://github.com/${issueRepo}/releases)
and try again.

`
    : ''

  return `# ${name}

A FrameCAD project — CAD collaboration for ${teamName}. This repository
stores SolidWorks files via Git LFS and is managed end-to-end by the
FrameCAD desktop app. You shouldn't need to use \`git\` directly.

${deepLinkBlock}## Joining manually

If the quick-add link doesn't work, open FrameCAD and click
**Join Project**, then paste:

\`\`\`
${joinHttpsUrl}
\`\`\`

FrameCAD will clone the repo, install Git LFS hooks, and surface every
part in the browser table.

## How collaboration works

FrameCAD wraps Git LFS with a check-out / check-in lock model so two
people never edit the same SolidWorks file at once.

- **Sync** — pull everyone else's latest work into your copy.
- **Publish** — commit your changes and push them up. Other teammates
  will see them after their next sync.
- **Check Out** — lock a file before editing it. Nobody else can check
  it out while it's yours.
- **Check In** — release the lock and publish your edits in one step.
- **New Part / New Assembly** — create a SolidWorks file pre-numbered
  with the team's part-numbering scheme.

If you've used GrabCAD Workbench before, this is the same mental model.
The Git terminology lives below the surface; the UI never uses it.

## Project metadata

Two files at the project root are managed by FrameCAD and committed to
git so the team shares one source of truth:

- \`parts.json\` — the part-numbering manifest. Tracks the assigned
  number for every part / assembly / drawing, plus the next-counter
  state. Never edit this by hand.
- \`.framecad/parts-meta.json\` — per-part metadata: release state
  (draft / in-review / released / manufactured), manufacturing method
  (3D Print / CNC / Hand / Other), material, mass, cost, comments.
  Edited through the FrameCAD UI; commits are batched so rapid edits
  collapse into one push.

## Settings inside FrameCAD

The **Settings** entry in the sidebar opens the Admin panel after a PIN
prompt. Notable tabs:

- **Settings** — project-level config (main repo URL, part-numbering
  prefix, self-hosted LFS, COTS library, weekly progress tag).
- **Parts Manager** — bulk-edit metadata across many parts in one go;
  tick rows then apply release / method / material to all of them.
- **Approvals** — mentor-only view of parts marked "in-review".
- **Documents** — generate the BOM, manufacturing cut list, and project
  summary as PDF + CSV. Auto-saved into the project tree.
- **Repository Health** — scan for files too large for git, find
  blockers before they break a clone.
- **Tools** — manifest integrity check and LFS filter re-apply.
- **Profile** — set your git name and email (used as the author on
  every commit and check-in).
- **About** — version info. \`Ctrl+Shift+R\` checks for updates manually.

## Need help?

- FrameCAD bugs / requests: [github.com/${issueRepo}/issues](https://github.com/${issueRepo}/issues)
- Project-specific questions: ask the team lead.
`
}

function buildGitAttributes(): string {
  const lines: string[] = ['# Managed by FrameCAD — adds run by openProject if missing.']
  for (const p of LFS_PATTERNS) lines.push(`${p} filter=lfs diff=lfs merge=lfs -text`)
  for (const p of NEVER_MERGE_PATTERNS) lines.push(`${p} binary`)
  return lines.join('\n') + '\n'
}

/**
 * Compose the per-project LFS endpoint URL. Our team server tells us
 * the base (e.g. `http://lfs.school.local:42131`) and we append the
 * fixed `framecad/<projectId>` path that giftless storage uses. Same
 * shape the JWT scopes are issued for, so giftless will accept ops
 * the desktop sends to this URL.
 */
function lfsEndpointForProject(lfsBaseUrl: string, projectId: number): string {
  return `${lfsBaseUrl.replace(/\/+$/, '')}/framecad/${projectId}`
}

/**
 * Write (or refresh) `.lfsconfig` at the project root so git-lfs
 * points at the team's self-hosted server instead of GitHub LFS.
 * Committed: every clone of this repo picks up the same target
 * automatically without each user having to configure it.
 *
 * Idempotent — overwrites in-place every time so the URL stays
 * current even if the operator migrates the LFS server. If the team
 * server doesn't have LFS configured (no lfsUrl in the snapshot),
 * this is a no-op and the project keeps using GitHub LFS via the
 * implicit default.
 */
export async function writeLfsConfig(
  dirPath: string,
  remote: string,
): Promise<{ projectId: number; lfsUrl: string } | null> {
  const cfg = lookupProjectByRemote(remote)
  if (!cfg) return null
  const endpoint = lfsEndpointForProject(cfg.lfsUrl, cfg.projectId)
  const body =
    '# Managed by FrameCAD — routes LFS traffic to the team\'s self-hosted\n' +
    '# Giftless server instead of GitHub LFS. Re-written on project open.\n' +
    '[lfs]\n' +
    `\turl = ${endpoint}\n`
  await fs.writeFile(path.join(dirPath, '.lfsconfig'), body)
  return cfg
}

/**
 * Belt-and-suspenders LFS routing enforcement run BEFORE every push.
 *
 * The previous guard only fired when the *current commit's* staged
 * files were LFS-tracked. That missed a critical case: a repo with
 * LFS objects in PRIOR local commits (cloned before the project was
 * registered, or first imported with LFS pointers already in place).
 * `git push` enumerates LFS objects for every commit it sends, so
 * even a metadata-only commit triggers upload of all the pending
 * LFS pointers, and without correct routing they go to GitHub's
 * metered LFS endpoint — 403 on quota-exhausted teams.
 *
 * Three jobs:
 *   1. Detect how many LFS pointers HEAD wants to upload.
 *   2. If the project is registered: write `.lfsconfig` AND strip
 *      any local `.git/config` `lfs.*url` overrides. git-lfs's
 *      config order is `.lfsconfig` < local config, so a stale
 *      `[lfs] url` baked into `.git/config` by an old clone silently
 *      beats `.lfsconfig`. Stripping the local override makes
 *      `.lfsconfig` authoritative.
 *   3. If not registered AND there are LFS pointers to push: refuse
 *      with a clear "ask admin to register this project" message.
 *      (No pointers → nothing to route → allow the push.)
 *
 * Caller passes the returned `endpoint` to `GIT_LFS_URL` env on the
 * push spawn for one last layer of certainty — even if `.lfsconfig`
 * got corrupted somehow, the env var beats everything.
 */
async function ensureLfsRoutingForPush(
  g: SimpleGit,
  projectDir: string,
  onProgress?: (p: PublishProgress) => void,
): Promise<{
  endpoint: string | null
  lfsObjectsInWorkingTree: number
  refuseReason: string | null
}> {
  const remotes = await g.getRemotes(true)
  const origin = remotes.find(r => r.name === 'origin')
  const remoteUrl = origin?.refs?.fetch ?? origin?.refs?.push ?? ''
  const cfg = remoteUrl ? lookupProjectByRemote(remoteUrl) : null

  // Detect LFS usage three different ways and OR them together. Any
  // single signal triggers the routing path. Previously we relied
  // only on `git lfs ls-files --all`, which silently returns 0 when
  // git-lfs CLI is missing / mis-installed / hits any error — and a
  // 0 result with no error made the helper skip the refuse path
  // entirely, letting LFS pointers slip through to GitHub. The
  // belt-and-suspenders detection means we ALWAYS catch LFS-using
  // repos even when git-lfs is being weird about reporting.
  let lfsObjectsInWorkingTree = 0
  let lfsConfiguredInRepo = false
  try {
    const out = await g.raw(['lfs', 'ls-files', '--all'])
    lfsObjectsInWorkingTree = out.split('\n').filter(l => l.trim().length > 0).length
  } catch { /* lfs not initialised or no pointers yet */ }
  // Signal #2: any committed `.gitattributes` line that routes a
  // file pattern through the lfs filter. This is the ground truth
  // even if the git-lfs CLI is broken or absent. `git show HEAD:.gitattributes`
  // returns the committed copy; we don't trust the worktree copy
  // since it might be a fresh checkout that hasn't been initialized.
  try {
    const ga = await g.raw(['show', 'HEAD:.gitattributes']).catch(() => '')
    if (/filter=lfs/i.test(ga)) lfsConfiguredInRepo = true
  } catch { /* no commits yet or no .gitattributes */ }
  // Belt-and-suspenders: fresh repos with no commits yet (just-
  // created project, pre-first-publish) have no HEAD to `git show`
  // against. Fall back to reading `.gitattributes` from the working
  // tree directly so a createProject flow that wrote LFS patterns
  // but hasn't committed yet is still detected.
  if (!lfsConfiguredInRepo) {
    try {
      const ga = await fs.readFile(path.join(projectDir, '.gitattributes'), 'utf-8')
      if (/filter=lfs/i.test(ga)) lfsConfiguredInRepo = true
    } catch { /* file missing — fine */ }
  }
  // Signal #3: git-lfs's smudge filter. `git lfs install` defaults
  // to the GLOBAL scope on most platforms — Windows installers wire
  // it up there at install time. The Linux/macOS default is also
  // global. So we explicitly check ALL scopes (no `--local` flag);
  // the previous --local-only check missed legitimate LFS-enabled
  // repos on stock Windows boxes where the filter was set globally
  // by the git-lfs installer.
  try {
    const smudge = (await g.raw(['config', '--get', 'filter.lfs.smudge'])).trim()
    if (smudge) lfsConfiguredInRepo = true
  } catch { /* not set */ }
  const repoUsesLfs = lfsObjectsInWorkingTree > 0 || lfsConfiguredInRepo

  if (cfg) {
    const endpoint = lfsEndpointForProject(cfg.lfsUrl, cfg.projectId)
    const lfsConfigPath = path.join(projectDir, '.lfsconfig')
    let lfsConfigOk = false
    try {
      const content = await fs.readFile(lfsConfigPath, 'utf-8')
      if (content.includes(endpoint)) lfsConfigOk = true
    } catch { /* missing */ }
    if (!lfsConfigOk) {
      onProgress?.({
        phase: 'preparing',
        files: [],
        detail: `Routing LFS to ${endpoint}…`,
      })
      await writeLfsConfig(projectDir, remoteUrl)
      try { await g.add(['.lfsconfig']) } catch { /* best-effort */ }
    }
    // SET (not unset) the local `.git/config` `lfs.url` to the
    // correct endpoint. git-lfs reads from local config AFTER
    // `.lfsconfig` per its precedence order — so a local override
    // wins. Previously we tried to STRIP any existing override and
    // let `.lfsconfig` take effect, but that lost the belt-and-
    // suspenders: if anything still wrote to `.git/config` (a
    // legacy `git lfs install` invocation, a forgotten manual edit),
    // it'd silently win. SETTING the value to our correct endpoint
    // means the local-config layer points to the right place no
    // matter how it got populated.
    const setLocal = async (key: string, value: string): Promise<void> => {
      try {
        await g.raw(['config', '--local', key, value])
      } catch (err) {
        console.warn(`[LFS routing] Could not set ${key} in .git/config: ${(err as Error).message}`)
      }
    }
    await setLocal('lfs.url', endpoint)
    // Note: `lfs.pushurl` was set here in an earlier pass as belt-
    // and-suspenders, but git-lfs doesn't recognize that key (only
    // `lfs.url` is honored at this scope). Setting it was dead code
    // that gave false confidence about a separate push override.
    // The per-remote `lfs.<remote>.pushurl` form IS honored — we
    // don't need it because `-c lfs.url=` covers both directions.
    //
    // Strip the legacy per-remote override (`[lfs "<remote>"] url`)
    // at BOTH scopes so an old entry pointing at github.com can't
    // beat our setting. Local is the obvious one; global covers a
    // shared dev box where someone ran `git lfs install --global`
    // pointing at GitHub years ago.
    if (remoteUrl) {
      for (const scope of ['--local', '--global'] as const) {
        try {
          await g.raw(['config', scope, '--unset-all', `lfs.${remoteUrl}.url`])
        } catch { /* not set at this scope — fine */ }
      }
    }
    // VERIFY the resolved endpoint with `git lfs env`. If git-lfs
    // STILL reports a github.com endpoint after all the config
    // setup, we have a routing problem we can't fix from here.
    // Refuse the push loudly rather than letting it 403 against
    // GitHub LFS. The `-c lfs.url=…` arg simulates exactly what
    // the actual push will see, so a passing check here means the
    // push will route correctly.
    //
    // Two regexes because git-lfs 3.4+ sometimes splits the
    // endpoint into push/fetch lines (`Endpoint (push)=...` /
    // `Endpoint (download)=...`) when per-direction overrides are
    // in play. Both must point at our endpoint or we refuse.
    let envOutput = ''
    let lfsEnvFailed = false
    try {
      envOutput = await g.raw(['-c', `lfs.url=${endpoint}`, 'lfs', 'env'])
    } catch {
      lfsEnvFailed = true
    }
    if (lfsEnvFailed) {
      // git-lfs isn't callable. The repo uses LFS (we wouldn't be
      // in this branch otherwise — cfg && we're past detection),
      // so a push without git-lfs would either silently strand
      // pointer files OR upload to GitHub's default endpoint.
      // Refuse rather than allow either failure mode.
      return {
        endpoint,
        lfsObjectsInWorkingTree,
        refuseReason:
          `git-lfs isn't installed on this machine, but this project uses LFS.\n\n` +
          `Install git-lfs from https://git-lfs.com/ and re-run \`git lfs install\`, ` +
          `then try publishing again. The previous behaviour would have silently ` +
          `pushed pointer files to GitHub or skipped routing entirely; the safer ` +
          `default is to stop here.`,
      }
    }
    const endpointLines = envOutput.match(/^Endpoint[^=]*=([^\s]+)/gm) ?? []
    for (const line of endpointLines) {
      const m = line.match(/=([^\s]+)/)
      const resolved = m?.[1] ?? ''
      if (resolved && !resolved.startsWith(endpoint)) {
        return {
          endpoint,
          lfsObjectsInWorkingTree,
          refuseReason:
            `LFS routing verification failed.\n\n` +
            `FrameCAD configured the LFS endpoint as ${endpoint}, but git-lfs ` +
            `resolves \`${line}\` (expected ${endpoint}). Something in your git ` +
            `config or environment is overriding the setting. Run \`git lfs env\` ` +
            `from the project folder to see what's set, or ask your admin to ` +
            `check the project's .git/config.`,
        }
      }
    }
    return { endpoint, lfsObjectsInWorkingTree, refuseReason: null }
  }

  // Project is NOT registered on the team server. Allow the push
  // ONLY if there's no LFS involved at all — every detection signal
  // must be cold. If ANY signal is hot, refuse: we'd rather block a
  // legitimate non-LFS push that triggered a false positive than
  // silently let LFS objects leak to GitHub LFS and blow the team's
  // quota (the failure Trent's team has hit multiple times).
  if (!repoUsesLfs) {
    return { endpoint: null, lfsObjectsInWorkingTree: 0, refuseReason: null }
  }
  return {
    endpoint: null,
    lfsObjectsInWorkingTree,
    refuseReason:
      `This project uses LFS but isn't registered on your team server, so ` +
      `FrameCAD has nowhere safe to send the LFS objects.\n\n` +
      `Detected: ${lfsObjectsInWorkingTree} LFS pointer${lfsObjectsInWorkingTree === 1 ? '' : 's'}` +
      `${lfsConfiguredInRepo ? ' + LFS configured in .gitattributes / filter config' : ''}.\n\n` +
      `FrameCAD never pushes LFS objects to GitHub — they consume GitHub's ` +
      `metered LFS quota and block the whole team when it runs out.\n\n` +
      `Ask your admin to register this project at the team admin UI ` +
      `(Projects → Add), then publish again. If this is a legacy repo with ` +
      `LFS data already on GitHub, the admin should also click "Migrate LFS" ` +
      `on the project row to copy the existing objects to the self-hosted ` +
      `server.`,
  }
}

/**
 * Pattern-match a git error to detect "couldn't reach the remote"
 * — which the client can't actually distinguish from "you're offline"
 * vs "GitHub repo was deleted". Both look the same to git here. So
 * we emit a deliberately ambiguous message: keep working locally,
 * sync later. The authoritative "this repo is actually deleted"
 * verdict comes from the team server's `/api/admin/projects/:id/
 * check-remote` (the server has a stable connection and is the only
 * thing that should declare a repo dead). The desktop reads that
 * server-confirmed status off the team snapshot and surfaces a
 * separate, stronger banner when the project entry says `missing`.
 *
 * Returns null when the error is something else (auth, conflict,
 * etc.) so the caller surfaces the original git message.
 */
export function detectRemoteGoneError(raw: string): string | null {
  const msg = raw.toLowerCase()
  if (
    msg.includes('repository not found') ||                  // GitHub HTTPS 404
    msg.includes('remote: not found') ||                     // ssh-protocol variant
    msg.includes("couldn't find remote ref") ||              // remote ref missing
    msg.includes('could not resolve host') ||                // offline / DNS
    msg.includes('failed to connect') ||                     // offline / firewall
    msg.includes('http 404')                                 // raw libgit/curl
  ) {
    return (
      "Couldn't reach the remote repository — either you're offline or " +
      "the repo isn't available right now. Your local work is safe; sync " +
      "again once you have a stable connection. If this keeps happening, " +
      'check with your admin.'
    )
  }
  return null
}

/**
 * Convenience: refresh LFS auth for the CURRENTLY-OPEN project by
 * reading origin's URL from the local git config. Used by publish/
 * sync where we don't otherwise need the remote string. Safe to
 * call on any project — silently no-ops when the project isn't on
 * the team server's registry or has no origin remote configured.
 */
async function refreshLfsAuthForOpenProject(): Promise<Awaited<ReturnType<typeof refreshLfsAuth>> | null> {
  try {
    const g = getGit()
    const remotes = await g.getRemotes(true)
    const origin = remotes.find(r => r.name === 'origin')
    if (!origin?.refs?.fetch) return null
    return await refreshLfsAuth(getProjectPath(), origin.refs.fetch)
  } catch { return null }
}

/**
 * Refresh the local git config with a freshly-minted LFS auth
 * header. Run this immediately before any git operation that might
 * push/pull LFS objects (publish, sync, joinProject) so the JWT is
 * fresh when git-lfs's pre-push hook fires.
 *
 * The header lives in `.git/config` locally — never in the project
 * tree, never committed. 15-minute TTL means even a leaked
 * `.git/config` value is useless within a class period.
 *
 * Returns the quota info from the mint call so the caller can warn
 * the user before an upload starts if they're already over cap.
 * Null when LFS isn't configured (the operation falls through to
 * GitHub LFS as before).
 */
export async function refreshLfsAuth(
  dirPath: string,
  remote: string,
): Promise<{
  writable: boolean
  used: number
  limit: number | null
  grace?: 'ok' | 'in-grace' | 'expired'
  graceStartedAt?: number | null
} | null> {
  const cfg = lookupProjectByRemote(remote)
  if (!cfg) return null
  const tok = await getLfsToken(cfg.projectId)
  if (!tok) return null
  const endpoint = lfsEndpointForProject(cfg.lfsUrl, cfg.projectId)
  const g = simpleGit(dirPath)
  // The extraheader key needs the URL with the trailing slash —
  // matches what git-lfs's batch endpoint resolves to and ensures
  // git uses the header for every sub-path under our LFS server.
  await g.raw([
    'config', '--local',
    `http.${endpoint}/.extraheader`,
    `Authorization: Bearer ${tok.token}`,
  ])
  return {
    writable: tok.writable,
    used: tok.quota.used,
    limit: tok.quota.limit,
    grace: tok.quota.grace,
    graceStartedAt: tok.quota.graceStartedAt,
  }
}

/**
 * Tail a git-lfs progress file (the path passed to GIT_LFS_PROGRESS)
 * and emit each new line as a structured per-file event.
 *
 * git-lfs writes one line per transfer tick in the format:
 *   <direction> <files-done> <files-total> <bytes-done> <bytes-total> <name>
 *
 * Lines are LF-terminated; the file grows monotonically (no truncation
 * mid-push) so we just remember the byte offset we last read up to
 * and grab everything new each poll. Concurrent transfers (git-lfs
 * runs up to 12 in parallel) interleave their lines — we forward the
 * MOST-RECENT line each tick, which gives the user a "current file"
 * impression in their mental model even though multiple are in flight.
 *
 * Returns a `stop()` cleanup that cancels the watcher; the caller is
 * responsible for `fs.rm`-ing the progress file afterwards.
 */
function tailLfsProgress(
  file: string,
  onLine: (cf: NonNullable<PublishProgress['currentFile']>) => void,
): () => void {
  let offset = 0
  let stopped = false
  // Re-entrancy guard: a slow drain (huge buffer) could otherwise have
  // a second setInterval tick start before the first finished, racing
  // on `offset`. We just no-op the overlapping drain — next tick gets
  // whatever was missed.
  let draining = false

  function drain(): void {
    if (stopped || draining) return
    draining = true
    let buf = ''
    const stream = createReadStream(file, { start: offset, encoding: 'utf-8' })
    stream.on('data', chunk => { buf += chunk })
    stream.on('error', () => {
      // File might not exist yet (race against the writeFile that
      // creates it) or the publish finally just rm'd it. Either is
      // fine — release the guard and try again next tick.
      draining = false
    })
    stream.on('end', () => {
      try {
        if (buf.length === 0) return
        // Advance the offset ONLY up to the last `\n` we saw. Anything
        // after that is a partial line — git-lfs hasn't finished
        // writing it yet — and we want to re-read it next drain.
        const lastNewline = buf.lastIndexOf('\n')
        if (lastNewline === -1) return // nothing complete yet
        const complete = buf.slice(0, lastNewline + 1)
        offset += Buffer.byteLength(complete, 'utf-8')

        // Parse the LAST complete line. git-lfs writes overlapping
        // progress ticks (multiple files in flight at once); the
        // newest line wins in the user's "current file" mental model.
        const lines = complete.split('\n').filter(l => l.length > 0)
        const last = lines[lines.length - 1]
        if (!last) return
        const m = last.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
        if (!m) return
        onLine({
          path: m[6],
          bytesTransferred: Number.parseInt(m[4], 10),
          totalBytes: Number.parseInt(m[5], 10),
        })
      } finally {
        draining = false
      }
    })
  }

  // 200 ms poll is fast enough that the UI feels live without
  // saturating the disk on a fast push.
  const id = setInterval(drain, 200)
  return () => {
    stopped = true
    clearInterval(id)
  }
}

/**
 * Ensure every CAD-related pattern FrameCAD knows about is present in
 * .gitattributes. Adds missing lines without rewriting any custom rules
 * the user added. Returns true if the file was modified.
 */
export async function ensureGitAttributes(): Promise<boolean> {
  const filePath = path.join(getProjectPath(), '.gitattributes')
  let existing = ''
  try { existing = await fs.readFile(filePath, 'utf-8') } catch { /* missing */ }
  const expected = buildGitAttributes()
  const existingLines = new Set(existing.split('\n').map(s => s.trim()))
  const missing: string[] = []
  for (const line of expected.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (!existingLines.has(t)) missing.push(line)
  }
  if (missing.length === 0) return false
  const updated = (existing === '' || existing.endsWith('\n') ? existing : existing + '\n') + missing.join('\n') + '\n'
  await fs.writeFile(filePath, updated)
  return true
}

let git: SimpleGit | null = null
let projectPath: string | null = null

export function getGit(): SimpleGit {
  if (!git) throw new Error('No project is open')
  return git
}

export function getProjectPath(): string {
  if (!projectPath) throw new Error('No project is open')
  return projectPath
}

export async function createProject(name: string, dirPath: string, remote: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
  await addSafeDirectory(dirPath)
  // Pre-trust the parent too: a stale .git from a prior failed attempt
  // there will otherwise trip git's worktree-discovery ownership check
  // before init has a chance to take over.
  await addSafeDirectory(path.dirname(dirPath))
  git = simpleGit(dirPath)
  projectPath = dirPath

  await withDubiousOwnershipRecovery(async () => {
    await git.raw(['config', '--global', 'init.defaultBranch', 'main'])
    await git.init()
    await git.raw(['lfs', 'install', '--local'])
  })
  await applyUploadTunings()

  await fs.writeFile(path.join(dirPath, '.gitattributes'), buildGitAttributes())

  // Point LFS at the team's self-hosted server. When the project
  // isn't on the team server snapshot yet, writeLfsConfig is a
  // no-op and the next publish that involves any LFS-tracked file
  // will be REFUSED (the policy is "never push LFS to GitHub" —
  // see the LFS-routing guard in publish() below). Log the
  // misconfiguration here so the admin sees it at create time.
  const wrote = await writeLfsConfig(dirPath, remote)
  if (!wrote && remote) {
    // eslint-disable-next-line no-console
    console.warn(
      '[createProject] Project not registered on the team server. ' +
      'LFS-tracked files won\'t be publishable until an admin adds this ' +
      'project at the team admin UI (Projects → Add).',
    )
  }

  const gitignore = [
    '~$*',
    '*.swp',
    '*.tmp',
    'Thumbs.db',
    '.DS_Store',
    ''
  ].join('\n')
  await fs.writeFile(path.join(dirPath, '.gitignore'), gitignore)

  // Only seed parts.json on a fresh project — never overwrite an existing
  // manifest, which could destroy a partial reservation list
  const partsPath = path.join(dirPath, 'parts.json')
  const partsExists = await fs.stat(partsPath).then(() => true).catch(() => false)
  if (!partsExists) {
    const yy = new Date().getFullYear().toString().slice(-2)
    const baked = getBuildDefaultPrefix()
    const prefix = baked
      ? (/^\d{2}-/.test(baked) ? baked : `${yy}-${baked}`)
      : `${yy}-TEAM`
    const emptyManifest: PartsManifest = {
      prefix,
      nextCounters: {},
      nextAssemblyCounters: {},
      entries: {},
      assemblies: {}
    }
    await fs.writeFile(partsPath, JSON.stringify(emptyManifest, null, 2) + '\n')
  }

  // Drop a README the first time around so the GitHub repo page has
  // useful onboarding for new teammates — including a one-click
  // `framecad://` link that opens FrameCAD straight into the Join flow.
  const readmePath = path.join(dirPath, 'README.md')
  const readmeExists = await fs.stat(readmePath).then(() => true).catch(() => false)
  if (!readmeExists) {
    await fs.writeFile(readmePath, buildProjectReadme(name, remote))
  }

  await withDubiousOwnershipRecovery(async () => {
    // `.lfsconfig` is only present when the project is on the team
    // server's registry (otherwise writeLfsConfig was a no-op above).
    // git.add tolerates missing paths via the spread + a precheck —
    // simpler than testing fs.stat here.
    const initialFiles = ['.gitattributes', '.gitignore', 'parts.json', 'README.md']
    try {
      await fs.stat(path.join(dirPath, '.lfsconfig'))
      initialFiles.push('.lfsconfig')
    } catch { /* not present, skip */ }
    await git.add(initialFiles)
    // Commit may throw "nothing to commit" if create-project is re-run on an
    // already-initialised repo — treat that as success
    try {
      await git.commit('Initialize FrameCAD project')
    } catch { /* nothing to commit */ }

    if (remote) {
      // Idempotent: add origin if missing, update its URL if it already
      // exists with a different value. Without this, retrying create-project
      // fails with "remote origin already exists".
      const remotes = await git.getRemotes(true)
      const origin = remotes.find(r => r.name === 'origin')
      if (!origin) {
        await git.addRemote('origin', remote)
      } else if (origin.refs.push !== remote && origin.refs.fetch !== remote) {
        await git.remote(['set-url', 'origin', remote])
      }
      // If this project is on the team server's registry, refresh
      // the LFS auth header before the initial push so git-lfs's
      // pre-push hook talks to the self-hosted server with a valid
      // bearer token. No-op when LFS isn't configured — git-lfs then
      // falls through to GitHub LFS as before.
      await refreshLfsAuth(dirPath, remote).catch(() => null)
      await git.push(['--set-upstream', 'origin', 'main'])
    }
  })
}

/**
 * Pattern-match a clone error to detect the "LFS server unreachable"
 * shape that smudges throw when GitHub LFS is over-budget or the
 * self-hosted server is down. Returns true when the user's likely
 * next step is "retry without downloading the LFS objects" rather
 * than "fix your network" or "re-auth".
 */
function isLfsUnreachableError(raw: string): boolean {
  const msg = raw.toLowerCase()
  return (
    msg.includes('exceeded its lfs budget') ||
    msg.includes('this repository exceeded') ||
    msg.includes('smudge filter lfs failed') ||
    (msg.includes('error downloading object') && msg.includes('batch response')) ||
    msg.includes('lfs/objects/batch') && msg.includes('403')
  )
}

/** Sentinel the IPC layer / renderer match on to surface the
 *  "retry without LFS" UI instead of the generic error path.
 *  Re-exported from `@shared/types` so the renderer and main
 *  process can't drift on the prefix string. */
export const LFS_UNREACHABLE_ERROR_PREFIX = LFS_UNREACHABLE_SENTINEL

/**
 * Detect git errors that mean "this is a private repo and we don't
 * have credentials" or "credentials we have are wrong". Surfaced to
 * the renderer so it can prompt the user to sign in via GitHub
 * instead of showing the raw git error message — which usually says
 * "repository not found" for the private-without-auth case, leading
 * users to think the repo doesn't exist.
 */
function isGitAuthError(raw: string): boolean {
  const msg = raw.toLowerCase()
  return (
    msg.includes('authentication failed') ||
    msg.includes('could not read username') ||
    msg.includes('could not read password') ||
    msg.includes('permission denied') ||
    // GitHub returns "repository not found" for private repos that
    // the requester can't access. Strict-match on the github.com URL
    // so we don't false-positive on a typo'd public repo URL.
    (msg.includes('repository') && msg.includes('not found') && msg.includes('github.com'))
  )
}

export interface JoinProjectOptions {
  /** When true, set GIT_LFS_SKIP_SMUDGE=1 on the clone so git-lfs
   *  doesn't try to fetch object contents. Result: a working tree
   *  where binary files appear as small pointer text files. The
   *  user gets the project structure + history immediately and can
   *  `git lfs pull` later once their team's LFS server is reachable. */
  skipSmudge?: boolean
}

export async function joinProject(
  url: string,
  dirPath: string,
  onProgress?: (p: PublishProgress) => void,
  options?: JoinProjectOptions,
): Promise<void> {
  await addSafeDirectory(dirPath)
  await addSafeDirectory(path.dirname(dirPath))
  onProgress?.({
    phase: 'preparing',
    files: [],
    detail: options?.skipSmudge
      ? 'Starting clone (LFS skipped)…'
      : 'Starting clone…',
  })

  // Mirror the publish() tail setup so a clone's LFS smudge phase
  // also surfaces per-file bytes to the renderer. Created/cleaned
  // around the whole clone so we don't lose any of the smudge events.
  const lfsProgressFile = path.join(
    os.tmpdir(),
    `framecad-lfs-progress-${Date.now()}-${process.pid}-join.log`,
  )
  let stopLfsTail: (() => void) | null = null
  try { await fs.writeFile(lfsProgressFile, '') } catch { /* ignore */ }
  stopLfsTail = tailLfsProgress(lfsProgressFile, cf => {
    onProgress?.({ phase: 'uploading', currentFile: cf })
  })

  try {
    await runJoinClone(url, dirPath, onProgress, lfsProgressFile, options?.skipSmudge)
    onProgress?.({ phase: 'done', files: [], percent: 100, detail: 'Project ready' })
  } catch (err) {
    // Without this, the renderer's progress modal sits in "Downloading"
    // forever when a clone fails (auth, network, etc.) — the caller's
    // outer catch returns an error but the modal doesn't know.
    const errMsg = (err as Error).message
    // Recognise the LFS-budget / smudge-failure shape and tag the
    // error so the renderer can offer a "retry without LFS" path.
    // skipSmudge runs don't fire this — if we get here while already
    // skipping LFS, the failure is something else (auth, network).
    if (!options?.skipSmudge && isLfsUnreachableError(errMsg)) {
      const friendly =
        'Your team\'s LFS server is unreachable. The git history downloaded fine, ' +
        'but git-lfs couldn\'t fetch the actual binary file contents — usually because ' +
        'GitHub LFS is over its monthly budget or the self-hosted LFS server is offline. ' +
        'Your local files were rolled back. Try again with "Clone without LFS files" to ' +
        'get the project structure now; you can `git lfs pull` once your admin has ' +
        'migrated the data.'
      onProgress?.({
        phase: 'error',
        error: friendly,
      })
      throw new Error(`${LFS_UNREACHABLE_ERROR_PREFIX} ${friendly}`)
    }
    if (isGitAuthError(errMsg)) {
      // Most likely cause is a private repo without GitHub credentials
      // on this machine. Tag with the sentinel so the renderer can
      // show a "Sign in with GitHub" prompt instead of the raw git
      // error (which says "repository not found" for private-no-auth
      // and confuses users into thinking the repo is missing).
      const friendly =
        'This looks like a private GitHub repo and FrameCAD doesn\'t have credentials ' +
        'to access it on this machine. Sign in with GitHub first ' +
        '(`gh auth login` or the desktop\'s Sync with Team flow handles it) and try again.'
      onProgress?.({ phase: 'error', error: friendly })
      throw new Error(`${GITHUB_AUTH_REQUIRED_SENTINEL} ${friendly}`)
    }
    onProgress?.({ phase: 'error', error: errMsg })
    throw err
  } finally {
    stopLfsTail?.()
    await fs.rm(lfsProgressFile, { force: true }).catch(() => null)
  }
}

async function runJoinClone(
  url: string,
  dirPath: string,
  onProgress?: (p: PublishProgress) => void,
  lfsProgressFile?: string,
  skipSmudge?: boolean,
): Promise<void> {
  await withDubiousOwnershipRecovery(async () => {
    // simple-git surfaces git's --progress lines through this callback
    // (counting/compressing/receiving objects). For LFS-heavy CAD
    // repos the LFS smudge happens after clone completes; we parse
    // those lines from stderr separately.
    const cloneGit = simpleGit({
      progress: ({ method, stage, progress }) => {
        if (!onProgress) return
        if (method === 'clone') {
          onProgress({
            phase: 'uploading',
            files: [],
            percent: typeof progress === 'number' ? progress : undefined,
            detail: stage ? `Cloning: ${stage}` : 'Cloning…'
          })
        }
      }
    })
    cloneGit.env('GIT_CLONE_PROTECTION_ACTIVE', 'false')
    if (lfsProgressFile) {
      // Hook git-lfs's progress file so the tail watcher in
      // joinProject() can surface per-file smudge bytes to the UI.
      cloneGit.env('GIT_LFS_PROGRESS', lfsProgressFile)
    }
    if (skipSmudge) {
      // Tell git-lfs not to download / replace pointer files with
      // actual content during the clone. The working tree gets the
      // pointer text files (each is ~130 bytes); the user can run
      // `git lfs pull` later once their LFS server is reachable.
      cloneGit.env('GIT_LFS_SKIP_SMUDGE', '1')
    }

    // Inject the GitHub token directly into the clone URL. Packaged
    // Linux builds launched from a .desktop file can't reliably reach
    // the system keyring, so the gh credential helper fails and git
    // tries to prompt on /dev/tty which doesn't exist. Embedding the
    // token in the URL bypasses credentials entirely. After the clone
    // succeeds we reset the remote URL so the token doesn't persist
    // in .git/config.
    let cloneUrl = url
    let tokenUsed = false
    if (/^https:\/\/github\.com\//i.test(url)) {
      const token = await getGitHubToken()
      if (token) {
        cloneUrl = url.replace(
          /^https:\/\/github\.com\//i,
          `https://x-access-token:${token}@github.com/`
        )
        tokenUsed = true
      }
    }

    cloneGit.outputHandler((_bin, _stdout, stderr) => {
      stderr.on('data', (chunk: Buffer) => {
        if (!onProgress) return
        const text = chunk.toString()
        // Git LFS download — lines look like:
        // "Downloading LFS objects: 50% (1/2), 12.3 MB | 4.5 MB/s"
        const lfs = text.match(
          /Downloading LFS objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s+([\d.]+\s*\w+))?(?:\s*\|\s*([\d.]+\s*\w+\/s))?/
        )
        if (lfs) {
          const [, pct, done, total, transferred, speed] = lfs
          const parts = [`${done} of ${total} files`]
          if (transferred) parts.push(transferred.trim())
          if (speed) parts.push(`${speed.trim()}`)
          onProgress({
            phase: 'uploading',
            files: [],
            percent: parseInt(pct, 10),
            detail: `Downloading LFS — ${parts.join(' · ')}`
          })
          return
        }
        // After download, git-lfs writes files to the working tree:
        // "Filtering content: 50% (1/2), 12.3 MB | 4.5 MB/s"
        const filter = text.match(
          /Filtering content:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s+([\d.]+\s*\w+))?(?:\s*\|\s*([\d.]+\s*\w+\/s))?/
        )
        if (filter) {
          const [, pct, done, total, , speed] = filter
          const parts = [`${done} of ${total} files`]
          if (speed) parts.push(speed.trim())
          onProgress({
            phase: 'uploading',
            files: [],
            percent: parseInt(pct, 10),
            detail: `Extracting CAD files — ${parts.join(' · ')}`
          })
        }
      })
    })

    // Inject our upload tunings into the clone itself via `--config` so
    // the LFS smudge phase — which dominates wall-clock time for any
    // real CAD repo — uses 12 parallel transfers and the bigger HTTP
    // buffer / timeouts from the FIRST object download, not git's
    // defaults. `applyUploadTunings()` after the clone would write the
    // same config too late: the smudge has already run.
    //
    // `--single-branch --no-tags` skips fetching every dev branch and
    // every release tag, which cuts the git-side of the clone for repos
    // with active history. We undo the narrowed refspec right after so
    // future syncs still see teammates' new branches.
    // Mint an LFS JWT BEFORE the clone if this project's on the
    // team registry — git-lfs's smudge filter fires during clone and
    // needs auth to fetch the actual binaries. We inject the auth
    // header via `--config` so it lands in the new clone's local
    // config; subsequent operations (sync/publish) refresh it again
    // via refreshLfsAuth(). No-op fall-through when the project
    // isn't registered (it just uses GitHub LFS like before).
    const lfsConfigForClone: string[] = []
    const lfsCfg = lookupProjectByRemote(url)
    if (lfsCfg) {
      const tok = await getLfsToken(lfsCfg.projectId).catch(() => null)
      if (tok) {
        const endpoint = lfsEndpointForProject(lfsCfg.lfsUrl, lfsCfg.projectId)
        lfsConfigForClone.push(
          '--config',
          `http.${endpoint}/.extraheader=Authorization: Bearer ${tok.token}`,
        )
      }
    }

    await cloneGit.clone(cloneUrl, dirPath, [
      '--single-branch',
      '--no-tags',
      '--config', 'lfs.concurrenttransfers=12',
      '--config', 'http.postBuffer=524288000',
      '--config', 'lfs.activitytimeout=600',
      '--config', 'lfs.dialtimeout=30',
      ...lfsConfigForClone,
    ])
    git = simpleGit(dirPath)
    projectPath = dirPath
    // `--single-branch` writes a narrowed `remote.origin.fetch` that
    // only pulls the cloned branch. Reset it to the default wildcard
    // so future syncs discover new branches normally.
    await git.raw([
      'config', '--local',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*'
    ]).catch(() => {})
    if (tokenUsed) {
      // Reset the stored remote URL so the token isn't persisted
      // in .git/config. Future push/pull will get credentials via
      // GIT_ASKPASS (set by cacheGhToken in auth.ts) instead.
      await git.remote(['set-url', 'origin', url])
    }
  })
  // applyUploadTunings is still useful as a no-op safety net (and to
  // persist the values if the --config form ever stops working in a
  // future git version) — it just no-ops on already-set values
  await applyUploadTunings()

  // Ensure .lfsconfig exists pointing at the team's self-hosted LFS
  // server. Three scenarios:
  //   - Repo was created by FrameCAD recently → .lfsconfig already
  //     committed, our write is a no-op overwrite with the same value
  //   - Repo was created before LFS support → no .lfsconfig in clone,
  //     we write a fresh one (uncommitted; the user's next publish
  //     picks it up and ships it to the team)
  //   - The project isn't on the team-server registry → no-op
  // Either way, LFS routing for THIS clone now points at the team's
  // server starting immediately; everyone else picks it up on sync
  // once a commit including .lfsconfig lands on origin.
  await writeLfsConfig(dirPath, url).catch(() => null)
}

/**
 * Apply the upload-tuning git config to the current repo. These are
 * cheap one-time writes to .git/config that survive across pulls and
 * pushes; running every open is fine and idempotent.
 *
 * - lfs.concurrenttransfers 12 — git's default is 8; bumping to 12 helps
 *   multi-file CAD publishes saturate the connection. Higher than ~16
 *   tends to choke residential up-links.
 * - http.postBuffer 500 MB — large CAD pushes occasionally trip git's
 *   default ~1 MB stream buffer and fail mid-push with HTTP 500. The
 *   buffer only allocates as needed; it doesn't waste 500 MB up front.
 * - lfs.activitytimeout 600 — give a slow chunk 10 minutes before
 *   declaring the upload dead, instead of the default 30s.
 * - lfs.dialtimeout 30 — wait 30s for the initial TLS handshake to
 *   github-lfs.s3 instead of failing fast on a slow link.
 */
async function applyUploadTunings(): Promise<void> {
  const g = getGit()
  await Promise.all([
    g.raw(['config', '--local', 'lfs.concurrenttransfers', '12']).catch(() => {}),
    g.raw(['config', '--local', 'http.postBuffer', '524288000']).catch(() => {}),
    g.raw(['config', '--local', 'lfs.activitytimeout', '600']).catch(() => {}),
    g.raw(['config', '--local', 'lfs.dialtimeout', '30']).catch(() => {})
  ])
}

async function addSafeDirectory(dirPath: string): Promise<void> {
  const normalized = dirPath.replace(/\\/g, '/')
  try {
    const g = simpleGit()
    await g.raw(['config', '--global', '--get-all', 'safe.directory']).then(result => {
      const dirs = result.trim().split('\n')
      if (dirs.includes(normalized) || dirs.includes('*')) return
      return g.raw(['config', '--global', '--add', 'safe.directory', normalized])
    })
  } catch {
    const g = simpleGit()
    await g.raw(['config', '--global', '--add', 'safe.directory', normalized])
  }
}

/**
 * Run a git operation; if it fails with "dubious ownership in repository
 * at 'PATH'", auto-add that exact PATH to safe.directory and retry once.
 * Network drives (FRC team shared volumes like G:\) don't record POSIX
 * ownership, so git refuses operations whenever it walks up and finds a
 * .git the current user doesn't appear to own. Pre-registering only the
 * target dir doesn't help when git's worktree-discovery hits a parent
 * with a stale .git from a prior attempt — so we recover by parsing the
 * actual path out of git's complaint.
 */
async function withDubiousOwnershipRecovery<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = (err as Error).message || ''
    const m = msg.match(/detected dubious ownership in repository at ['"]?([^'"\n]+?)['"]?\s*(?:$|\n)/)
    if (!m) throw err
    const dubious = m[1].replace(/\\/g, '/')
    const g = simpleGit()
    await g.raw(['config', '--global', '--add', 'safe.directory', dubious])
    return fn()
  }
}

/**
 * Move a project's metadata directory from the legacy name `.trentcad`
 * to `.framecad`. Runs once per project on first open with the renamed
 * client. Skips if the new dir already exists (already migrated, or
 * fresh project). The rename shows up as a working-tree change that the
 * user publishes via the normal sync/publish flow.
 */
async function migrateLegacyMetaDir(dirPath: string): Promise<void> {
  const oldDir = path.join(dirPath, '.trentcad')
  const newDir = path.join(dirPath, '.framecad')
  try {
    await fs.access(newDir)
    return
  } catch { /* new dir absent, continue */ }
  try {
    await fs.access(oldDir)
  } catch {
    return
  }
  // Try fs.rename first — atomic on the same filesystem, no data
  // duplication. If that fails (e.g. cross-volume EXDEV, or partial
  // rename on a permissions error), fall back to copy + delete so a
  // broken intermediate state can self-heal on next open.
  try {
    await fs.rename(oldDir, newDir)
    return
  } catch (renameErr) {
    console.warn(`[migrateLegacyMetaDir] fs.rename ${oldDir} → ${newDir} failed: ${(renameErr as Error).message}. Falling back to cp+rm.`)
  }
  try {
    await fs.cp(oldDir, newDir, { recursive: true, errorOnExist: false, force: true })
    await fs.rm(oldDir, { recursive: true, force: true })
  } catch (fallbackErr) {
    // Both rename and cp+rm failed. Leave both directories in place
    // so the user can manually resolve; meta.ts will read from
    // .framecad (now empty) and the project will operate without
    // historical metadata until someone fixes permissions.
    console.error(`[migrateLegacyMetaDir] cp+rm fallback also failed: ${(fallbackErr as Error).message}. Project will open without legacy metadata.`)
  }
}

export async function openProject(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath)
  } catch {
    throw new Error(`Project folder not found: ${dirPath}`)
  }
  await addSafeDirectory(dirPath)
  await addSafeDirectory(path.dirname(dirPath))
  await migrateLegacyMetaDir(dirPath)
  await withDubiousOwnershipRecovery(async () => {
    git = simpleGit(dirPath)
    projectPath = dirPath

    const isRepo = await git.checkIsRepo()
    if (!isRepo) throw new Error('Not a Git repository')

    // Auto-add any new CAD patterns introduced by a newer FrameCAD version
    // so files added today never get the default text-merge treatment
    await ensureGitAttributes().catch(() => { /* best-effort */ })
  })
  await applyUploadTunings()

  // Best-effort background fetch so the SW add-in's "newer version
  // available" check reflects up-to-date remote state on subsequent
  // document switches. We don't await this — if it fails (offline,
  // auth issue, etc.) the rest of the open shouldn't suffer.
  if (git) {
    git.fetch(['origin']).catch(() => { /* offline / no remote */ })
  }
}

/**
 * Is there a commit on origin/<currentBranch> that modified relPath but
 * hasn't been pulled into HEAD yet? Used by the SW add-in's task pane
 * to show a "newer version available" prompt when the user opens a
 * stale local file.
 *
 * Returns false on any error (no remote, no branch tracking, file
 * never touched, etc.) so the add-in's check degrades silently rather
 * than throwing in the user's face.
 */
export async function isFileNewerOnRemote(relPath: string): Promise<boolean> {
  if (!relPath || !git) return false
  try {
    const branchSummary = await git.branchLocal()
    const branch = branchSummary.current || 'main'
    const remoteRef = `origin/${branch}`
    // Verify remote ref exists first — if no upstream, rev-list errors
    await git.raw(['rev-parse', '--verify', remoteRef])
    const commits = await git.raw(['rev-list', `HEAD..${remoteRef}`, '--', relPath])
    return commits.trim().length > 0
  } catch {
    return false
  }
}

/**
 * How many commits exist on origin/<branch> that aren't in our local
 * HEAD. Returns 0 on any failure (offline, no remote, no upstream
 * tracking, auth not yet wired) so the UI just shows the no-updates
 * state instead of an error. Fetches before counting so the answer
 * reflects what GitHub actually has.
 */
export async function getRemoteAhead(): Promise<number> {
  if (!git) return 0
  try {
    const remotes = await git.getRemotes(false)
    if (remotes.length === 0) return 0
    await git.fetch(['origin'])
    const branchSummary = await git.branchLocal()
    const branch = branchSummary.current || 'main'
    const remoteRef = `origin/${branch}`
    await git.raw(['rev-parse', '--verify', remoteRef])
    const out = (await git.raw(['rev-list', '--count', `HEAD..${remoteRef}`])).trim()
    const n = parseInt(out, 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * Count commits the LOCAL branch is ahead of origin/<branch> — i.e.
 * how many commits the user has committed but not yet `git push`ed.
 * Mirror of `getRemoteAhead`, used by the desktop UI to render a
 * "you have unpublished changes" badge on the Publish button.
 *
 * Deliberately does NOT fetch origin — keeps this cheap enough to
 * poll on every status refresh. Stale by however much origin has
 * advanced since the last sync, but the count we care about (local
 * → origin) only changes from local commits / publishes, both of
 * which are user actions that already trigger a status refresh.
 *
 * Returns 0 on any error (no remote, no upstream, fresh repo) so
 * the badge gracefully hides instead of showing an error.
 */
export async function getLocalAhead(): Promise<number> {
  if (!git) return 0
  try {
    const remotes = await git.getRemotes(false)
    if (remotes.length === 0) return 0
    const branchSummary = await git.branchLocal()
    const branch = branchSummary.current || 'main'
    const remoteRef = `origin/${branch}`
    await git.raw(['rev-parse', '--verify', remoteRef])
    const out = (await git.raw(['rev-list', '--count', `${remoteRef}..HEAD`])).trim()
    const n = parseInt(out, 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

export async function createProgressTag(
  name: string,
  message?: string
): Promise<{ success: boolean; error?: string }> {
  const g = getGit()
  const trimmed = (name || '').trim()
  if (!trimmed) return { success: false, error: 'Tag name is required' }
  if (/\s/.test(trimmed) || /[~^:?*\[\]\\]/.test(trimmed)) {
    return { success: false, error: 'Tag name cannot contain spaces or any of ~^:?*[]\\' }
  }
  try {
    await g.addAnnotatedTag(trimmed, message || `Weekly progress: ${trimmed}`)
    const remotes = await g.getRemotes(false)
    if (remotes.length > 0) {
      try { await g.pushTags() } catch (err) {
        return { success: false, error: 'Tag created locally but push failed: ' + (err as Error).message }
      }
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

export async function sync(): Promise<SyncResult> {
  const g = getGit()
  try {
    // Mint a fresh LFS auth header before pulling — git-lfs's smudge
    // filter runs during the pull and needs a valid token to fetch
    // any new objects from the self-hosted server. No-op when LFS
    // isn't configured for this project.
    await refreshLfsAuthForOpenProject()

    const before = await g.log({ maxCount: 1 })

    // CAD students often have unsaved or just-saved local changes when
    // they hit Download. Git rebase refuses to run with a dirty tree
    // ("cannot pull with rebase: You have unstaged changes"). Stash
    // around the pull and pop afterwards so the workflow Just Works.
    // The stash includes untracked files (--include-untracked) so a
    // brand-new .sldprt isn't left out.
    const status = await g.status()
    const dirty = status.files.length > 0
    const stashLabel = `framecad-sync-${Date.now()}`
    let stashed = false

    if (dirty) {
      try {
        await g.raw(['stash', 'push', '--include-untracked', '-m', stashLabel])
        stashed = true
      } catch (stashErr) {
        // If we can't stash (rare — usually permissions), surface a
        // clear actionable error instead of git's cryptic rebase message
        return {
          success: false,
          filesUpdated: 0,
          error: 'Could not stash local changes before sync: ' + (stashErr as Error).message
        }
      }
    }

    let pullErr: Error | null = null
    try {
      await g.pull(['--rebase'])
    } catch (err) {
      pullErr = err as Error
    }

    if (stashed) {
      // Pop regardless of whether the pull succeeded — restore the
      // user's working tree to its pre-sync state on failure, and on
      // success let the popped changes ride forward
      try {
        await g.raw(['stash', 'pop'])
      } catch (popErr) {
        // Pop conflicted (incoming changes touched the same files the
        // user had edited locally). The stash stays in `git stash list`
        // for them to resolve. Surface this clearly.
        return {
          success: false,
          filesUpdated: 0,
          error:
            'Sync downloaded teammates\' changes, but your local edits ' +
            'conflicted with theirs. Your work is safe in `git stash` ' +
            '(label "' + stashLabel + '") — resolve the conflicts and run ' +
            '`git stash pop` manually, then Publish. (' + (popErr as Error).message + ')'
        }
      }
    }

    if (pullErr) {
      const remoteGone = detectRemoteGoneError(pullErr.message)
      return {
        success: false,
        filesUpdated: 0,
        error: remoteGone ?? pullErr.message,
        remoteGone: remoteGone !== null,
      }
    }

    const after = await g.log({ maxCount: 1 })
    const filesUpdated = before.latest?.hash !== after.latest?.hash
      ? (await g.diffSummary([before.latest!.hash, after.latest!.hash])).changed
      : 0

    return { success: true, filesUpdated }
  } catch (err: unknown) {
    return { success: false, filesUpdated: 0, error: (err as Error).message }
  }
}

// Engineering, robotics, and architecture vocabulary used when an upload
// is submitted with an empty message. Three picks from this list form a
// human-memorable label like "torque truss flywheel" or "scaffold lidar
// spline".
const RANDOM_WORDS = [
  'actuator', 'anchor', 'arch', 'archway', 'armature', 'atrium',
  'autonomy', 'axle', 'balcony', 'balustrade', 'beam', 'bearing',
  'blueprint', 'bolt', 'brace', 'bracket', 'buttress', 'cam',
  'cantilever', 'capital', 'capstan', 'caster', 'chamfer', 'chassis',
  'clamp', 'claw', 'clutch', 'column', 'controller', 'cornice',
  'coupling', 'crank', 'cupola', 'dashboard', 'dome', 'dormer',
  'drivetrain', 'eave', 'encoder', 'facade', 'fastener', 'fillet',
  'flange', 'flywheel', 'foundation', 'frieze', 'fulcrum', 'gable',
  'gasket', 'gear', 'girder', 'gripper', 'gusset', 'gyro', 'hinge',
  'hub', 'hydraulic', 'impeller', 'intake', 'joist', 'journal',
  'keystone', 'kinematic', 'lattice', 'lever', 'lidar', 'linkage',
  'lintel', 'lug', 'manifold', 'manipulator', 'mezzanine', 'motor',
  'mullion', 'nut', 'obelisk', 'parapet', 'payload', 'pediment',
  'pier', 'pillar', 'pinion', 'piston', 'pivot', 'pneumatic',
  'portico', 'pulley', 'quadrant', 'rafter', 'ratchet', 'ridge',
  'rivet', 'robot', 'rotor', 'rotunda', 'scaffold', 'screw',
  'sensor', 'servo', 'shaft', 'shim', 'shooter', 'socket',
  'solenoid', 'span', 'spire', 'spline', 'spring', 'sprocket',
  'strut', 'suspension', 'swerve', 'telemetry', 'terrace', 'throttle',
  'torque', 'transom', 'truss', 'turbine', 'valve', 'vault',
  'vector', 'vernier', 'vision', 'washer', 'waveform', 'wedge',
  'wheel', 'winch', 'yoke'
]

function randomCommitMessage(): string {
  const pick = () => RANDOM_WORDS[Math.floor(Math.random() * RANDOM_WORDS.length)]
  return `${pick()}-${pick()}-${pick()}`
}

// Ask git which of the given paths currently resolve to the LFS
// filter via .gitattributes. Returns a Set of LFS-tracked paths.
//
// Batched because `git check-attr filter -- <path> <path> ...` puts
// every path on the argv, and Windows' CreateProcess caps the whole
// command line near 32 KB. A big SolidWorks assembly import (several
// hundred deep-nested COTS files) blew past that limit and produced
// `spawn ENAMETOOLONG`. Path lengths in CAD repos average ~100 chars
// with the deep `COTS/<vendor>/<family>/...` hierarchy, so we hold
// each batch to 100 paths — comfortably under the limit with room
// for the git binary path and other argv overhead.
async function checkAttrLfsBatched(
  g: SimpleGit,
  paths: string[],
): Promise<Set<string>> {
  const set = new Set<string>()
  if (paths.length === 0) return set
  const BATCH = 100
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH)
    const out = await g.raw(['check-attr', 'filter', '--', ...batch])
    for (const line of out.split('\n')) {
      const m = line.match(/^(.+):\s*filter:\s*lfs\s*$/)
      if (m) set.add(m[1].trim())
    }
  }
  return set
}

export async function publish(
  message: string,
  onProgress?: (p: PublishProgress) => void
): Promise<PublishResult> {
  const g = getGit()
  // GIT_LFS_PROGRESS file + tail watcher live for the whole publish so
  // multiple push phases all stream into the same progress signal.
  // Created upfront, cleaned up unconditionally in the outer finally.
  const lfsProgressFile = path.join(
    os.tmpdir(),
    `framecad-lfs-progress-${Date.now()}-${process.pid}.log`,
  )
  let stopLfsTail: (() => void) | null = null
  // Track the last file git-lfs reported uploading. Used in the error
  // path to tell the user WHICH file the publish died on — usually the
  // single most actionable diagnostic for a partial-publish failure.
  // Updated by the GIT_LFS_PROGRESS tail; resets between phases via
  // the natural progression of the underlying stream.
  let lastLfsFile: string | null = null
  try {
    await fs.writeFile(lfsProgressFile, '')
    stopLfsTail = tailLfsProgress(lfsProgressFile, cf => {
      onProgress?.({ phase: 'uploading', currentFile: cf })
      if (cf?.path) lastLfsFile = cf.path
    })
  } catch { /* fall through — progress just won't have per-file detail */ }

  try {
    // Refresh LFS auth header up front so git-lfs's pre-push hook
    // (and any verify/upload calls during this publish) talk to the
    // self-hosted server with a valid bearer token. The header sits
    // in `.git/config` for the duration of this invocation. No-op
    // when LFS isn't configured for this project.
    //
    // Surface the server-side quota grace status to the UI so the
    // user knows they're in the 24-hour warn window before writes
    // get blocked. The first 'preparing' event with the grace flag
    // lets the renderer show a yellow banner alongside the modal.
    const lfsAuth = await refreshLfsAuthForOpenProject()
    if (lfsAuth?.grace === 'in-grace') {
      onProgress?.({
        phase: 'preparing',
        detail: 'Project is over its storage quota — 24-hour grace window active',
        quotaGrace: 'in-grace',
        quotaGraceStartedAt: lfsAuth.graceStartedAt ?? undefined,
      })
    } else if (lfsAuth?.grace === 'expired') {
      onProgress?.({
        phase: 'preparing',
        detail: 'Project is over quota and the grace window has expired — uploads will fail',
        quotaGrace: 'expired',
      })
    }

    await syncManifest()

    // BEFORE we look at status, clean up any local-ahead commits from
    // previous failed publish attempts. Reason: those commits may have
    // been made when .gitattributes didn't yet have an LFS pattern for
    // some extension (e.g. *.zip pre-v0.7.7), so they store the file as
    // a raw git blob that exceeds GitHub's 100 MB hard limit. No
    // amount of fixing the current commit helps because the OLD bad
    // commits are pushed too. We can safely reset because (a) the
    // working tree isn't touched, (b) those commits never reached
    // origin (the push has been failing), (c) the publish flow will
    // rebuild a fresh commit from the working tree below.
    //
    // We follow with `git add --renormalize -u` so any already-tracked
    // file whose .gitattributes filter has CHANGED since it was last
    // staged gets re-run through the new filter (e.g. a .zip that was
    // staged as a raw blob before *.zip was LFS-tracked becomes a
    // pointer in the index).
    try {
      const branchSummary = await g.branchLocal()
      const branch = branchSummary.current || 'main'
      const remoteRef = `origin/${branch}`
      const remoteExists = await g.raw(['rev-parse', '--verify', remoteRef])
        .then(() => true).catch(() => false)
      if (remoteExists) {
        const aheadCount = parseInt(
          (await g.raw(['rev-list', '--count', `${remoteRef}..HEAD`])).trim(),
          10
        )
        if (aheadCount > 0) {
          onProgress?.({
            phase: 'preparing',
            files: [],
            detail: `Cleaning up ${aheadCount} unpushed commit${aheadCount === 1 ? '' : 's'} from earlier failed uploads…`
          })
          await g.raw(['reset', '--mixed', remoteRef])
        }
      }
    } catch { /* best-effort — fall through to normal flow */ }

    // Re-apply current .gitattributes filters to all tracked files.
    // Catches the case where a file is in the index as a raw blob but
    // .gitattributes was later updated to LFS-track its extension.
    try {
      await g.raw(['add', '--renormalize', '-u'])
    } catch { /* best-effort */ }

    const status = await g.status()
    if (status.files.length === 0) {
      return { success: false, error: 'No changes to upload' }
    }

    const files = status.files.map(f => f.path)
    onProgress?.({ phase: 'preparing', files, detail: 'Preparing upload' })

    // Pre-flight: any file over 50 MB that is NOT LFS-tracked will trip
    // GitHub's 100 MB hard limit (warned at 50 MB) and get the whole push
    // rejected by the pre-receive hook AFTER the LFS portion finishes —
    // wasting potentially gigabytes of upload time. Catch them up front
    // and abort with an actionable error instead.
    //
    // Critically, we check BOTH the current working-tree changes (what's
    // about to be staged) AND any files in commits already pending on
    // origin (e.g. a previous publish that failed to push left a local
    // commit; without this we'd happily push that bad commit on top of
    // new work).
    const projectDir = getProjectPath()
    // Thresholds come from team policies (Settings → Limits &
    // Policies on the admin UI). DEFAULT_TEAM_POLICIES holds the
    // historical 50 MB / 256 MB values for solo / not-enrolled
    // mode + as a safety net when the snapshot is missing or older
    // server versions don't return a `policies` block.
    //
    // WARN_BYTES triggers the LFS self-heal — files this size get
    // auto-routed through LFS via `.gitattributes`. HARD_BYTES is
    // the absolute refusal: anything above is split-into-sub-
    // assemblies advice, served via the error message below.
    const policies = getPolicies()
    const WARN_BYTES = policies.lfsAutotrackThresholdMb * 1024 * 1024
    const HARD_BYTES = policies.maxFileSizeMb * 1024 * 1024

    const candidatePaths = new Set<string>(files)
    try {
      const branchSummary = await g.branchLocal()
      const branch = branchSummary.current || 'main'
      // Files changed in any local-ahead-of-origin commit (won't error
      // if origin/<branch> doesn't exist — we just skip this scan)
      const pendingFiles = await g.raw(['diff', '--name-only', `origin/${branch}..HEAD`])
        .catch(() => '')
      for (const line of pendingFiles.split('\n')) {
        const p = line.trim()
        if (p) candidatePaths.add(p)
      }
    } catch { /* best-effort */ }

    const sizes = await Promise.all(
      [...candidatePaths].map(async f => {
        try {
          const stat = await fs.stat(path.join(projectDir, f))
          return { path: f, size: stat.size }
        } catch {
          return { path: f, size: 0 }
        }
      })
    )
    const largeCandidates = sizes.filter(s => s.size > WARN_BYTES)
    if (largeCandidates.length > 0) {
      let lfsPaths = await checkAttrLfsBatched(g, largeCandidates.map(s => s.path))
      let blockers = largeCandidates.filter(s => !lfsPaths.has(s.path))

      // SELF-HEAL pass. The end-user shouldn't have to understand LFS
      // tracking — when they drop a big binary (a .sldasm, a .step, a
      // zip the team-shared CAD pulled in) into the project, FrameCAD
      // routes it to LFS automatically. We do that by adding their
      // file extensions to .gitattributes via `git lfs track`, then
      // re-staging them with --renormalize so the index entry becomes
      // an LFS pointer instead of a raw blob.
      //
      // Files >100 MB that already exist as raw blobs in the staged
      // commit can't be salvaged this way (LFS can't intercept after
      // the blob has been written), but the renormalize covers the
      // common case where the file is in the working tree or in a
      // local-ahead-of-origin commit that we already reset away
      // above. Anything still over the 100 MB hard limit after
      // self-heal falls through to the original error.
      if (blockers.length > 0) {
        onProgress?.({
          phase: 'preparing',
          files: [],
          detail: `Setting up LFS for ${blockers.length} large file${blockers.length === 1 ? '' : 's'}…`,
        })
        const exts = new Set<string>()
        for (const b of blockers) {
          const raw = path.extname(b.path).replace(/^\./, '')
          if (raw) {
            // Track both the literal extension and its lower-case
            // form so a `.SLDASM` and a `.sldasm` both pick up the
            // same filter. `git lfs track` is idempotent — re-adding
            // an existing pattern is a no-op.
            exts.add(raw)
            exts.add(raw.toLowerCase())
            exts.add(raw.toUpperCase())
          }
        }
        for (const ext of exts) {
          try {
            await g.raw(['lfs', 'track', `*.${ext}`])
          } catch { /* best-effort — surfaces in the recheck below */ }
        }
        // Stage the updated .gitattributes alongside the renormalized
        // blockers, so the very next commit carries both the rule and
        // the conversion in one atomic step.
        try { await g.raw(['add', '.gitattributes']) } catch { /* */ }
        for (const b of blockers) {
          try {
            await g.raw(['add', '--renormalize', b.path])
          } catch { /* best-effort */ }
        }
        // Re-check. Files that are now LFS-tracked drop out of the
        // blockers list; whatever's left genuinely can't be salvaged
        // automatically and we surface the original error below.
        lfsPaths = await checkAttrLfsBatched(g, blockers.map(s => s.path))
        blockers = blockers.filter(s => !lfsPaths.has(s.path))
      }

      if (blockers.length > 0) {
        const list = blockers.map(s =>
          `  - ${s.path} (${(s.size / 1024 / 1024).toFixed(0)} MB)`
        ).join('\n')
        const msg =
          `${blockers.length} file(s) over 50 MB couldn't be auto-routed to ` +
          `Git LFS — these are likely already committed as raw blobs in your ` +
          `local history:\n\n${list}\n\n` +
          `To fix: either delete the files (installers and large zips usually ` +
          `don't belong in a CAD repo), or ask your admin to migrate the ` +
          `project's LFS tracking via \`git lfs migrate import\`.`
        onProgress?.({ phase: 'error', error: msg })
        return { success: false, error: msg }
      }
    }

    // ── Hard size cap ─────────────────────────────────────────────
    // Anything above the WARN threshold has been routed through LFS
    // by the self-heal above. Past HARD_BYTES we refuse the publish
    // regardless of LFS tracking — files this large are almost
    // always a top-level robot assembly that should be split into
    // sub-assemblies, or a non-CAD file that doesn't belong here.
    const oversized = sizes.filter(s => s.size > HARD_BYTES)
    if (oversized.length > 0) {
      const list = oversized.map(s =>
        `  - ${s.path} (${(s.size / 1024 / 1024).toFixed(0)} MB)`
      ).join('\n')
      const msg =
        `${oversized.length} file(s) are over the ${policies.maxFileSizeMb} MB per-file limit:\n\n${list}\n\n` +
        `FrameCAD caps individual files at ${policies.maxFileSizeMb} MB ` +
        `(configurable in admin Settings → Limits & Policies). Files this large ` +
        `usually mean a top-level SolidWorks assembly that should be split into ` +
        `sub-assemblies (use the design tree to identify subsystems and Save ` +
        `As → New Document for each), or a non-CAD file that shouldn't be in ` +
        `the repo (zip / installer / video).`
      onProgress?.({ phase: 'error', error: msg })
      return { success: false, error: msg }
    }

    // ── File-type blacklist ──────────────────────────────────────
    // Block formats that don't belong in a CAD repo regardless of
    // size: videos, audio, niche archives, executables, raw browser
    // URL shortcuts. Catches the common "I accidentally dragged my
    // Downloads folder into the project" case BEFORE the push
    // wastes bandwidth + bloats history. Extension match is
    // case-insensitive against the trailing dot-segment.
    //
    // Blocklist is server-controlled (admin Settings → Limits &
    // Policies); the values seeded by migration v12 match the
    // historical built-in list. Default explicitly does NOT include
    // images or zip — vendor STEP packages ship as `*-STEP.zip`,
    // teams keep reference datasheet images next to the parts they
    // describe. The per-file size cap above is the actual backstop
    // against accidental binary bloat.
    const BLOCKED_EXTS = new Set<string>(
      policies.blockedExtensions.map(e => e.toLowerCase())
    )
    const blacklisted = sizes
      .map(s => ({ path: s.path, ext: path.extname(s.path).replace(/^\./, '').toLowerCase() }))
      .filter(s => s.ext && BLOCKED_EXTS.has(s.ext))
    if (blacklisted.length > 0) {
      const list = blacklisted.map(s => `  - ${s.path}`).join('\n')
      const exts = [...new Set(blacklisted.map(s => s.ext))].sort().join(', ')
      const msg =
        `${blacklisted.length} file(s) have a file type that's not allowed ` +
        `in a CAD repo:\n\n${list}\n\nBlocked extensions in this batch: ${exts}.\n\n` +
        `FrameCAD blocks videos, audio, executables, niche archives ` +
        `(rar / 7z / tar.gz / xz), and URL shortcuts at publish time. ` +
        `Delete these files, or add them to your .gitignore if they belong ` +
        `on disk but shouldn't be tracked. (Images and zip files — including ` +
        `vendor STEP zips — are allowed.)`
      onProgress?.({ phase: 'error', error: msg })
      return { success: false, error: msg }
    }

    // ── LFS routing policy: SELF-HOSTED ONLY ─────────────────────
    // FrameCAD never pushes LFS objects to GitHub. They eat GitHub's
    // metered LFS quota and silently brick the team when budget runs
    // out (Trent's team learned this the hard way). Run the routing
    // enforcement BEFORE the push — see helper docstring for why we
    // can't just look at the current commit's staged files.
    const lfsRouting = await ensureLfsRoutingForPush(g, projectDir, onProgress)
    if (lfsRouting.refuseReason) {
      onProgress?.({ phase: 'error', error: lfsRouting.refuseReason })
      return { success: false, error: lfsRouting.refuseReason }
    }
    if (lfsRouting.endpoint && lfsRouting.lfsObjectsInWorkingTree > 0) {
      // Surface the resolved endpoint to the renderer so the user can
      // see where LFS objects are about to be sent. Cheap, but huge
      // diagnostic value when something looks wrong — Trent can read
      // it off the publish progress modal without dropping into a
      // terminal.
      onProgress?.({
        phase: 'preparing',
        files,
        detail: `LFS routing: ${lfsRouting.endpoint} ` +
          `(${lfsRouting.lfsObjectsInWorkingTree} LFS object${lfsRouting.lfsObjectsInWorkingTree === 1 ? '' : 's'} in working tree)`,
      })
    }
    // Stage `.lfsconfig` for inclusion in this commit if the helper
    // just wrote a fresh one — that way future clones pick up the
    // self-hosted endpoint on day one.
    try {
      const lfsConfigStatus = await g.raw(['status', '--porcelain', '.lfsconfig'])
      if (lfsConfigStatus.trim() && !files.includes('.lfsconfig')) {
        files.push('.lfsconfig')
      }
    } catch { /* best-effort */ }

    const finalMessage = (message ?? '').trim() || randomCommitMessage()

    // Split the push into two commits by FILE SIZE, not by .gitattributes
    // pattern. Most CAD files (.sldprt under 50 MB) match the LFS
    // pattern but their LFS objects are small and upload in milliseconds
    // — there's no value in isolating them from the metadata push.
    // The real value of splitting is isolating the FEW files large
    // enough to fail a slow upload: a single 200 MB .sldasm timing out
    // shouldn't take down the publish of 200 small parts + the
    // parts.json + the build-season docs.
    //
    // Threshold: 50 MB matches GitHub's "recommended max" warning. Files
    // at or under it go to phase 1 (small files + metadata, fast push,
    // small LFS objects ride along); files above it go to phase 2 (the
    // slow few). Deleted files (size 0 because they're missing from
    // disk) always end up in phase 1.
    const SPLIT_BYTES = 50 * 1024 * 1024
    const fileSizes = await Promise.all(files.map(async f => {
      try {
        const stat = await fs.stat(path.join(projectDir, f))
        return { path: f, size: stat.size }
      } catch {
        return { path: f, size: 0 }
      }
    }))
    const phase1Files = fileSizes.filter(s => s.size <= SPLIT_BYTES).map(s => s.path)
    const phase2Files = fileSizes.filter(s => s.size > SPLIT_BYTES).map(s => s.path)
    const willSplit = phase1Files.length > 0 && phase2Files.length > 0

    // The renderer's progress modal shows `N files in this upload` based
    // on `files` in the progress event. We always send the FULL file
    // list (across both phases) so that count is stable and accurate;
    // the per-phase detail string distinguishes which phase is running.
    const buildPushGit = () => {
      // Pin the LFS endpoint via `git -c lfs.url=<endpoint>` so every
      // git invocation through this simple-git instance gets the
      // self-hosted Giftless URL injected as command-line config.
      // Command-line `-c` beats every other source (system, global,
      // `.lfsconfig`, local `.git/config`) so a legacy clone whose
      // `.git/config` still has GitHub's `lfs.url` baked in from the
      // pre-self-hosted rollout can't silently route past us.
      //
      // Important: `GIT_LFS_URL` env var is NOT supported by git-lfs
      // (v3.0.7 used it as a belt-and-suspenders but it was a no-op).
      // The right override is `-c lfs.url=...` on the git CLI itself.
      const lfsConfigOverride = lfsRouting.endpoint
        ? [`lfs.url=${lfsRouting.endpoint}`]
        : []
      const pushGit = simpleGit(getProjectPath(), {
        config: lfsConfigOverride,
        progress: ({ method, stage, progress }) => {
          if (method === 'push' && onProgress) {
            onProgress({
              phase: 'uploading',
              files,
              percent: typeof progress === 'number' ? progress : undefined,
              detail: stage
            })
          }
        }
      })
      // Hook git-lfs's progress file so the tail watcher above can
      // surface per-file transfer bytes to the renderer. No-op when
      // the file failed to initialise; we just lose per-file detail.
      pushGit.env('GIT_LFS_PROGRESS', lfsProgressFile)
      pushGit.outputHandler((_bin, _stdout, stderr) => {
        stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          const lfs = text.match(/Uploading LFS objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)/)
          if (lfs && onProgress) {
            onProgress({
              phase: 'uploading',
              files,
              percent: parseInt(lfs[1], 10),
              detail: `LFS ${lfs[2]} of ${lfs[3]} uploaded`
            })
          }
        })
      })
      return pushGit
    }

    /**
     * Stage the given paths, commit with the given message, push.
     * On push failure, roll back the just-made commit (--soft so the
     * files stay staged for retry) and throw so the outer catch
     * surfaces the error. Already-pushed earlier-phase commits are
     * NOT touched — they succeeded and the user benefits from that
     * partial progress.
     */
    const runPhase = async (
      phaseFiles: string[],
      phaseMessage: string,
      detailLabel: string
    ): Promise<string | null> => {
      if (phaseFiles.length === 0) return null

      // Re-query status RIGHT BEFORE staging. Between the initial
      // status capture at the top of publish() and this point, the
      // user may have removed or moved files in Windows Explorer / the
      // SolidWorks file dialog. A path that was untracked-and-present
      // in the original snapshot can now be missing from disk, and
      // `git add <gone-untracked-path>` fails with
      // "fatal: pathspec '...' did not match any files".
      //
      // Filtering against fresh status ensures we only stage paths
      // git still sees as changed (either still in the working tree,
      // or tracked-and-now-deleted). Anything that vanished from disk
      // AND was never tracked gets silently dropped from this phase
      // — exactly the right behavior since the user clearly didn't
      // want it published.
      const freshStatus = await g.status()
      const freshSet = new Set(freshStatus.files.map(f => f.path))
      const stagable = phaseFiles.filter(p => freshSet.has(p))
      if (stagable.length === 0) return null

      // git add doesn't accept too many args at once — Windows
      // CreateProcess caps the whole command line near 32 KB, and CAD
      // paths in this project average ~100 chars with the deep
      // `COTS/<vendor>/<family>/...` hierarchy. 200 paths × ~150 char
      // average = 30 KB, perilously close to the limit. 100 keeps a
      // comfortable margin for both the git binary prefix and longer-
      // than-average paths (Windows MAX_PATH is 260, and a single
      // outlier could push 200 × 260 = 52 KB over the cliff).
      // Matches `checkAttrLfsBatched` so the failure mode is uniform.
      //
      // Defensive retry: even with the freshStatus filter above, edge
      // cases (case-insensitive Windows FS reporting a renamed-by-case
      // path; race between fresh-status and add where a watcher event
      // is still propagating; simple-git path quoting/encoding quirks)
      // can leave a stale entry that `git add` rejects with "fatal:
      // pathspec '...' did not match any files". When that happens we
      // parse the offending path out of the error, drop it, and retry
      // the same chunk. Tasks are bounded by chunk size so this can
      // only loop a finite number of times.
      const CHUNK = 100
      let cursor = 0
      let remaining = stagable.slice()
      while (cursor < remaining.length) {
        const batch = remaining.slice(cursor, cursor + CHUNK)
        try {
          await g.raw(['add', '--', ...batch])
          cursor += batch.length
        } catch (addErr) {
          const msg = (addErr as Error).message || ''
          const m = msg.match(/pathspec ['"]([^'"]+)['"] did not match/)
          if (!m) throw addErr
          const badPath = m[1]
          const idx = remaining.indexOf(badPath, cursor)
          if (idx < 0) throw addErr
          // Drop the offender in place; cursor stays put so we retry
          // the rest of the batch (including paths that came AFTER the
          // offender, which git add never processed because the whole
          // call errored).
          remaining.splice(idx, 1)
        }
      }

      // Staging may have produced an empty diff (e.g. files reverted in
      // the working tree, or every file was already in the index from
      // an earlier failed publish). git commit would throw "nothing to
      // commit" — treat as a successful no-op for this phase and skip
      // the push.
      const statusAfter = await g.status()
      if (statusAfter.staged.length === 0 && !statusAfter.files.some(f =>
        stagable.includes(f.path) && (f.index === 'A' || f.index === 'M' || f.index === 'D' || f.index === 'R')
      )) {
        return null
      }

      let commitResult
      try {
        commitResult = await g.commit(phaseMessage)
      } catch (commitErr) {
        const m = (commitErr as Error).message || ''
        // "nothing to commit" / "no changes added" — benign, skip push
        if (/nothing to commit|no changes added/i.test(m)) return null
        throw commitErr
      }

      onProgress?.({ phase: 'uploading', files, percent: 0, detail: detailLabel })
      // Re-mint the LFS JWT immediately before EACH phase's push. The
      // token issued at the top of `publish` is only 15 minutes; a
      // long phase-1 (lots of small LFS objects) followed by a slow
      // phase-2 (a single 60 MB .sldasm over school WiFi) easily
      // crosses the TTL midway. Without this, phase 2 starts with a
      // token that expires partway through and git-lfs surfaces a
      // confusing 401 after gigabytes of wasted bandwidth.
      await refreshLfsAuthForOpenProject().catch(() => null)
      const pushGit = buildPushGit()
      try {
        await pushGit.push()
      } catch (pushErr) {
        try { await g.raw(['reset', '--soft', 'HEAD~1']) } catch { /* best-effort */ }
        throw pushErr
      }
      return commitResult.commit
    }

    const phase1Msg = willSplit ? `${finalMessage} (part 1 of 2)` : finalMessage
    const phase2Msg = willSplit ? `${finalMessage} (part 2 of 2)` : finalMessage

    const phase1Hash = await runPhase(phase1Files, phase1Msg, willSplit
      ? `Uploading small files (1 of 2, ${phase1Files.length} files)`
      : 'Uploading to GitHub')

    let phase2Hash: string | null = null
    try {
      phase2Hash = await runPhase(phase2Files, phase2Msg, willSplit
        ? `Uploading large files (2 of 2, ${phase2Files.length} files)`
        : 'Uploading to GitHub')
    } catch (phase2Err) {
      // Phase 1 already pushed to origin, phase 2 failed mid-publish.
      // Decorate the error so the UI tells the user they're in a
      // partial-upload state instead of just showing a generic failure:
      // some files made it to GitHub, others didn't, and re-publishing
      // will only retry the failed ones.
      if (willSplit && phase1Hash) {
        const msg = (phase2Err as Error).message || String(phase2Err)
        throw new Error(
          `Publish partially completed: small files uploaded as ${phase1Hash.slice(0, 7)}, ` +
          `but large-file phase failed. Re-publish to retry the remaining files.\n\n` +
          `Underlying error: ${msg}`
        )
      }
      throw phase2Err
    }

    onProgress?.({ phase: 'done', files, percent: 100, detail: 'Upload complete' })
    return { success: true, hash: phase2Hash ?? phase1Hash ?? undefined }
  } catch (err: unknown) {
    const errMsg = (err as Error).message
    // Check LFS-unreachable BEFORE remote-gone. They overlap in
    // surface keywords (`http 404`, `failed to connect`) but the
    // user-facing remediation is different: LFS unreachable should
    // offer the skip-smudge retry, whereas "remote gone" implies the
    // GitHub repo is deleted. Picking the LFS path first prevents a
    // real Giftless outage from being mis-labelled as a deleted repo.
    const lfsUnreachable = isLfsUnreachableError(errMsg)
    const remoteGone = !lfsUnreachable ? detectRemoteGoneError(errMsg) : null
    // Append the last file git-lfs was uploading when the failure
    // happened — usually the single most actionable diagnostic for a
    // mid-publish death. ("Re-publishing without `foo.sldasm` will
    // probably succeed; investigate that file specifically.") Only
    // tacked on when we have something AND the error isn't already
    // a friendlier classified one (lfs-unreachable / remote-gone
    // come with their own remediation copy).
    const decoratedErr = (!lfsUnreachable && !remoteGone && lastLfsFile)
      ? `${errMsg}\n\nLast file being uploaded when this failed: ${lastLfsFile}. ` +
        `If you re-publish and hit the same error, try removing or splitting that ` +
        `file specifically — earlier files in this commit already uploaded successfully.`
      : (remoteGone ?? errMsg)
    onProgress?.({
      phase: 'error',
      error: decoratedErr,
      remoteGone: remoteGone !== null,
    })
    return {
      success: false,
      error: decoratedErr,
      remoteGone: remoteGone !== null,
    }
  } finally {
    // Always tear down the tail watcher + remove the progress file,
    // even on uncaught errors. Cleanup is best-effort — a leaked temp
    // file isn't a correctness issue (os.tmpdir() gets nuked on reboot).
    stopLfsTail?.()
    await fs.rm(lfsProgressFile, { force: true }).catch(() => null)
  }
}

const COTS_DIR = 'COTS'

export async function setMainRemoteUrl(url: string): Promise<void> {
  const g = getGit()
  const remotes = await g.getRemotes(true)
  const origin = remotes.find(r => r.name === 'origin')
  if (origin) {
    await g.remote(['set-url', 'origin', url])
  } else {
    await g.remote(['add', 'origin', url])
  }
}

async function ensureCotsGitignored(): Promise<void> {
  const ignorePath = path.join(getProjectPath(), '.gitignore')
  let existing = ''
  try { existing = await fs.readFile(ignorePath, 'utf-8') } catch { /* missing */ }
  if (existing.split('\n').some(line => line.trim() === COTS_DIR || line.trim() === COTS_DIR + '/')) return
  const updated = (existing.endsWith('\n') || existing === '' ? existing : existing + '\n') + COTS_DIR + '/\n'
  await fs.writeFile(ignorePath, updated)
}

export async function syncCotsRepo(repoUrl: string, branch?: string): Promise<{ success: boolean; cloned?: boolean; error?: string }> {
  if (!repoUrl) return { success: false, error: 'No COTS repo URL configured' }
  const projectDir = getProjectPath()
  const cotsDir = path.join(projectDir, COTS_DIR)
  await ensureCotsGitignored()
  try {
    const exists = await fs.stat(cotsDir).then(() => true).catch(() => false)
    if (!exists) {
      // Clone fresh
      const args = ['clone']
      if (branch) args.push('-b', branch)
      args.push(repoUrl, COTS_DIR)
      await simpleGit(projectDir).raw(args)
      return { success: true, cloned: true }
    }
    // Pull latest. Use a SimpleGit instance scoped to the COTS folder.
    const cotsGit = simpleGit(cotsDir)
    await cotsGit.fetch('origin')
    if (branch) {
      await cotsGit.raw(['checkout', branch])
    }
    await cotsGit.pull(['--ff-only'])
    return { success: true, cloned: false }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

async function getCurrentBranch(g: SimpleGit): Promise<string> {
  try {
    const r = await g.revparse(['--abbrev-ref', 'HEAD'])
    const branch = r.trim()
    return branch && branch !== 'HEAD' ? branch : 'main'
  } catch {
    return 'main'
  }
}

/**
 * Best-effort pull of a single file from the upstream tracking branch so we
 * have the latest team state before modifying it locally. Skipped if local
 * has uncommitted changes to the same path (avoids overwriting in-flight
 * work) or if there's no remote configured.
 */
export async function pullRemoteFile(relPath: string): Promise<void> {
  const g = getGit()
  try {
    const remotes = await g.getRemotes(false)
    if (remotes.length === 0) return
    await g.fetch('origin')
    const status = await g.status()
    if (status.files.some(f => f.path === relPath)) return
    const branch = await getCurrentBranch(g)
    try {
      await g.raw(['checkout', `origin/${branch}`, '--', relPath])
    } catch { /* file may not exist on remote yet */ }
  } catch { /* network failure, no remote — proceed with local */ }
}

/**
 * Stage a single file, commit it with the given message, and push. If the
 * push fails because someone else pushed in between (non-fast-forward),
 * stash any unrelated dirty files, rebase our commit on top of origin,
 * and retry the push once. If the push fails for any other reason — or
 * the rebase conflicts — unwind the commit so the working tree is clean
 * and surface a clear error to the caller.
 *
 * Why this matters for metadata: the modifyAndSync pattern pulls just
 * the meta file before mutating, but doesn't advance the local branch
 * pointer. A teammate publishing a CAD file between our pull and our
 * push would otherwise reject our metadata commit until the user
 * manually Sync'd.
 */
export async function commitAndPushFile(relPath: string, message: string): Promise<void> {
  const g = getGit()
  const remotes = await g.getRemotes(false)

  // If any files are stuck in unmerged state from a prior failed sync,
  // resolve them before committing. For our target file, the caller
  // already wrote the correct content; for others, accept their current
  // working-tree version so the commit can proceed.
  const preStatus = await g.status()
  const unmerged = preStatus.conflicted
  if (unmerged.length > 0) {
    await g.raw(['add', ...unmerged])
  }

  await g.raw(['add', relPath])
  const status = await g.status()
  if (!status.files.some(f => f.path === relPath)) return
  await g.commit(message)
  if (remotes.length === 0) return

  const undoCommit = async () => {
    await g.raw(['reset', '--soft', 'HEAD~1'])
    await g.raw(['reset', '--', relPath])
  }

  let firstErr: Error
  try {
    await g.push()
    return
  } catch (err) {
    firstErr = err as Error
    if (!isNonFastForward(firstErr.message)) {
      await undoCommit()
      throw new Error('Could not sync to team — ' + firstErr.message)
    }
  }

  // Non-fast-forward — rebase on top of origin and retry. Stash unrelated
  // dirty files so the rebase can run cleanly.
  const stashLabel = `framecad-meta-${Date.now()}`
  let stashed = false
  const dirtyStatus = await g.status()
  if (dirtyStatus.files.length > 0) {
    try {
      await g.raw(['stash', 'push', '--include-untracked', '-m', stashLabel])
      stashed = true
    } catch {
      // Couldn't stash — unwind and let the user resolve manually
      await undoCommit()
      throw new Error('Could not sync to team — teammate pushed first and local has unstashable changes')
    }
  }

  try {
    await g.pull(['--rebase'])
  } catch (rebaseErr) {
    // Conflict during rebase — abort the rebase, pop the stash, unwind
    try { await g.raw(['rebase', '--abort']) } catch { /* not in a rebase */ }
    if (stashed) {
      try { await g.raw(['stash', 'pop']) } catch { /* stash stays in list */ }
    }
    await undoCommit()
    throw new Error(
      'Could not sync to team — rebase on top of origin conflicted: ' +
      (rebaseErr as Error).message
    )
  }

  try {
    await g.push()
  } catch (retryErr) {
    if (stashed) {
      try { await g.raw(['stash', 'pop']) } catch { /* stash stays */ }
    }
    await undoCommit()
    throw new Error('Could not sync to team — ' + (retryErr as Error).message)
  }

  if (stashed) {
    try {
      await g.raw(['stash', 'pop'])
    } catch {
      // Stash pop conflict — leave the stash for manual resolution
      throw new Error(
        `Metadata change pushed, but restoring your other local edits ` +
        `from stash "${stashLabel}" conflicted. Run \`git stash pop\` ` +
        `manually to recover.`
      )
    }
  }
}

/**
 * Heuristic for the specific git push failure where the remote has
 * commits we don't. Triggers our rebase-and-retry path. Other push
 * failures (auth, network) shouldn't fall through here.
 */
export function isNonFastForward(msg: string): boolean {
  return /rejected|non-fast-forward|fetch first|tip of your current branch is behind/i.test(msg)
}

export async function pullPartsJson(): Promise<void> {
  const g = getGit()
  try {
    const remotes = await g.getRemotes(false)
    if (remotes.length === 0) return
    await g.fetch('origin')
    // Skip if local has uncommitted parts.json — we'd overwrite the user's
    // pending reservation
    const status = await g.status()
    if (status.files.some(f => f.path === 'parts.json')) return
    const branch = await getCurrentBranch(g)
    try {
      await g.raw(['checkout', `origin/${branch}`, '--', 'parts.json'])
    } catch {
      // parts.json may not exist on remote yet — ignore
    }
  } catch {
    // network failure, no remote — proceed with local state
  }
}

export async function pushPartsJson(reservationLabel: string): Promise<void> {
  const g = getGit()
  const remotes = await g.getRemotes(false)
  if (remotes.length === 0) return

  await g.raw(['add', 'parts.json'])
  const status = await g.status()
  if (!status.files.some(f => f.path === 'parts.json')) return

  await g.commit(`Reserve ${reservationLabel}`)
  try {
    await g.push()
  } catch (err) {
    // Push failed — most likely another teammate reserved at the same time.
    // Undo the commit but keep parts.json on disk untouched so caller can
    // decide what to do.
    await g.raw(['reset', '--soft', 'HEAD~1'])
    await g.raw(['reset', '--', 'parts.json'])
    throw new Error('Could not sync part number to team — someone else may have reserved at the same time. Sync and try again.')
  }
}

export async function getStatus(): Promise<FileEntry[]> {
  const g = getGit()
  const dirPath = getProjectPath()
  const status = await g.status()
  const { getProjectSubpath, getCotsSubpath, toProjectRel } = await import('./paths')
  const subpath = getProjectSubpath()
  const cotsSubpath = getCotsSubpath()
  // When a project subpath is set, scan ONLY inside it; the tree
  // surfaces files relative to that subfolder so the UI can render
  // it AS the project root. With no subpath, scan from the repo root
  // as before — but still hide cotsSubpath siblings from the project
  // view when one's configured.
  const scanRoot = subpath ? path.join(dirPath, subpath) : dirPath

  // Prefer `git lfs locks --verify` because it tells us authoritatively
  // which locks are *ours* based on the authenticated GitHub identity.
  // Falling back to name-compare against `git config user.name` was the
  // old approach and silently mis-labeled the user's own locks whenever
  // their GitHub display name (e.g. "Trent Fox") differed from their
  // local git config (e.g. "trentfox1") — making Check In impossible
  // from the UI because the button only enables for `locked-by-you`.
  const verified = await verifyLocks()
  const allLocks = verified.ours.length + verified.theirs.length > 0
    ? [...verified.ours, ...verified.theirs]
    : await getLocks()

  // Translate every lock / status path to the SAME frame the tree uses
  // (subpath-relative when a project subpath is set). Anything outside
  // the subpath returns null and is dropped — those locks belong to a
  // sibling project / COTS folder and shouldn't taint our view.
  const oursSet = new Set<string>()
  for (const l of verified.ours) {
    const r = toProjectRel(l.path)
    if (r !== null) oursSet.add(r)
  }
  const lockMap = new Map<string, LockInfo>()
  for (const l of allLocks) {
    const r = toProjectRel(l.path)
    if (r !== null) lockMap.set(r, l)
  }
  // Status files keyed by subpath-relative path so the find() below
  // resolves cleanly against `relPath`.
  const statusByRel = new Map<string, typeof status.files[number]>()
  for (const f of status.files) {
    const r = toProjectRel(f.path)
    if (r !== null) statusByRel.set(r, f)
  }

  // Used only as a last-resort fallback when --verify returns nothing
  // (offline, anonymous LFS server, etc.) and we have to guess.
  const gitUsername = (await g.getConfig('user.name')).value || ''

  async function buildTree(dir: string, relativeTo: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = []
    let items: string[]
    try {
      items = await fs.readdir(dir)
    } catch {
      return entries
    }

    for (const item of items) {
      // Hide system / dotfiles and the parts manifest from the browser so
      // students don't see (or accidentally edit) the metadata layer
      if (item.startsWith('.') || item === 'parts.json') continue
      // When no project subpath is set but a COTS subpath is, hide
      // that top-level folder so it doesn't bleed into the project's
      // file tree. (When a project subpath IS set, COTS as a sibling
      // is already outside scanRoot.)
      if (!subpath && cotsSubpath && dir === dirPath && item === cotsSubpath) continue

      const fullPath = path.join(dir, item)
      const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/')

      const stat = await fs.stat(fullPath).catch(() => null)
      if (!stat) continue

      const isDirectory = stat.isDirectory()
      let state: FileState = 'synced'
      let lockedBy: string | undefined

      if (!isDirectory) {
        const statusFile = statusByRel.get(relPath)
        if (statusFile) {
          if (statusFile.index === '?' || statusFile.working_dir === '?') {
            state = 'untracked'
          } else {
            state = 'modified'
          }
        }

        const lock = lockMap.get(relPath)
        if (lock) {
          lockedBy = lock.owner
          // verified.ours is the source of truth when available; only
          // fall back to name-compare if --verify gave us nothing.
          const isOurs = verified.ours.length + verified.theirs.length > 0
            ? oursSet.has(relPath)
            : lock.owner === gitUsername
          state = isOurs ? 'locked-by-you' : 'locked-by-other'
        }
      }

      const entry: FileEntry = {
        path: relPath,
        name: item,
        isDirectory,
        state,
        lockedBy,
        children: isDirectory ? await buildTree(fullPath, relativeTo) : undefined
      }

      entries.push(entry)
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return entries
  }

  // Pass scanRoot as both args so file paths come back relative to the
  // (apparent) project root — that's what the renderer treats as the
  // canonical path identifier.
  const result = await buildTree(scanRoot, scanRoot)
  try {
    const manifest = await loadManifest()
    annotatePartNumbers(result, manifest, subpath)
  } catch {
    // parts.json may not exist yet for joined/legacy projects
  }
  try {
    const meta = await loadAllMeta()
    annotateMeta(result, meta, subpath)
  } catch {
    // parts-meta.json may not exist
  }
  return result
}

export async function getGitIdentity(): Promise<{ name: string; email: string }> {
  const g = simpleGit()
  const name = (await g.getConfig('user.name')).value || ''
  const email = (await g.getConfig('user.email')).value || ''
  return { name, email }
}

export async function setGitIdentity(name: string, email: string): Promise<void> {
  const g = simpleGit()
  await g.addConfig('user.name', name, false, 'global')
  await g.addConfig('user.email', email, false, 'global')
}

export async function getHistory(limit = 50): Promise<HistoryEntry[]> {
  const g = getGit()
  try {
    const log = await g.log({ maxCount: limit, '--stat': null })
    return log.all.map(entry => ({
      hash: entry.hash.slice(0, 8),
      message: entry.message,
      author: entry.author_name,
      date: entry.date,
      files: (entry.diff?.files || []).map(f => f.file)
    }))
  } catch {
    return []
  }
}

import path from 'path'
import { promises as fs } from 'fs'
import { getProjectPath } from './git'
import { isDriveBackend, pushSharedFile } from './persistence'

export interface AdminConfig {
  defaultPartPrefix?: string
  /**
   * Canonical Git remote URL for the main project. Stored so newly cloned
   * setups can verify they're pointing at the right remote, and so admins
   * can centrally update it (rewrites `origin` when applied).
   */
  mainRepoUrl?: string
  /**
   * Separate Git repository containing shared COTS (Commercial Off-The-Shelf)
   * parts. FrameCAD clones this into a `COTS/` subfolder of the project on
   * every open and refreshes it on Sync. The folder is gitignored in the
   * main repo so the two histories never mix.
   */
  cotsRepoUrl?: string
  cotsBranch?: string
  /**
   * Set to true when THIS project is itself a COTS library. Disables the
   * part-numbering layer (no parts.json, no auto-assign, no + Part / + Assembly
   * buttons) since COTS files have their own external numbering authority.
   */
  isCotsProject?: boolean
  /**
   * Optional LFS storage override. When set, FrameCAD writes a `.lfsconfig`
   * pointing at this URL so the project's LFS objects go to a self-hosted
   * server (rudolfs / giftless / Gitea / etc.) instead of GitHub LFS. Blank
   * = use GitHub LFS (default).
   */
  lfsUrl?: string
}

// `teamName`, `welcomeMessage`, `gitHubOrg`, `projectPrefix` moved to the
// install-wide global admin config (src/main/global-admin.ts) in v0.7.1.
// Legacy admin.json files may still have those keys — we ignore them on
// load and they get dropped on the next admin save.

/**
 * Write admin.json to disk without committing or pushing. Used during
 * create-project where there may not be anything pushed yet.
 */
export async function writeLocalAdminConfig(config: AdminConfig): Promise<void> {
  const fullPath = adminPath()
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, JSON.stringify(config, null, 2) + '\n')
}

const ADMIN_DIR = '.framecad'
const ADMIN_FILE = 'admin.json'

function adminPath(): string {
  return path.join(getProjectPath(), ADMIN_DIR, ADMIN_FILE)
}

function relAdminPath(): string {
  return `${ADMIN_DIR}/${ADMIN_FILE}`
}

export async function loadAdminConfig(): Promise<AdminConfig> {
  try {
    const raw = await fs.readFile(adminPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writeAdminConfig(config: AdminConfig): Promise<void> {
  const fullPath = adminPath()
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, JSON.stringify(config, null, 2) + '\n')
}

const LFSCONFIG_FILE = '.lfsconfig'

function lfsConfigPath(): string {
  return path.join(getProjectPath(), LFSCONFIG_FILE)
}

/**
 * Write or remove the project-root `.lfsconfig` to redirect Git LFS to a
 * self-hosted server. The file is part of the repo so teammates pick the
 * redirect up automatically on their next pull. Blank URL = delete the
 * file (revert to GitHub LFS).
 */
async function applyLfsConfig(url: string | undefined): Promise<boolean> {
  const target = (url || '').trim()
  const filePath = lfsConfigPath()
  let existing = ''
  try { existing = await fs.readFile(filePath, 'utf-8') } catch { /* missing */ }

  if (!target) {
    if (existing === '') return false
    await fs.unlink(filePath).catch(() => { /* best-effort */ })
    return true
  }

  // Standard git LFS config format. Trailing newline required by some
  // git versions or the [lfs] block silently fails to parse.
  const desired = `[lfs]\n\turl = ${target}\n`
  if (existing === desired) return false
  await fs.writeFile(filePath, desired)
  return true
}

/**
 * Save admin settings and push them to git so every client gets them on
 * their next sync. The whole point of admin config is that it propagates
 * to teammates — so this commits + pushes atomically. Also writes/clears
 * the project-root `.lfsconfig` when the lfsUrl field changes, so the
 * LFS redirect propagates the same way.
 */
export async function saveAndPublishAdminConfig(config: AdminConfig): Promise<void> {
  await writeAdminConfig(config)

  // Drive backend: no git, no LFS. Upload admin.json straight to the Drive
  // project folder so teammates pick it up on their next sync.
  if (isDriveBackend()) {
    await pushSharedFile(relAdminPath(), '[admin] Update settings')
    return
  }

  const lfsChanged = await applyLfsConfig(config.lfsUrl)

  const { getGit } = await import('./git')
  const g = getGit()
  await g.raw(['add', relAdminPath()])
  if (lfsChanged) {
    // Stage both write + delete of .lfsconfig in one shot
    await g.raw(['add', '-A', '--', LFSCONFIG_FILE]).catch(() => {})
  }
  const status = await g.status()
  const changed = status.files.some(f =>
    f.path === relAdminPath() || f.path === LFSCONFIG_FILE
  )
  if (!changed) return

  await g.commit('[admin] Update settings')

  const remotes = await g.getRemotes(false)
  if (remotes.length === 0) return

  try {
    await g.push()
  } catch (err) {
    // Roll back the local commit so working tree is clean — admin can retry
    // after resolving (likely needs to pull first). The rollback itself is
    // best-effort: if any step throws (e.g. first commit on a brand-new
    // repo with no HEAD~1), don't let that error swallow the original push
    // error the admin actually needs to see.
    try { await g.raw(['reset', '--soft', 'HEAD~1']) } catch { /* best-effort */ }
    await g.raw(['reset', '--', relAdminPath()]).catch(() => {})
    if (lfsChanged) await g.raw(['reset', '--', LFSCONFIG_FILE]).catch(() => {})
    throw new Error('Could not publish admin settings — pull/sync first and try again. (' + (err as Error).message + ')')
  }
}

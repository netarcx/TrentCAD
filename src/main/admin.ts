import path from 'path'
import { promises as fs } from 'fs'
import { getProjectPath } from './project-paths'
import { pushSharedFile } from './persistence'

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
   * Drive-backend COTS library: the Shared Drive folder id (and the
   * Shared Drive it lives in) holding the shared COTS parts. FrameCAD
   * mirrors it into the project's `COTS/` subfolder on open + sync. The
   * Drive equivalent of cotsRepoUrl/cotsBranch above.
   */
  cotsDriveFolderId?: string
  cotsSharedDriveId?: string
  /**
   * Set to true when THIS project is itself a COTS library. Disables the
   * part-numbering layer (no parts.json, no auto-assign, no + Part / + Assembly
   * buttons) since COTS files have their own external numbering authority.
   */
  isCotsProject?: boolean
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


/**
 * Save admin settings and propagate them to teammates by uploading admin.json
 * to the project's Drive folder. The whole point of admin config is that it
 * reaches everyone on their next sync.
 */
export async function saveAndPublishAdminConfig(config: AdminConfig): Promise<void> {
  await writeAdminConfig(config)
  await pushSharedFile(relAdminPath(), '[admin] Update settings')
}

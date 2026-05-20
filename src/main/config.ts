import { app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import type { ProjectConfig } from '@shared/types'

const CONFIG_FILE = 'framecad-app.json'
const LEGACY_CONFIG_FILE = 'trentcad-app.json'

// One-shot rename of the userData app-config file from the legacy
// trentcad-app.json to framecad-app.json. Runs lazily on first read.
// Stored as a Promise (not a boolean flag) so concurrent readConfig
// calls await the SAME migration attempt instead of racing into two
// fs.rename() calls — the second of which would error because the
// first already moved the file. Once the promise settles, the cached
// result lets every subsequent reader return immediately.
let legacyConfigMigration: Promise<void> | null = null
function migrateLegacyConfigFile(): Promise<void> {
  if (legacyConfigMigration) return legacyConfigMigration
  legacyConfigMigration = (async () => {
    const newPath = path.join(app.getPath('userData'), CONFIG_FILE)
    const oldPath = path.join(app.getPath('userData'), LEGACY_CONFIG_FILE)
    try {
      await fs.access(newPath)
      return
    } catch { /* new file absent — try the rename */ }
    try {
      await fs.rename(oldPath, newPath)
    } catch { /* old file absent or rename failed; harmless */ }
  })()
  return legacyConfigMigration
}

/**
 * Collapse a project path to a single canonical form so we can compare
 * and dedupe entries without slash-style or trailing-separator skew.
 * Same path opened from a backslash dialog vs a forward-slash URL vs a
 * trailing-slash join now collapses to one entry.
 *
 * - Replaces all separators with the OS-native style via path.normalize
 *   (on win32 this also converts forward slashes to backslashes).
 * - Strips trailing separators except when the path is a Windows drive
 *   root ("C:\") or POSIX root ("/").
 * - On Windows, uppercases the drive letter so "c:\" and "C:\" match,
 *   matching how Windows itself treats them.
 */
export function canonPath(p: string): string {
  if (!p) return p
  let norm = path.normalize(p)
  // Trim trailing separators except for roots
  while (norm.length > 1 && (norm.endsWith(path.sep) || norm.endsWith('/'))) {
    if (process.platform === 'win32' && /^[A-Za-z]:\\$/.test(norm)) break
    norm = norm.slice(0, -1)
  }
  if (process.platform === 'win32' && /^[a-z]:/.test(norm)) {
    norm = norm[0].toUpperCase() + norm.slice(1)
  }
  return norm
}

interface AppConfig {
  recentProjects: ProjectConfig[]
  /**
   * Cached GitHub org + project prefix from the last project's admin.json.
   * Mirrored to userData so the welcome screen (where no project is open)
   * can still show the Browse Projects button.
   */
  cachedBrowseConfig?: {
    gitHubOrg?: string
    projectPrefix?: string
  }
  coordinationRepoUrl?: string
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

async function readConfig(): Promise<AppConfig> {
  await migrateLegacyConfigFile()
  try {
    const data = await fs.readFile(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(data) as AppConfig
    // Migrate-on-read: canonicalize every recent path and merge any
    // duplicates that the old comparator missed (e.g. forward-slash and
    // backslash variants of the same project). First occurrence wins
    // since recentProjects is ordered most-recent-first.
    if (Array.isArray(parsed.recentProjects)) {
      const seen = new Set<string>()
      const cleaned: ProjectConfig[] = []
      for (const p of parsed.recentProjects) {
        const canon = canonPath(p.path)
        if (seen.has(canon)) continue
        seen.add(canon)
        cleaned.push({ ...p, path: canon })
      }
      parsed.recentProjects = cleaned
    } else {
      parsed.recentProjects = []
    }
    return parsed
  } catch {
    return { recentProjects: [] }
  }
}

async function writeConfig(config: AppConfig): Promise<void> {
  await fs.writeFile(getConfigPath(), JSON.stringify(config, null, 2))
}

export async function addRecentProject(project: ProjectConfig): Promise<void> {
  const config = await readConfig()
  const canonProject: ProjectConfig = { ...project, path: canonPath(project.path) }
  const existing = config.recentProjects.find(p => p.path === canonProject.path)
  const merged: ProjectConfig = { ...canonProject, pinned: existing?.pinned ?? canonProject.pinned }
  config.recentProjects = config.recentProjects.filter(p => p.path !== canonProject.path)
  config.recentProjects.unshift(merged)
  // Cap unpinned entries at 10. Pinned entries are kept regardless so
  // the team's go-to projects don't age out.
  const pinned = config.recentProjects.filter(p => p.pinned)
  const unpinned = config.recentProjects.filter(p => !p.pinned).slice(0, 10)
  config.recentProjects = [...pinned, ...unpinned]
  await writeConfig(config)
}

export async function setProjectPinned(targetPath: string, pinned: boolean): Promise<void> {
  const config = await readConfig()
  const canon = canonPath(targetPath)
  const entry = config.recentProjects.find(p => p.path === canon)
  if (!entry) return
  entry.pinned = pinned || undefined
  await writeConfig(config)
}

export async function removeRecentProject(targetPath: string): Promise<void> {
  const config = await readConfig()
  const canon = canonPath(targetPath)
  config.recentProjects = config.recentProjects.filter(p => p.path !== canon)
  await writeConfig(config)
}

export async function getRecentProjects(): Promise<ProjectConfig[]> {
  const config = await readConfig()
  return config.recentProjects
}

export async function setCachedBrowseConfig(
  org?: string,
  prefix?: string
): Promise<void> {
  const config = await readConfig()
  config.cachedBrowseConfig = {
    gitHubOrg: org?.trim() || undefined,
    projectPrefix: prefix?.trim() || undefined
  }
  await writeConfig(config)
}

export async function getCachedBrowseConfig(): Promise<{ gitHubOrg?: string; projectPrefix?: string }> {
  const config = await readConfig()
  return config.cachedBrowseConfig || {}
}

export async function getCoordinationRepoUrl(): Promise<string | undefined> {
  const config = await readConfig()
  return config.coordinationRepoUrl
}

export async function setCoordinationRepoUrl(url: string | undefined): Promise<void> {
  const config = await readConfig()
  config.coordinationRepoUrl = url || undefined
  await writeConfig(config)
}

import { app } from 'electron'
import path from 'path'
import { promises as fs } from 'fs'

declare const __FRAMECAD_DEFAULT_GITHUB_ORG__: string
declare const __FRAMECAD_DEFAULT_PROJECT_PREFIX__: string
declare const __FRAMECAD_DEFAULT_TEAM_NAME__: string
declare const __FRAMECAD_DEFAULT_WELCOME_MESSAGE__: string
declare const __FRAMECAD_DEFAULT_SERVER_URL__: string

export interface GlobalAdminConfig {
  teamName?: string
  welcomeMessage?: string
  gitHubOrg?: string
  projectPrefix?: string
  /** Pre-baked team-server URL. When set, the enrollment wizard
   *  uses this as the fallback server URL if the user pastes a
   *  bare PIN (no full link). Build-time only — set via
   *  FRAMECAD_DEFAULT_SERVER_URL env var before packaging; users
   *  cannot override it locally. */
  defaultServerUrl?: string
}

export interface GlobalAdminState {
  /** The values the app should actually use right now (local override ?? build default). */
  effective: GlobalAdminConfig
  /** Pure build-time defaults baked in from GH Actions secrets — useful for "Reset" UX. */
  defaults: GlobalAdminConfig
  /** Whether the user has a locally-saved override file at all. */
  hasLocalOverride: boolean
}

const LOCAL_FILE = 'global-admin.json'

function pick(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return undefined
  const t = s.trim()
  return t.length > 0 ? t : undefined
}

function readDefine(name: string, val: string | undefined): string | undefined {
  // The Vite `define` plugin replaces the IDENTIFIER textually. If for any
  // reason the substitution didn't happen, `typeof` falls back to undefined
  // so we don't crash with a ReferenceError.
  try {
    return pick(val)
  } catch {
    return undefined
  }
}

function buildDefaults(): GlobalAdminConfig {
  return {
    gitHubOrg: readDefine('GH_ORG',
      typeof __FRAMECAD_DEFAULT_GITHUB_ORG__ !== 'undefined' ? __FRAMECAD_DEFAULT_GITHUB_ORG__ : undefined),
    projectPrefix: readDefine('PREFIX',
      typeof __FRAMECAD_DEFAULT_PROJECT_PREFIX__ !== 'undefined' ? __FRAMECAD_DEFAULT_PROJECT_PREFIX__ : undefined),
    teamName: readDefine('TEAM',
      typeof __FRAMECAD_DEFAULT_TEAM_NAME__ !== 'undefined' ? __FRAMECAD_DEFAULT_TEAM_NAME__ : undefined),
    welcomeMessage: readDefine('WELCOME',
      typeof __FRAMECAD_DEFAULT_WELCOME_MESSAGE__ !== 'undefined' ? __FRAMECAD_DEFAULT_WELCOME_MESSAGE__ : undefined),
    defaultServerUrl: readDefine('SERVER_URL',
      typeof __FRAMECAD_DEFAULT_SERVER_URL__ !== 'undefined' ? __FRAMECAD_DEFAULT_SERVER_URL__ : undefined),
  }
}

function localPath(): string {
  return path.join(app.getPath('userData'), LOCAL_FILE)
}

async function readLocal(): Promise<GlobalAdminConfig | null> {
  try {
    const raw = await fs.readFile(localPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Coerce only the four known fields — ignore anything else
    return {
      teamName: typeof parsed.teamName === 'string' ? parsed.teamName : undefined,
      welcomeMessage: typeof parsed.welcomeMessage === 'string' ? parsed.welcomeMessage : undefined,
      gitHubOrg: typeof parsed.gitHubOrg === 'string' ? parsed.gitHubOrg : undefined,
      projectPrefix: typeof parsed.projectPrefix === 'string' ? parsed.projectPrefix : undefined,
    }
  } catch {
    return null
  }
}

async function writeLocal(config: GlobalAdminConfig): Promise<void> {
  const dir = path.dirname(localPath())
  await fs.mkdir(dir, { recursive: true })
  // Keep only string-valued, non-empty fields so the file stays minimal
  const cleaned: GlobalAdminConfig = {}
  if (pick(config.teamName)) cleaned.teamName = config.teamName!.trim()
  if (pick(config.welcomeMessage)) cleaned.welcomeMessage = config.welcomeMessage!.trim()
  if (pick(config.gitHubOrg)) cleaned.gitHubOrg = config.gitHubOrg!.trim()
  if (pick(config.projectPrefix)) cleaned.projectPrefix = config.projectPrefix!.trim()
  await fs.writeFile(localPath(), JSON.stringify(cleaned, null, 2) + '\n', 'utf-8')
}

async function deleteLocal(): Promise<void> {
  try {
    await fs.unlink(localPath())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Merge local overrides on top of build-time defaults. A locally-set
 * field wins; an absent local field falls through to the default.
 */
function merge(defaults: GlobalAdminConfig, local: GlobalAdminConfig | null): GlobalAdminConfig {
  if (!local) return { ...defaults }
  return {
    teamName: pick(local.teamName) ?? defaults.teamName,
    welcomeMessage: pick(local.welcomeMessage) ?? defaults.welcomeMessage,
    gitHubOrg: pick(local.gitHubOrg) ?? defaults.gitHubOrg,
    projectPrefix: pick(local.projectPrefix) ?? defaults.projectPrefix,
    // defaultServerUrl is build-time only — local overrides aren't
    // accepted (writeLocal doesn't persist it either) so the bake
    // never gets accidentally clobbered by a settings-page toggle.
    defaultServerUrl: defaults.defaultServerUrl,
  }
}

export async function getGlobalAdminState(): Promise<GlobalAdminState> {
  const defaults = buildDefaults()
  const local = await readLocal()
  return {
    effective: merge(defaults, local),
    defaults,
    hasLocalOverride: local !== null,
  }
}

export async function getEffectiveGlobalAdmin(): Promise<GlobalAdminConfig> {
  const state = await getGlobalAdminState()
  return state.effective
}

export async function saveGlobalAdmin(config: GlobalAdminConfig): Promise<void> {
  await writeLocal(config)
}

export async function resetGlobalAdmin(): Promise<void> {
  await deleteLocal()
}

/**
 * If the user upgraded from v0.7 (which mirrored gitHubOrg / projectPrefix
 * to userData as `cachedBrowseConfig`) and they don't yet have a local
 * override file, seed the override file from the cached values so the
 * Browse Projects button keeps working out of the box.
 */
export async function migrateFromCachedBrowseConfig(
  cached: { gitHubOrg?: string; projectPrefix?: string }
): Promise<void> {
  const existing = await readLocal()
  if (existing) return
  if (!pick(cached.gitHubOrg) && !pick(cached.projectPrefix)) return
  await writeLocal({
    gitHubOrg: cached.gitHubOrg,
    projectPrefix: cached.projectPrefix,
  })
}

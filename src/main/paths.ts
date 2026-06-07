/**
 * Path translation between the user-visible project root and the
 * actual git repo root.
 *
 * Some teams keep multiple projects in a single git repo — e.g. the
 * 2026 robot lives at `2026 Rebuilt/`, with `COTS/` and last year's
 * archive as siblings at the repo root. FrameCAD has historically
 * assumed those two folders were one and the same, so the file tree
 * showed every sibling and new parts dropped into whatever folder
 * happened to be selected. The project subpath fixes that:
 *
 * - `gitRoot` is the directory containing `.git/` (what simple-git is
 *   pointed at, where `parts.json` lives).
 *
 * - `projectSubpath` is a posix-style relative path INSIDE the repo
 *   that the user wants to treat as the project root. Empty when the
 *   repo and project are the same folder (the default and the only
 *   pre-existing behaviour).
 *
 * - `cotsSubpath` is a sibling subfolder to hide from project views
 *   even when no project subpath is set. Mutually exclusive with the
 *   "COTS lives in a separate repo" flow already supported by AdminConfig.
 *
 * Callers that hand-off paths between the renderer/REST surface and
 * git/LFS use {@link toGitRel} / {@link toProjectRel}. Everything else
 * (parts.json keys, parts-meta.json keys, status fetches, etc.) stays
 * keyed by repo-relative paths; the translation layer is purely about
 * presenting a clean "this is the project root" illusion to the user.
 *
 * Cache shape: module-scoped so we don't async-load admin.json on
 * every chokidar event. {@link setProjectSubpath} / {@link setCotsSubpath}
 * are called from the project-open flow and from the admin-config
 * save handler so the cache stays current.
 */

let currentSubpath = ''
let currentCotsSubpath = ''

function normaliseSubpath(value: string | null | undefined): string {
  if (!value) return ''
  // Strip leading / trailing slashes (forward or back), and convert
  // any backslashes to forward slashes so the cache is canonical.
  // Repo-rooted paths everywhere else in main are posix-style.
  return value
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim()
}

export function getProjectSubpath(): string {
  return currentSubpath
}

export function getCotsSubpath(): string {
  return currentCotsSubpath
}

/**
 * Update the project-subpath cache. Called from the project-open
 * flow after reading admin.json, and from the saveAdminConfig
 * handler so a live edit takes effect without restarting.
 */
export function setProjectSubpath(value: string | null | undefined): void {
  currentSubpath = normaliseSubpath(value)
}

export function setCotsSubpath(value: string | null | undefined): void {
  currentCotsSubpath = normaliseSubpath(value)
}

/**
 * Translate a path the renderer / REST API gave us (relative to the
 * project root, which may be a subfolder of the repo) into the
 * canonical repo-relative form used by git, parts.json, etc.
 *
 * Idempotent: if the supplied path already starts with the subpath,
 * it's returned unchanged. That makes the helper safe to apply
 * everywhere without worrying about double-prefixing during
 * migration / edge cases.
 */
export function toGitRel(projectRel: string): string {
  if (!currentSubpath || !projectRel) return projectRel
  const prefix = currentSubpath + '/'
  if (projectRel === currentSubpath || projectRel.startsWith(prefix)) {
    return projectRel
  }
  return prefix + projectRel
}

/**
 * Inverse of {@link toGitRel}. Returns null when the input path
 * lives OUTSIDE the current project subpath — callers can use that
 * signal to filter out e.g. COTS/ entries from the project file
 * tree without an extra startsWith check.
 */
export function toProjectRel(gitRel: string): string | null {
  if (!currentSubpath) {
    // No project subpath — everything is at project root; still
    // hide the COTS subfolder when configured.
    if (currentCotsSubpath && (gitRel === currentCotsSubpath || gitRel.startsWith(currentCotsSubpath + '/'))) {
      return null
    }
    return gitRel
  }
  if (gitRel === currentSubpath) return ''
  const prefix = currentSubpath + '/'
  if (!gitRel.startsWith(prefix)) return null
  return gitRel.slice(prefix.length)
}

/**
 * Reset all cached state. Called from closeProject so a stale subpath
 * from one project doesn't bleed into the next opened project.
 */
export function clearSubpathCache(): void {
  currentSubpath = ''
  currentCotsSubpath = ''
}

/**
 * The on-disk path the SolidWorks add-in (and other localhost API
 * clients) should treat as the project root. When a subpath is set,
 * this is `gitRoot/<subpath>` (OS-native separator via path.join);
 * otherwise just `gitRoot`.
 *
 * The add-in uses this for ToRelativePath / ToAbsolutePath, so giving
 * it the subpath-prefixed root means its existing path-handling logic
 * keeps working without code changes — it'll naturally send subpath-
 * relative paths to the REST API, which then translate at our boundary.
 *
 * Takes `gitRoot` rather than reading from git.ts to avoid a circular
 * import — callers (rest.ts, ipc.ts) already hold the git root.
 */
export function getEffectiveProjectRoot(gitRoot: string): string {
  if (!currentSubpath) return gitRoot
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path')
  return path.join(gitRoot, currentSubpath)
}

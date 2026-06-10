/**
 * Filesystem-name helpers shared by the main process (which actually
 * creates the folders) and the renderer (which previews the path the
 * join flow will create). Keep the two sides using THIS one function —
 * if they sanitize differently, the "will download to" preview lies.
 */

/**
 * Turn a Drive project folder name into a safe local directory name.
 * Strips characters Windows forbids (the strictest of our platforms)
 * plus control chars, collapses whitespace, and trims trailing
 * dots/spaces (illegal on Windows). Returns '' when nothing survives —
 * callers must fall back to something unique (e.g. the Drive folder id).
 */
export function projectDirName(name: string): string {
  return (name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
}

/**
 * The local directory a Drive join will download into: a per-project
 * subfolder of the user's chosen save location, so two projects can
 * never share a folder (shared folders cross-publish each other's
 * files). If the chosen folder is ALREADY named like the project —
 * the user pre-created "C:\framecad\Robot" themselves — use it as-is
 * rather than nesting "Robot\Robot".
 *
 * `sep` defaults to detecting Windows-style paths so the renderer can
 * preview the exact path the main process will create.
 */
export function joinTargetDir(savePath: string, projectName: string, folderId: string, sep?: string): string {
  const dirName = projectDirName(projectName) || folderId
  const s = sep ?? (/^[A-Za-z]:[\\/]/.test(savePath) || savePath.includes('\\') ? '\\' : '/')
  const trimmed = savePath.replace(/[\\/]+$/, '')
  const base = trimmed.split(/[\\/]/).pop() ?? ''
  if (base.toLowerCase() === dirName.toLowerCase()) return trimmed
  return trimmed + s + dirName
}

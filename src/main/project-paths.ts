/**
 * The open project's local directory.
 *
 * Formerly lived in git.ts (alongside the SimpleGit instance). Now that the
 * app is Google-Drive-only, the only shared state the filesystem helpers
 * (parts, metadata, documents, thumbnails) need is the project root path —
 * extracted here so nothing has to import the deleted git module.
 */

let projectPath: string | null = null

/** The open project's directory. Throws if no project is open. */
export function getProjectPath(): string {
  if (!projectPath) throw new Error('No project is open')
  return projectPath
}

/** Point the filesystem helpers at a project directory (called on open/join). */
export function setProjectPath(dirPath: string): void {
  projectPath = dirPath
}

/** Clear the open-project path (called on close). */
export function clearProjectPath(): void {
  projectPath = null
}

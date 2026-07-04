/**
 * Pluggable storage-backend dispatcher.
 *
 * FrameCAD can store a project's bytes in Google Drive (the incumbent) or in a
 * self-hosted Lore VCS server (the experiment). Both satisfy the same
 * `ProjectBackend` lifecycle; `ipc.ts` / `rest.ts` / `persistence.ts` route
 * through here instead of hardcoding `drive-project.*`, so a project's
 * `ProjectConfig.backend` selects the storage at runtime.
 *
 * Locks, publish history, and identity are NOT part of this interface — they
 * live on the team server and are storage-agnostic (keyed by `projectKey()`,
 * which each backend supplies). This layer is purely "where do the bytes go".
 */
import type { FileEntry, ProjectConfig, PublishProgress } from '@shared/types'
import * as driveProject from './drive-project'
import * as loreProject from './lore-project'
import { pullMetadataFile, pushMetadataFile } from './drive'
import * as loreOps from './lore'

/** Options for a backend sync pass. */
export interface SyncOpts {
  /** Project-relative paths whose LOCAL copy is authoritative this pass (never
   *  download/overwrite them) — e.g. `.framecad/parts-meta.json` when a deferred
   *  meta push hasn't landed. Drive honors it; Lore merges tracked files itself. */
  protectPaths?: Set<string>
}

export interface ProjectBackend {
  /** Which storage this backend drives. */
  readonly kind: 'drive' | 'lore'
  isOpen(): boolean
  currentDir(): string | null
  currentConfig(): ProjectConfig | null
  /** Stable per-project key for team-server locks/history. Throws if none open. */
  projectKey(): string
  close(): void
  /** Returns null when `dir` isn't THIS backend's kind of project. */
  open(dir: string): Promise<ProjectConfig | null>
  status(): Promise<FileEntry[]>
  sync(onProgress?: (p: PublishProgress) => void, opts?: SyncOpts): Promise<{ success: boolean; filesUpdated: number; error?: string }>
  publish(onProgress?: (p: PublishProgress) => void): Promise<{ success: boolean; error?: string; changedPaths?: string[] }>
  backup(): Promise<{ success: boolean; path?: string; error?: string; skipped?: string[] }>
  /** Drive-only background pre-upload optimization; a no-op elsewhere. */
  readonly supportsStaging: boolean
  stageFile(relPath: string): Promise<void>
  /** Shared-metadata (parts.json / parts-meta.json / admin.json) sync — see persistence.ts. */
  pullSharedFile(relPath: string): Promise<void>
  pushSharedFile(relPath: string): Promise<void>
}

// Drive adapter: a thin object over drive-project's existing named exports
// (they read a module-level `current`, so no `this` binding is needed).
// Zero changes to drive-project.ts itself.
const driveBackend: ProjectBackend = {
  kind: 'drive',
  isOpen: driveProject.isOpen,
  currentDir: driveProject.currentDir,
  currentConfig: driveProject.currentConfig,
  projectKey() {
    const key = driveProject.currentConfig()?.driveFolderId
    if (!key) throw new Error('No Drive project open (missing Drive folder id)')
    return key
  },
  close: driveProject.close,
  open: driveProject.open,
  status: driveProject.status,
  sync: driveProject.sync,
  publish: driveProject.publish,
  backup: driveProject.backup,
  supportsStaging: true,
  stageFile: driveProject.stageFile,
  async pullSharedFile(relPath) {
    const dir = driveProject.currentDir()
    if (!dir) return
    await pullMetadataFile(dir, relPath)
  },
  async pushSharedFile(relPath) {
    const dir = driveProject.currentDir()
    if (!dir) throw new Error('No project is open')
    await pushMetadataFile(dir, relPath)
  }
}

// Lore adapter. Shared-metadata files are ordinary tracked files in the working
// copy — "pull" comes down with the next sync; "push" just writes locally and
// rides the next publish (Lore commits the whole working tree). For the
// immediacy parts.ts/meta.ts expect, the local write is enough: a teammate sees
// it after their sync, same as any other file. We stage it so a later publish
// always carries it.
const loreBackend: ProjectBackend = {
  kind: 'lore',
  isOpen: loreProject.isOpen,
  currentDir: loreProject.currentDir,
  currentConfig: loreProject.currentConfig,
  projectKey: loreProject.projectKey,
  close: loreProject.close,
  open: loreProject.open,
  status: loreProject.status,
  sync: loreProject.sync,
  publish: loreProject.publish,
  backup: loreProject.backup,
  supportsStaging: false,
  stageFile: loreProject.stageFile,
  async pullSharedFile() {
    // No per-file pull in Lore; shared files arrive with the next sync().
  },
  async pushSharedFile(relPath) {
    const dir = loreProject.currentDir()
    if (!dir) throw new Error('No project is open')
    // Lore has no per-file remote push; staging the working tree ensures the
    // shared file rides the next publish. Do NOT swallow errors — persistence.ts
    // contracts pushSharedFile to throw on failure so the caller can roll back
    // an in-memory reservation.
    await loreOps.stageAll(dir)
    void relPath
  }
}

const BACKENDS: ProjectBackend[] = [loreBackend, driveBackend]

/** Pick a backend by an explicit ProjectConfig (used when opening by config). */
export function getBackendFor(cfg: ProjectConfig | null | undefined): ProjectBackend {
  return cfg?.backend === 'lore' ? loreBackend : driveBackend
}

/**
 * The backend whose project is currently open. Only one project is open at a
 * time, so we return whichever backend reports `isOpen()`; Drive is the
 * harmless default when nothing is open (callers that need a project throw via
 * their own `currentDir()`/`projectKey()` checks).
 */
export function getActiveBackend(): ProjectBackend {
  return BACKENDS.find(b => b.isOpen()) ?? driveBackend
}

/** All backends, for open-project's "try each detector" flow. */
export function allBackends(): ProjectBackend[] {
  return BACKENDS
}

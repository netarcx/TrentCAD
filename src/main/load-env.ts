/**
 * Load a local `.env` into `process.env` at the earliest possible
 * moment — BEFORE any other main-process module evaluates. Several
 * modules (notably `google-auth.ts`) read `process.env.GOOGLE_*` at
 * import time, so this MUST be the very first import in
 * `src/main/index.ts` for those reads to see the values.
 *
 * Dev convenience only: it means you set GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET once in a gitignored `.env` at the repo root
 * instead of re-exporting them into every shell. In a packaged build
 * there's usually no `.env` next to the working directory, so this
 * silently no-ops and the existing `process.env` / build-time values
 * win unchanged.
 *
 * Uses Node's built-in `process.loadEnvFile` (Node 20.6+) — no dotenv
 * dependency. `loadEnvFile` throws if the file is missing, so the call
 * is guarded; a missing or malformed `.env` is a no-op, never a crash.
 * Existing `process.env` values are NOT overwritten by loadEnvFile's
 * default behavior, so a shell `export` still takes precedence.
 */
import path from 'node:path'

function tryLoad(file: string): boolean {
  try {
    // process.loadEnvFile is available on Node 20.6+ (Electron 28+).
    const load = (process as NodeJS.Process & {
      loadEnvFile?: (p?: string) => void
    }).loadEnvFile
    if (typeof load !== 'function') return false
    load(file)
    return true
  } catch {
    // File missing / unreadable / malformed — silently skip.
    return false
  }
}

// Try the current working directory first (where `npm run dev` runs
// from = repo root), then one level up as a fallback for the case
// where the process is launched from a subdirectory.
tryLoad(path.resolve(process.cwd(), '.env')) ||
  tryLoad(path.resolve(process.cwd(), '..', '.env'))

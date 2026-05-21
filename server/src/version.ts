/**
 * Version awareness for the admin UI: what's this server running, what's
 * the latest release on GitHub, and which connected devices are behind?
 *
 * `serverVersion` is baked in at start from `package.json` (synced with
 * the root TrentCAD/FrameCAD project version in CI). `latestVersion` is
 * fetched from the GitHub Releases API the first time it's asked for
 * and then cached for an hour — cheap enough to never block a request,
 * resilient to GitHub being down (we return the cached or null value
 * rather than 500ing).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASES_URL =
  'https://api.github.com/repos/netarcx/framecad/releases/latest'

/** How long a successful GitHub fetch stays fresh before we re-check. */
const CACHE_TTL_MS = 60 * 60 * 1000

interface CacheEntry {
  /** e.g. "3.0.3". Null when the API call failed and we have nothing
   *  cached. The UI renders the latest-version line as "unknown" in
   *  that case rather than pretending everything is up to date. */
  version: string | null
  fetchedAt: number
}

let cache: CacheEntry | null = null
let inflight: Promise<string | null> | null = null

/** The server's own version, read once at module load. */
export const serverVersion: string = readServerVersion()

function readServerVersion(): string {
  try {
    // ESM-safe __dirname. tsx-watch + the compiled dist/ layout both
    // put this file alongside package.json (one directory up after
    // the build), so we resolve relative to the source file.
    const here = path.dirname(fileURLToPath(import.meta.url))
    // Walk up until we find a package.json with name="framecad-server".
    // This survives both `tsx src/version.ts` (here = /server/src) and
    // `node dist/version.js` (here = /server/dist).
    for (const candidate of [
      path.join(here, '..', 'package.json'),
      path.join(here, '..', '..', 'package.json'),
    ]) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: string
          version?: string
        }
        if (pkg.name === 'framecad-server' && pkg.version) return pkg.version
      } catch {
        // try the next candidate
      }
    }
  } catch {
    // fall through to the unknown sentinel
  }
  return '0.0.0'
}

/**
 * Returns the latest GitHub release version (without the leading `v`),
 * or null if we've never successfully fetched it. Refreshes in the
 * background once the cache is stale; never throws.
 */
export async function getLatestReleaseVersion(): Promise<string | null> {
  const now = Date.now()
  const fresh = cache && now - cache.fetchedAt < CACHE_TTL_MS
  if (cache && fresh) return cache.version

  // Coalesce concurrent calls so 5 admin tabs don't fire 5 API calls.
  if (!inflight) {
    inflight = fetchLatestRelease()
      .then(v => {
        cache = { version: v, fetchedAt: Date.now() }
        return v
      })
      .catch(() => {
        // Keep the stale value if we have one — better than flipping
        // to "unknown" on a transient GitHub blip.
        if (cache) cache.fetchedAt = Date.now()
        return cache?.version ?? null
      })
      .finally(() => {
        inflight = null
      })
  }
  // If we have a stale cache, return it immediately and let the
  // refresh continue in the background. First-ever fetch waits.
  if (cache) return cache.version
  return inflight
}

async function fetchLatestRelease(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(RELEASES_URL, {
      headers: {
        'User-Agent': 'framecad-server',
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { tag_name?: string }
    if (!json.tag_name) return null
    return json.tag_name.replace(/^v/i, '')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Strict semver-ish comparator: -1 if a<b, 0 if equal, 1 if a>b.
 * Tolerates missing/short segments ("3.0" treated as "3.0.0") and
 * pre-release suffixes (ignored — "3.0.3-beta" == "3.0.3"). Returns 0
 * for anything we can't parse, which is the conservative choice for
 * the "is outdated?" check: don't nag the user about a version we
 * can't reason about.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string): number[] => {
    const stripped = s.replace(/^v/i, '').split('-')[0]
    const parts = stripped.split('.').map(p => Number.parseInt(p, 10))
    if (parts.some(n => !Number.isFinite(n))) return []
    while (parts.length < 3) parts.push(0)
    return parts
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa.length === 0 || pb.length === 0) return 0
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0
    const bi = pb[i] ?? 0
    if (ai < bi) return -1
    if (ai > bi) return 1
  }
  return 0
}

/** True iff `current` is strictly older than `latest`. Returns false
 *  when either side is unknown/unparseable — same conservative bias. */
export function isOutdated(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false
  return compareVersions(current, latest) < 0
}

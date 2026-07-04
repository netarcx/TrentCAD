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

// The releases LIST, not /releases/latest. `/latest` excludes prereleases and
// drafts by GitHub's definition — and this project ships its builds as
// `1.0.1-rc.N` PRErelease tags, so /latest 404s until a GA release exists,
// leaving `cache.version` null and isOutdated() permanently false (the update
// banner + "outdated clients" list never populate). Fetching the list lets us
// pick the newest published release ourselves, prereleases included.
const RELEASES_URL =
  'https://api.github.com/repos/netarcx/framecad/releases?per_page=30'

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

/** Kick off a background check immediately on import, then repeat
 *  every hour so the cache is always warm — even if no admin ever
 *  opens the dashboard. */
getLatestReleaseVersion().catch(() => {})
setInterval(() => { getLatestReleaseVersion().catch(() => {}) }, CACHE_TTL_MS)

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

async function fetchLatestRelease(): Promise<string> {
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
    // Throw (rather than return null) on any failure so the caller's
    // catch path keeps a previously-good cached version instead of
    // overwriting it with a null marked fresh for the next hour.
    if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`)
    const json = (await res.json()) as Array<{ tag_name?: string; draft?: boolean }>
    if (!Array.isArray(json)) throw new Error('GitHub releases API response was not an array')
    // Consider every non-draft release (prereleases included) and pick the
    // HIGHEST version via the same comparator the outdated check uses — robust
    // against a hotfix to an older line being published after a newer one.
    const versions = json
      .filter(r => r.tag_name && !r.draft)
      .map(r => r.tag_name!.replace(/^v/i, ''))
    if (versions.length === 0) throw new Error('GitHub releases API returned no published releases')
    return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best), versions[0])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Strict semver-ish comparator: -1 if a<b, 0 if equal, 1 if a>b.
 * Tolerates missing/short segments ("3.0" treated as "3.0.0") and
 * compares pre-release suffixes per semver: a release without a suffix
 * is GREATER than one with ("1.0.1" > "1.0.1-rc.5"), and suffixes
 * compare segment-by-segment ("1.0.1-rc.1" < "1.0.1-rc.5"). Returns 0
 * for anything we can't parse, which is the conservative choice for
 * the "is outdated?" check: don't nag the user about a version we
 * can't reason about.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string): { core: number[]; pre: string[] } | null => {
    const stripped = s.replace(/^v/i, '')
    const dash = stripped.indexOf('-')
    const coreStr = dash === -1 ? stripped : stripped.slice(0, dash)
    const pre = dash === -1 ? [] : stripped.slice(dash + 1).split('.')
    const core = coreStr.split('.').map(p => Number.parseInt(p, 10))
    if (core.some(n => !Number.isFinite(n))) return null
    while (core.length < 3) core.push(0)
    return { core, pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const ai = pa.core[i] ?? 0
    const bi = pb.core[i] ?? 0
    if (ai < bi) return -1
    if (ai > bi) return 1
  }
  // Numeric cores equal — pre-release ordering. No suffix outranks any
  // suffix (a final release is newer than its own RCs).
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  // Both pre-releases: compare segment-by-segment. Numeric segments
  // compare numerically and rank below alphanumeric ones; otherwise
  // lexical. A longer suffix wins when all shared segments tie
  // ("rc.1.1" > "rc.1") — standard semver rules.
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const as = pa.pre[i]
    const bs = pb.pre[i]
    if (as === undefined) return -1
    if (bs === undefined) return 1
    const an = /^\d+$/.test(as) ? Number.parseInt(as, 10) : null
    const bn = /^\d+$/.test(bs) ? Number.parseInt(bs, 10) : null
    if (an !== null && bn !== null) {
      if (an < bn) return -1
      if (an > bn) return 1
    } else if (an !== null) {
      return -1
    } else if (bn !== null) {
      return 1
    } else {
      if (as < bs) return -1
      if (as > bs) return 1
    }
  }
  return 0
}

/** True iff `current` is strictly older than `latest`. Returns false
 *  when either side is unknown/unparseable — same conservative bias. */
export function isOutdated(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false
  return compareVersions(current, latest) < 0
}

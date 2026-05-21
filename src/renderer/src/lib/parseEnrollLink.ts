/**
 * Parse an enrollment input from the user. Accepts:
 *
 *   - A full enrollment URL like `http://server-host:42130/enroll/ABCDEF`
 *     (the primary format — admin Pins page generates this).
 *   - A bare 6-character PIN (e.g. `ABCDEF`), if a non-empty
 *     `defaultServerUrl` is provided. That URL typically comes from
 *     the FRAMECAD_DEFAULT_SERVER_URL build-time env var via
 *     `globalAdmin.defaultServerUrl`.
 *
 * Returns null for anything else — random text, malformed URLs,
 * PINs with wrong-alphabet characters, etc.
 *
 * The PIN alphabet matches what the server's auth.ts `generatePin()`
 * actually issues (`A-Z` minus `I/O`, `2-9` — no `0/1`). Strict
 * matching on the client prevents typos from looking valid until
 * the network call fails.
 */

/** Characters the server's PIN generator uses. Excludes confusable
 *  glyphs `0/1/I/O`. */
const PIN_CHARS = '[A-HJ-NP-Z2-9]'
const PIN_REGEX = new RegExp(`^${PIN_CHARS}{6}$`, 'i')
const PIN_IN_PATH_REGEX = new RegExp(`/enroll/(${PIN_CHARS}{6})/?$`, 'i')

export interface EnrollLinkParts {
  serverUrl: string
  pin: string
}

export function parseEnrollLink(
  input: string,
  defaultServerUrl?: string,
): EnrollLinkParts | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // 1) Try as a full URL first. `new URL()` will throw on plain
  //    text or things like `ABCDEF` — that's the signal to fall
  //    through to the bare-PIN branch below.
  try {
    const url = new URL(trimmed)
    const m = url.pathname.match(PIN_IN_PATH_REGEX)
    if (m) {
      return {
        serverUrl: `${url.protocol}//${url.host}`,
        pin: m[1].toUpperCase(),
      }
    }
    // Looked like a URL but didn't have the `/enroll/<PIN>` shape.
    // Fall through — could still be a PIN that happens to be a
    // valid URL string (unlikely, but cheap to handle).
  } catch { /* not a URL — try bare-PIN branch */ }

  // 2) Bare PIN. Only succeeds when we have a default server URL
  //    baked in. Otherwise the caller surfaces a hint asking for
  //    the full link.
  if (PIN_REGEX.test(trimmed)) {
    const url = (defaultServerUrl ?? '').trim().replace(/\/+$/, '')
    if (!url) return null
    return { serverUrl: url, pin: trimmed.toUpperCase() }
  }

  return null
}

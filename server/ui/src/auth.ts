/**
 * Token + member-info storage for the admin UI.
 *
 * Two storage modes:
 *  - **sessionStorage** (default): token cleared the moment the browser
 *    tab closes. Right behaviour for a shared computer or quick
 *    "I'm just checking on my phone" session.
 *  - **localStorage** ("Stay signed in" checkbox at login): token
 *    survives browser restarts; server-side a `kind='web'` device
 *    row still expires 30 days from last use.
 *
 * On read we check sessionStorage first, then fall through to
 * localStorage so the precedence matches what the user picked at
 * sign-in time (sessionStorage wins because the user EXPLICITLY
 * chose ephemeral by leaving the checkbox unchecked).
 *
 * If the admin's device is revoked from elsewhere (or the 30-day
 * web-session expiry fires), the next API call returns 401 and the
 * App-level handler kicks them back to /sign-in.
 */

const TOKEN_KEY = 'framecad-server.token'
const MEMBER_KEY = 'framecad-server.member'

export type Role = 'admin' | 'mentor' | 'student'

export interface AuthedMember {
  id: number
  displayName: string
  githubUsername: string | null
  role: Role
}

function readBoth(key: string): string | null {
  try {
    const s = sessionStorage.getItem(key)
    if (s !== null) return s
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function clearBoth(key: string): void {
  try { sessionStorage.removeItem(key) } catch { /* ignore */ }
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

export function getToken(): string | null {
  return readBoth(TOKEN_KEY)
}

export function getMember(): AuthedMember | null {
  const raw = readBoth(MEMBER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthedMember
  } catch {
    return null
  }
}

/**
 * Persist the session.
 *
 * @param persist when false (default), the token lives in
 *   sessionStorage and is gone on browser close. When true ("Stay
 *   signed in"), it lands in localStorage and survives restarts. We
 *   always clear the opposite storage so a user who toggled their
 *   preference doesn't carry forward stale state from a prior
 *   sign-in.
 */
export function setSession(token: string, member: AuthedMember, persist = false): void {
  clearBoth(TOKEN_KEY)
  clearBoth(MEMBER_KEY)
  const storage: Storage = persist ? localStorage : sessionStorage
  try {
    storage.setItem(TOKEN_KEY, token)
    storage.setItem(MEMBER_KEY, JSON.stringify(member))
  } catch { /* private mode etc. — fall through; subsequent API calls 401 */ }
}

export function clearSession(): void {
  clearBoth(TOKEN_KEY)
  clearBoth(MEMBER_KEY)
}

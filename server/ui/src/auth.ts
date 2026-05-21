/**
 * Token + member-info storage for the admin UI.
 *
 * The admin enrolls a browser session the same way a desktop client
 * does — POST /api/enroll with a PIN. The server returns a bearer
 * token + member info; we stash both in localStorage so a page
 * refresh doesn't bounce the admin back to the sign-in screen.
 *
 * No refresh tokens. If the admin's device is revoked from elsewhere,
 * the next API call returns 401 and the App-level handler kicks them
 * back to /sign-in.
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

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function getMember(): AuthedMember | null {
  try {
    const raw = localStorage.getItem(MEMBER_KEY)
    return raw ? JSON.parse(raw) as AuthedMember : null
  } catch { return null }
}

export function setSession(token: string, member: AuthedMember): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(MEMBER_KEY, JSON.stringify(member))
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(MEMBER_KEY)
}

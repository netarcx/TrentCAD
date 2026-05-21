/**
 * Tiny fetch wrapper for the admin UI.
 *
 * Every call goes through {@link api} which:
 *   - prepends the API base ('' in production, '/api/...' goes to same
 *     origin; in `vite dev` the proxy in vite.config.ts forwards to
 *     127.0.0.1:42130)
 *   - attaches `Authorization: Bearer <token>` from {@link getToken}
 *   - parses JSON, throws on non-2xx so callers can `try/catch`
 *
 * Errors carry an HTTP status + the server's `error` field where the
 * server sent one, so handlers can render them cleanly.
 */

import { clearSession, getToken } from './auth'

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  let data: unknown = null
  try { data = await res.json() } catch { /* empty / non-JSON */ }

  if (!res.ok) {
    const message = (data && typeof data === 'object' && 'error' in data
      ? String((data as { error: unknown }).error)
      : null) ?? `${method} ${path} failed (${res.status})`
    // 401 on any authed call means the server revoked our session or
    // the token expired (30-day web-session TTL). Centralise the
    // recovery here so every page doesn't need its own redirect
    // logic — clear stored tokens and bounce to the sign-in page.
    // Skip the redirect for the /api/login + /api/enroll calls
    // themselves (a wrong password is also a 401 but we want the
    // SignIn page to display its inline error, not re-route).
    const isLoginAttempt = path === '/api/login' || path === '/api/enroll'
    if (res.status === 401 && !isLoginAttempt) {
      clearSession()
      // Hard redirect rather than React router so any cached
      // component state (member identity, in-progress forms) is
      // wiped — we have no idea which identity to render for.
      if (typeof window !== 'undefined' && !window.location.hash.startsWith('#/sign-in')) {
        window.location.hash = '#/sign-in'
      }
    }
    throw new ApiError(res.status, message, data)
  }

  return data as T
}

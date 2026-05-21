/**
 * Self-hosted Git-LFS auth.
 *
 * The Docker Compose stack ships a Giftless container alongside this
 * server (see `docker-compose.yml`). Giftless stores LFS objects on a
 * bind-mounted directory and validates incoming requests with a JWT
 * signed by THIS server. Same shared secret on both sides; nobody
 * outside the compose stack can mint a valid token.
 *
 * The desktop client calls `POST /api/lfs/token` on every LFS
 * operation, gets a short-lived JWT, and attaches it as
 * `Authorization: Bearer <jwt>` to the LFS request. Tokens are
 * deliberately short-lived (15 min) so a stolen one is useless
 * within a class period.
 *
 * Why not jose / jsonwebtoken: we only ever sign, never verify (the
 * Giftless container handles verification on its own). HS256 is just
 * an HMAC over a base64url-encoded header + payload, which is ~30
 * lines using node:crypto. Adding a 100-package transitive dep tree
 * for that math isn't worth it.
 */

import { createHmac } from 'node:crypto'
import { config } from './config.js'

/** Lifetime of a minted LFS token. Long enough that a single `git lfs
 *  push` of a big assembly finishes inside the window, short enough
 *  that a stolen token is useless once the period ends. */
const TOKEN_TTL_SECONDS = 15 * 60

/** True iff the operator wired LFS up via env vars. When false, the
 *  /api/lfs/* routes return 503 instead of pretending to work — better
 *  than silently issuing tokens against a default secret. */
export function lfsEnabled(): boolean {
  return !!(config.lfsJwtSecret && config.lfsServerUrl)
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/**
 * Mint a JWT for the given member to talk to the LFS server.
 *
 * Claims follow Giftless's expected shape (subject, name, scopes):
 *   - `sub`  member id, useful for the LFS server's audit log
 *   - `name` display name, same reason
 *   - `scopes` array — `obj:verify`, `obj:read`, `obj:write`. We
 *     hand out all three; per-project read-only access is gated at
 *     the team-server level (the project allowlist), not here.
 *
 * Throws if LFS isn't configured — the caller (the route) should
 * have already returned 503 in that case.
 */
export function mintLfsToken(args: {
  memberId: number
  displayName: string
}): { token: string; expiresAt: number } {
  if (!config.lfsJwtSecret) {
    throw new Error('LFS_JWT_SECRET is not configured')
  }
  const now = Math.floor(Date.now() / 1000)
  const exp = now + TOKEN_TTL_SECONDS

  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    sub: String(args.memberId),
    name: args.displayName,
    iat: now,
    exp,
    scopes: ['obj:verify', 'obj:read', 'obj:write'],
  }
  const h = base64Url(Buffer.from(JSON.stringify(header)))
  const p = base64Url(Buffer.from(JSON.stringify(payload)))
  const signingInput = `${h}.${p}`
  const sig = base64Url(
    createHmac('sha256', config.lfsJwtSecret).update(signingInput).digest()
  )
  return { token: `${signingInput}.${sig}`, expiresAt: exp * 1000 }
}

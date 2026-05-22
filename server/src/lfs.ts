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

/** Default lifetime of a minted LFS token when the team row has no
 *  override. Tunable per-team via Settings → Limits & Policies →
 *  LFS token TTL (range 5-120 min). Long enough that a single
 *  `git lfs push` of a big assembly finishes inside the window,
 *  short enough that a stolen token is useless once the period
 *  ends. The mint function reads the team value on every call so
 *  changes take effect on the very next token request. */
const DEFAULT_TOKEN_TTL_SECONDS = 15 * 60

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
 * Mint a JWT for the given member to talk to the LFS server, scoped
 * to a single project. The desktop calls this once per project it
 * touches; a token issued for project 7 cannot read or write
 * project 12's objects (giftless validates the URL against the
 * scopes claim).
 *
 * Claims follow Giftless's expected shape:
 *   - `sub`     member id (giftless's audit trail)
 *   - `name`    display name
 *   - `scopes`  list of `<action>:<org>/<repo>` strings. We always
 *               grant `obj:verify` + `obj:read` for the requested
 *               project; `obj:write` is dropped when `writable` is
 *               false (quota exceeded), which is how the read-only
 *               degraded mode works — clients can still pull, just
 *               can't push.
 *
 * Throws if LFS isn't configured — the caller (the route) should
 * have already returned 503 in that case.
 */
export function mintLfsToken(args: {
  memberId: number
  displayName: string
  projectId: number
  writable: boolean
}): { token: string; expiresAt: number } {
  if (!config.lfsJwtSecret) {
    throw new Error('LFS_JWT_SECRET is not configured')
  }
  // Read the team's tunable TTL each call so an admin tweak in
  // Settings → Policies takes effect on the very next token request,
  // no server restart needed. Lazy-import db.ts to avoid a circular
  // dep at module init.
  let ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('./db.js') as typeof import('./db.js')
    const row = getDb().prepare(
      `SELECT lfsTokenTtlMinutes FROM team WHERE id = 1`
    ).get() as { lfsTokenTtlMinutes: number | null } | undefined
    if (row?.lfsTokenTtlMinutes && row.lfsTokenTtlMinutes >= 5 && row.lfsTokenTtlMinutes <= 120) {
      ttlSeconds = row.lfsTokenTtlMinutes * 60
    }
  } catch { /* migration not run yet — use default */ }
  const now = Math.floor(Date.now() / 1000)
  const exp = now + ttlSeconds

  // Project scope must match the URL prefix the desktop will hit on
  // giftless: <lfs-url>/framecad/<id>/... Giftless reads the path as
  // `org/repo` and checks the scopes claim contains a matching entry.
  const scopeTarget = `framecad/${args.projectId}`
  const scopes = [
    `obj:verify:${scopeTarget}`,
    `obj:read:${scopeTarget}`,
    ...(args.writable ? [`obj:write:${scopeTarget}`] : []),
  ]

  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    sub: String(args.memberId),
    name: args.displayName,
    iat: now,
    exp,
    scopes,
  }
  const h = base64Url(Buffer.from(JSON.stringify(header)))
  const p = base64Url(Buffer.from(JSON.stringify(payload)))
  const signingInput = `${h}.${p}`
  const sig = base64Url(
    createHmac('sha256', config.lfsJwtSecret).update(signingInput).digest()
  )
  return { token: `${signingInput}.${sig}`, expiresAt: exp * 1000 }
}

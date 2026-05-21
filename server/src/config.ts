/**
 * Process-wide configuration. Everything pulls from env vars with
 * sensible single-team defaults so a fresh `docker run` works out of
 * the box on someone's Pi.
 *
 * Intentionally simple — there's no .env file loader. Operators set
 * env vars via Docker / their systemd unit / Unraid template.
 */

import path from 'node:path'

function num(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  /** TCP port to listen on. 42130 by convention (FrameCAD desktop uses
   *  42129; this is its sibling). */
  port: num(process.env.PORT, 42130),

  /** Bind address. Default 0.0.0.0 because the server lives on a LAN
   *  by design — operators wrap it in a reverse proxy if they want
   *  to expose it further. */
  host: process.env.HOST || '0.0.0.0',

  /** Where SQLite + setup-PIN file + audit logs land. Inside the
   *  Docker container this is a mounted volume; for `npm run dev`
   *  it defaults to ./data so we don't pollute the home dir. */
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),

  /** Log level — passed through to Fastify's pino. Quiet by default
   *  during dev so the setup-PIN banner stands out. */
  logLevel: process.env.LOG_LEVEL || 'info',

  /** Shared HMAC secret used to sign JWTs handed to enrolled desktops
   *  for talking to the self-hosted LFS server (Giftless). The exact
   *  same value goes into the giftless config so the two ends agree
   *  on signatures. When null, /api/lfs/* returns 503 — better than
   *  pretending LFS is set up. Set via env: LFS_JWT_SECRET. */
  lfsJwtSecret: process.env.LFS_JWT_SECRET || null,

  /** Public-facing URL of the LFS server (Giftless). Handed to the
   *  desktop client so it knows where to point `.lfsconfig`. Include
   *  the scheme and any path prefix Giftless is mounted at. For the
   *  default docker-compose layout this is `http://<host>:42131`.
   *  Set via env: LFS_SERVER_URL. */
  lfsServerUrl: process.env.LFS_SERVER_URL || null,
} as const

export type AppConfig = typeof config

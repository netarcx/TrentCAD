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

function bool(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
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

  /** Optional Discord/Slack incoming-webhook URL. When set, each in-app
   *  problem report (POST /api/issues) is best-effort forwarded here so a
   *  mentor sees it in chat without opening the admin UI. Blank = disabled;
   *  reports still land in the admin Reports page either way. */
  issueWebhookUrl: process.env.FRAMECAD_ISSUE_WEBHOOK_URL || '',

  /** Trust `X-Forwarded-For` when fronted by a reverse proxy. OFF by default
   *  so a direct-LAN deployment doesn't trust a spoofable header. Turn ON
   *  (TRUST_PROXY=1) ONLY when the server sits behind a trusted proxy
   *  (nginx/Caddy) — otherwise every request appears to come from the proxy's
   *  single IP, collapsing the per-IP enroll + login brute-force throttles (20
   *  fumbled PINs from anyone would lock out the whole team, and an attacker
   *  who knows an admin username could trip the 5-fail lock on the real admin). */
  trustProxy: bool(process.env.TRUST_PROXY),
} as const

export type AppConfig = typeof config

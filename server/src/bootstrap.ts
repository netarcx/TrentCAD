/**
 * First-launch bootstrap.
 *
 * The very first time the server starts (and any subsequent start
 * where no admin device has been minted yet), we generate a single
 * admin-tier PIN and print it loudly. The operator pastes it into
 * FrameCAD desktop to claim admin. After that first claim, the PIN
 * is consumed and this function becomes a no-op forever.
 *
 * We also write the PIN to `data/SETUP_PIN.txt` so an operator who
 * misses the stdout banner (e.g. ran the container detached and
 * didn't tail logs) can still find it.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { getDb } from './db.js'
import { issuePin, type IssuedPin } from './auth.js'
import { parseCapabilities, parseAllowedProjectIds } from './db.js'
import { config } from './config.js'

/**
 * Run once at startup, after `migrate()`.
 *
 * - If an admin device already exists → noop.
 * - If an admin member exists but no devices yet → keep any existing
 *   un-consumed admin setup PIN, otherwise issue a fresh one.
 * - Otherwise (fresh DB) → issue a fresh setup PIN.
 */
export async function maybeBootstrapAdminPin(log: FastifyBaseLogger): Promise<IssuedPin | null> {
  const db = getDb()

  // Has anyone already enrolled an admin device? If so we're done.
  const existingAdminDevice = db.prepare(
    `SELECT 1
       FROM devices d
       JOIN members m ON m.id = d.memberId
      WHERE m.role = 'admin' AND m.status = 'active'
      LIMIT 1`
  ).get()
  if (existingAdminDevice) return null

  // Password login is enough recovery for a claimed admin account. Do not
  // re-open the weaker setup-PIN path just because all web/desktop sessions
  // were revoked or expired.
  const existingPasswordAdmin = db.prepare(
    `SELECT 1
       FROM members
      WHERE role = 'admin' AND status = 'active'
        AND passwordHash IS NOT NULL AND username IS NOT NULL
      LIMIT 1`
  ).get()
  if (existingPasswordAdmin) return null

  // Maybe a setup PIN from a previous boot is still hanging around.
  // Reuse it so a restart doesn't constantly print new PINs at the operator.
  const pendingAdminPin = db.prepare(
    `SELECT code, role, expiresAt, capabilities, allowedProjectIds,
            autoOpenProjectId, kioskMode, archiveMode, maxUses
       FROM pins
      WHERE role = 'admin' AND useCount < maxUses
        AND (expiresAt IS NULL OR expiresAt > ?)
      ORDER BY createdAt DESC
      LIMIT 1`
  ).get(Date.now()) as {
    code: string
    role: 'admin'
    expiresAt: number | null
    capabilities: string | null
    allowedProjectIds: string | null
    autoOpenProjectId: number | null
    kioskMode: number
    archiveMode: number
    maxUses: number
  } | undefined

  const pin: IssuedPin = pendingAdminPin
    ? {
        code: pendingAdminPin.code,
        role: pendingAdminPin.role,
        expiresAt: pendingAdminPin.expiresAt,
        capabilities: parseCapabilities(pendingAdminPin.capabilities),
        allowedProjectIds: parseAllowedProjectIds(pendingAdminPin.allowedProjectIds),
        autoOpenProjectId: pendingAdminPin.autoOpenProjectId,
        kioskMode: pendingAdminPin.kioskMode === 1 && pendingAdminPin.autoOpenProjectId !== null,
        archiveMode: pendingAdminPin.archiveMode === 1,
        maxUses: pendingAdminPin.maxUses,
      }
    : issuePin({ role: 'admin', createdBy: null, ttlMs: null, maxUses: 1 })

  await fs.writeFile(
    path.join(config.dataDir, 'SETUP_PIN.txt'),
    [
      'FrameCAD Team Server — first-launch admin PIN',
      '',
      `PIN:        ${pin.code}`,
      `Expires:    ${pin.expiresAt ? new Date(pin.expiresAt).toISOString() : 'never (single-use)'}`,
      '',
      'Open FrameCAD desktop on your machine. Click "Enroll with team server",',
      `enter your server URL (e.g. http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}),`,
      'paste the PIN above, and click Enroll. The PIN will burn the moment',
      'it succeeds — keep this file safe until you have confirmed admin access.',
      '',
      'If you lose this PIN before claiming, delete the FrameCAD data directory',
      'and let the server boot fresh.',
      '',
    ].join('\n'),
    'utf-8',
  )

  // Big visible banner so the operator can't miss it.
  const banner = [
    '',
    '======================================================================',
    ' FrameCAD Team Server — first-launch admin PIN',
    '----------------------------------------------------------------------',
    `   PIN:     ${pin.code}`,
    '   Use this to enroll your first admin device in FrameCAD desktop.',
    `   Also saved to: ${path.join(config.dataDir, 'SETUP_PIN.txt')}`,
    '======================================================================',
    '',
  ].join('\n')
  // info-level log so it lands in journalctl / docker logs;
  // use console too so the banner is readable without JSON formatting.
  log.info(banner)
  // eslint-disable-next-line no-console
  console.log(banner)

  return pin
}

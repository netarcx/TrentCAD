/**
 * FrameCAD team server entry point.
 *
 * Boot order:
 *   1. Ensure DATA_DIR exists.
 *   2. Open SQLite + run migrations.
 *   3. Maybe issue the bootstrap admin setup-PIN.
 *   4. Register public / client / admin routes.
 *   5. Listen on config.host:config.port.
 *
 * Anything that throws during boot is fatal — there's no point coming
 * up if SQLite is unreadable or the data dir is read-only.
 */

import { promises as fs } from 'node:fs'
import Fastify from 'fastify'
import { config } from './config.js'
import { migrate } from './db.js'
import { maybeBootstrapAdminPin } from './bootstrap.js'
import { registerPublicRoutes } from './routes/public.js'
import { registerClientRoutes } from './routes/client.js'
import { registerAdminRoutes } from './routes/admin.js'

async function main(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true })
  migrate()

  const app = Fastify({
    logger: { level: config.logLevel },
    disableRequestLogging: false,
  })

  await maybeBootstrapAdminPin(app.log)

  await registerPublicRoutes(app)
  await registerClientRoutes(app)
  await registerAdminRoutes(app)

  try {
    await app.listen({ port: config.port, host: config.host })
    app.log.info(`FrameCAD server listening on http://${config.host}:${config.port}`)
  } catch (err) {
    app.log.error(err, 'Failed to start FrameCAD server')
    process.exit(1)
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('Fatal during boot:', err)
  process.exit(1)
})

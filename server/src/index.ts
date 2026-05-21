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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import staticPlugin from '@fastify/static'
import { config } from './config.js'
import { migrate } from './db.js'
import { maybeBootstrapAdminPin } from './bootstrap.js'
import { registerPublicRoutes } from './routes/public.js'
import { registerClientRoutes } from './routes/client.js'
import { registerAdminRoutes } from './routes/admin.js'

// __dirname under ESM. dist/ui sits as a sibling of dist/index.js
// after `npm run build` (vite.config.ts in ui/ outputs to ../dist/ui),
// so the same path works in `tsx src/index.ts` dev (resolves to
// src/../dist/ui) and in the compiled image (dist/../dist/ui ≡ dist/ui).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.resolve(__dirname, '..', 'dist', 'ui')

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

  // Admin SPA. Served if the built bundle is present; otherwise the
  // root path returns a friendly hint (so tsx-dev without a prior
  // `npm run build:ui` doesn't 404 mysteriously).
  const uiExists = await fs.stat(path.join(UI_DIR, 'index.html')).then(() => true).catch(() => false)
  if (uiExists) {
    await app.register(staticPlugin, {
      root: UI_DIR,
      prefix: '/',
      // We use HashRouter so deep links are #-based; no SPA fallback
      // rewrite needed. Static handler 404s on unknown paths, which
      // is correct for asset URLs.
      wildcard: false,
    })
    app.log.info(`Serving admin UI from ${UI_DIR}`)
  } else {
    app.get('/', async () => ({
      message:
        'FrameCAD team server is up. The admin UI bundle is not built yet — ' +
        'run `npm run build:ui` (or use the Docker image) to enable it.',
    }))
    app.log.warn(`Admin UI bundle not found at ${UI_DIR}; GET / returns a placeholder`)
  }

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

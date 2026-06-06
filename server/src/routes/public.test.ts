import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dataDir = ''
let closeDb: (() => void) | undefined

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'framecad-server-test-'))
  process.env.DATA_DIR = dataDir
  vi.resetModules()
})

afterEach(async () => {
  closeDb?.()
  closeDb = undefined
  delete process.env.DATA_DIR
  await rm(dataDir, { recursive: true, force: true })
})

describe('public auth routes', () => {
  it('preserves archive mode when a member logs in with a password', async () => {
    const { migrate, closeDb: close } = await import('../db.js')
    const { issuePin } = await import('../auth.js')
    const { registerPublicRoutes } = await import('./public.js')
    const { registerClientRoutes } = await import('./client.js')

    closeDb = close
    migrate()

    const app = Fastify()
    await registerPublicRoutes(app)
    await registerClientRoutes(app)

    try {
      const pin = issuePin({
        role: 'admin',
        createdBy: null,
        ttlMs: null,
        archiveMode: true,
        maxUses: 1,
      })

      const enroll = await app.inject({
        method: 'POST',
        url: '/api/enroll',
        payload: {
          pin: pin.code,
          displayName: 'Archive Admin',
          deviceLabel: 'test desktop',
        },
      })
      expect(enroll.statusCode).toBe(200)
      const enrolled = enroll.json() as { token: string; member: { archiveMode?: boolean } }
      expect(enrolled.member.archiveMode).toBe(true)

      const setPassword = await app.inject({
        method: 'POST',
        url: '/api/me/set-password',
        headers: { authorization: `Bearer ${enrolled.token}` },
        payload: {
          username: 'archive-admin',
          newPassword: 'archive1234',
        },
      })
      expect(setPassword.statusCode).toBe(200)

      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: {
          username: 'archive-admin',
          password: 'archive1234',
        },
      })
      expect(login.statusCode).toBe(200)
      expect(login.json()).toMatchObject({
        member: { archiveMode: true },
      })
    } finally {
      await app.close()
    }
  })
})

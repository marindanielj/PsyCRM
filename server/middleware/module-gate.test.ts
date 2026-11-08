import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { moduleGate } from './module-gate'

function harness(db: FakeDatabase, locationId: string | null = 'locA', now?: () => number) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    if (locationId) c.set('locationId', locationId)
    await next()
  })
  app.use('/x/*', moduleGate(db, 'documents', { now }))
  app.get('/x/ping', (c) => c.json({ ok: true }))
  return app
}

test('passes when the location has the module enabled', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ settings: { enabledModules: ['documents'] } }])
  const res = await harness(db).request('/x/ping')
  expect(res.status).toBe(200)
  expect(db.calls[0]?.params).toEqual(['locA'])
})

test('404s when the module is not enabled', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ settings: { enabledModules: ['contacts'] } }])
  expect((await harness(db).request('/x/ping')).status).toBe(404)
})

test('uses the PsyCRM default when the location has no list (documents is on by default)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ settings: {} }])
  expect((await harness(db).request('/x/ping')).status).toBe(200)
})

test('404s without a resolved location', async () => {
  const db = new FakeDatabase()
  expect((await harness(db, null).request('/x/ping')).status).toBe(404)
})

test('caches the lookup briefly, then re-reads', async () => {
  const db = new FakeDatabase()
  let t = 1_000
  const app = harness(db, 'locA', () => t)
  db.enqueue([{ settings: { enabledModules: ['documents'] } }])
  expect((await app.request('/x/ping')).status).toBe(200)
  expect((await app.request('/x/ping')).status).toBe(200)
  expect(db.calls).toHaveLength(1)
  t += 6_000
  db.enqueue([{ settings: { enabledModules: [] } }])
  expect((await app.request('/x/ping')).status).toBe(404)
  expect(db.calls).toHaveLength(2)
})

import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { ALL_MODULES, PSYCRM_DEFAULT_MODULES } from '../lib/modules'
import { locationsRoute } from './locations'

function harness(db: FakeDatabase, operatorId = 'op1', psycrmMode = false) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', operatorId)
    await next()
  })
  app.route('/', locationsRoute({ db, psycrmMode }))
  return app
}

const Alex = {
  id: 'locAlex',
  name: 'Alex',
  slug: 'Alex',
  client_slug: 'Alex',
  branding: {},
  settings: {},
}

test('lists only the locations the operator belongs to, scoped by operator id', async () => {
  const db = new FakeDatabase()
  db.enqueue([Alex]) // listLocations join result
  const res = await harness(db).request('/')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ locations: [{ ...Alex, enabledModules: [...ALL_MODULES] }] })
  expect(db.calls[0]?.params).toEqual(['op1'])
})


test('PsyCRM mode reports the location\'s enabled modules (default set when none configured)', async () => {
  const db = new FakeDatabase()
  db.enqueue([Alex, { ...Alex, id: 'loc2', settings: { enabledModules: ['contacts', 'bogus'] } }])
  const res = await harness(db, 'op1', true).request('/')
  const { locations } = (await res.json()) as { locations: { id: string; enabledModules: string[] }[] }
  expect(locations[0]?.enabledModules).toEqual([...PSYCRM_DEFAULT_MODULES])
  expect(locations[1]?.enabledModules).toEqual(['contacts'])
})

import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { practiceRoute } from './practice'

function harness(db: FakeDatabase) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', 'locA')
    await next()
  })
  app.route('/', practiceRoute({ db }))
  return app
}

const valid = {
  name: 'Consultorio X',
  therapist: 'Dra. Y',
  license: 'PR-1234',
  address: 'San Juan, PR',
  phone: '787-555-0100',
  email: 'hola@example.com',
  fees: { session: '$100', intake: '$120', late_cancel: '$50' },
  policy: { cancel_hours: '24' },
}

test('GET returns a full profile even when nothing is stored yet', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ settings: {} }])
  const res = await harness(db).request('/')
  expect(res.status).toBe(200)
  const { practice } = (await res.json()) as { practice: { name: string; fees: { session: string }; policy: { cancel_hours: string } } }
  expect(practice.name).toBe('')
  expect(practice.fees.session).toBe('')
  expect(practice.policy.cancel_hours).toBe('24')
  expect(db.calls[0]?.params).toEqual(['locA'])
})

test('PUT saves only under settings.practice for the current location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ settings: { practice: valid, enabledModules: ['contacts'] } }])
  const res = await harness(db).request('/', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(valid),
  })
  expect(res.status).toBe(200)
  expect(db.calls[0]?.sql).toContain("'{practice}'")
  expect(db.calls[0]?.params[0]).toBe('locA')
  expect(JSON.parse(String(db.calls[0]?.params[1]))).toEqual(valid)
  expect(((await res.json()) as { practice: { therapist: string } }).practice.therapist).toBe('Dra. Y')
})

test('PUT rejects a bad email or non-numeric cancellation hours', async () => {
  const db = new FakeDatabase()
  const put = (body: unknown) =>
    harness(db).request('/', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await put({ ...valid, email: 'not-an-email' })).status).toBe(400)
  expect((await put({ ...valid, policy: { cancel_hours: 'soon' } })).status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

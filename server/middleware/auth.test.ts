import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { createSession } from '../lib/session'
import { SESSION_COOKIE, operatorAuth } from './auth'

const secret = 'sek'

function harness() {
  const app = new Hono<AppEnv>()
  app.use('*', operatorAuth(secret))
  app.get('/x', (c) => c.json({ operatorId: c.get('operatorId') }))
  return app
}

test('401 when there is no session cookie', async () => {
  const res = await harness().request('/x')
  expect(res.status).toBe(401)
})

test('sets operatorId and passes through for a valid session', async () => {
  const token = createSession({ operatorId: 'op1' }, secret)
  const res = await harness().request('/x', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ operatorId: 'op1' })
})

test('401 for a tampered/garbage cookie', async () => {
  const res = await harness().request('/x', { headers: { Cookie: `${SESSION_COOKIE}=bogus.sig` } })
  expect(res.status).toBe(401)
})

import { IDLE_TTL_MS } from '../lib/session'

function idleHarness(now: () => number) {
  const app = new Hono<AppEnv>()
  app.use('*', operatorAuth(secret, { idleTtlMs: IDLE_TTL_MS, now }))
  app.get('/x', (c) => c.json({ operatorId: c.get('operatorId') }))
  return app
}

test('with an idle limit, a session idle past it is 401', async () => {
  const t0 = 5_000_000
  const token = createSession({ operatorId: 'op1' }, secret, { now: t0 })
  const res = await idleHarness(() => t0 + IDLE_TTL_MS + 1).request('/x', {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  })
  expect(res.status).toBe(401)
})

test('with an idle limit, a stale-but-valid cookie session is re-issued; a fresh one is not', async () => {
  const t0 = 5_000_000
  const token = createSession({ operatorId: 'op1' }, secret, { now: t0 })
  const stale = await idleHarness(() => t0 + 5 * 60_000).request('/x', {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  })
  expect(stale.status).toBe(200)
  expect(stale.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`)
  const fresh = await idleHarness(() => t0 + 10_000).request('/x', {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
  })
  expect(fresh.status).toBe(200)
  expect(fresh.headers.get('set-cookie')).toBeNull()
})

test('bearer sessions are exempt from the idle limit and never re-issued', async () => {
  const t0 = 5_000_000
  const token = createSession({ operatorId: 'op1' }, secret, { now: t0 })
  const res = await idleHarness(() => t0 + 3 * IDLE_TTL_MS).request('/x', {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('set-cookie')).toBeNull()
})

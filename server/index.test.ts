import { FakeDatabase } from './db/fake-database'
import { createApp } from './index'
import type { SendTextFn } from './lib/operator-tools'
import { createSession } from './lib/session'

function app(db = new FakeDatabase()) {
  return createApp({ db, sessionSecret: 'sek', webhookSecret: 'whsek' })
}

test('health is public', async () => {
  const res = await app().request('/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, service: 'openlevel' })
})

test('GET /api/locations requires a session', async () => {
  const res = await app().request('/api/locations')
  expect(res.status).toBe(401)
})

test('location-scoped routes require a session', async () => {
  const res = await app().request('/api/loc/locA/contacts')
  expect(res.status).toBe(401)
})

test('authenticated operator without access to the location gets 403', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // hasAccess -> none
  const token = createSession({ operatorId: 'op1' }, 'sek')
  const res = await app(db).request('/api/loc/locA/contacts', {
    headers: { Cookie: `ol_session=${token}` },
  })
  expect(res.status).toBe(403)
})

test('chatwoot webhook with the wrong secret is 401', async () => {
  const res = await app().request('/api/webhooks/chatwoot?secret=wrong', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'message_created' }),
  })
  expect(res.status).toBe(401)
})

// --- the text rail is wired end-to-end through createApp (slice 3B) -------------
// Prod injects the gateway rail at the top of the tree; this proves it actually
// reaches the assistant /confirm send_text handler through the real auth + tenant
// middleware — not just the route unit in isolation.

test('createApp threads the gateway text rail into the assistant /confirm send_text path', async () => {
  const db = new FakeDatabase()
  const CONTACT = { id: 'c1', location_id: 'locA', name: 'Jane Doe', phones: ['+16025551234'], emails: [], tags: [] }
  db.enqueue([{ id: 'locA' }]) // locationAccess: hasAccess -> granted
  db.enqueue([CONTACT]) // resolve(confirm) -> prepareText -> contacts.get
  db.enqueue([CONTACT]) // perform -> prepareText -> contacts.get
  const calls: Array<{ e164: string; body: string; nonce: string }> = []
  const sendText: SendTextFn = async (e164, body, nonce) => {
    calls.push({ e164, body, nonce })
    return { ok: true, messageId: 'gw1' }
  }
  const token = createSession({ operatorId: 'op1' }, 'sek')
  const res = await createApp({ db, sessionSecret: 'sek', webhookSecret: 'whsek', sendText }).request(
    '/api/loc/locA/assistant/confirm',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `ol_session=${token}` },
      body: JSON.stringify({ verb: 'send_text', params: { contactId: 'c1', body: 'Hi Jane', nonce: 'n1' } }),
    },
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ message: expect.stringMatching(/sent your text/i) })
  // the real rail was reached, with the contact's derived number + the echoed nonce
  expect(calls).toEqual([{ e164: '+16025551234', body: 'Hi Jane', nonce: 'n1' }])
})

// --- the hub federation surface is mounted, but inert until a token is set --------
// createApp wires /federation/* with its OWN bearer gate (separate from operator
// sessions). With no FEDERATION_SERVICE_TOKEN the whole surface answers 503 ("not
// turned on"); once a token is configured it answers, and a wrong bearer is 401.

test('federation surface is inert (503) when no token is configured', async () => {
  const res = await app().request('/federation/capabilities', { headers: { authorization: 'Bearer anything' } })
  expect(res.status).toBe(503)
})

test('federation capabilities answer (200) once a token is configured, 401 on a wrong bearer', async () => {
  const built = createApp({
    db: new FakeDatabase(),
    sessionSecret: 'sek',
    webhookSecret: 'whsek',
    federationServiceToken: 'fed-token',
  })
  const ok = await built.request('/federation/capabilities', { headers: { authorization: 'Bearer fed-token' } })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toMatchObject({ app: 'openlevel' })
  const bad = await built.request('/federation/capabilities', { headers: { authorization: 'Bearer wrong' } })
  expect(bad.status).toBe(401)
})

// --- PsyCRM mode ---------------------------------------------------------------

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function psycrmApp(db = new FakeDatabase(), extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ db, sessionSecret: 'sek', webhookSecret: 'whsek', psycrmMode: true, ...extra })
}
const cookie = () => ({ Cookie: `ol_session=${createSession({ operatorId: 'op1' }, 'sek')}` })

test('PsyCRM mode does not mount third-party-PHI integrations', async () => {
  const post = (path: string) => psycrmApp().request(path, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
  expect((await post('/api/webhooks/chatwoot?secret=whsek')).status).toBe(404)
  expect((await post('/api/public/voice/anything')).status).toBe(404)
  expect((await post('/api/public/pay/anything')).status).toBe(404)
  expect((await psycrmApp().request('/api/public/proposals/x/y')).status).toBe(404)
  expect((await psycrmApp().request('/federation/anything')).status).toBe(404)
  // …while plain OpenLevel mode still has the chatwoot webhook (401 = mounted, wrong secret)
  expect((await app().request('/api/webhooks/chatwoot?secret=wrong', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status).toBe(401)
})

test('PsyCRM mode keeps the public booking page mounted (it reaches the database)', async () => {
  const db = new FakeDatabase()
  await psycrmApp(db).request('/api/public/booking/locA/missing')
  expect(db.calls.length).toBeGreaterThan(0)
})

test('PsyCRM mode: a module the location has not enabled is 404; an enabled one passes', async () => {
  // campaigns (marketing) is off by default…
  const off = new FakeDatabase()
  off.enqueue([{ id: 'locA' }]) // hasAccess
  off.enqueue([{ settings: {} }]) // moduleGate settings -> PsyCRM defaults
  expect((await psycrmApp(off).request('/api/loc/locA/campaigns', { headers: cookie() })).status).toBe(404)
  // …contacts is on.
  const on = new FakeDatabase()
  on.enqueue([{ id: 'locA' }])
  on.enqueue([{ settings: {} }])
  on.enqueue([]) // contacts list
  expect((await psycrmApp(on).request('/api/loc/locA/contacts', { headers: cookie() })).status).toBe(200)
})

test('PsyCRM mode adds security headers and no-store; plain mode does not', async () => {
  const res = await psycrmApp().request('/api/locations')
  expect(res.status).toBe(401)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('strict-transport-security')).toContain('max-age=')
  expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
  const plain = await app().request('/api/locations')
  expect(plain.headers.get('x-frame-options')).toBeNull()
  expect(plain.headers.get('cache-control')).toBeNull()
})

test('PsyCRM mode signs out an idle web session', async () => {
  const old = createSession({ operatorId: 'op1' }, 'sek', { now: Date.now() - 31 * 60_000 })
  const res = await psycrmApp().request('/api/locations', { headers: { Cookie: `ol_session=${old}` } })
  expect(res.status).toBe(401)
  // plain mode has no idle limit
  expect((await app(new FakeDatabase()).request('/api/locations', { headers: { Cookie: `ol_session=${old}` } })).status).toBe(200)
})

test('serves the built web app with an SPA fallback, without shadowing the API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'psycrm-static-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  const a = psycrmApp(new FakeDatabase(), { staticDir: dir })

  const root = await a.request('/')
  expect(root.status).toBe(200)
  expect(await root.text()).toContain('<title>spa</title>')
  const deep = await a.request('/contacts/abc')
  expect(deep.status).toBe(200)
  expect(await deep.text()).toContain('<title>spa</title>')
  expect(deep.headers.get('cache-control')).toBe('no-store')
  const asset = await a.request('/assets/app.js')
  expect(asset.status).toBe(200)
  expect(asset.headers.get('cache-control')).toContain('immutable')

  expect((await a.request('/api/nope')).status).toBe(404)
  expect(((await a.request('/api/nope')).headers.get('content-type') ?? '')).toContain('json')
  expect(await (await a.request('/health')).json()).toMatchObject({ ok: true, service: 'psycrm' })
})

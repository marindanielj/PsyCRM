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
  expect(await res.json()).toMatchObject({ ok: true, service: 'psycrm' })
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

test('chatwoot webhook with the wrong secret is 401 (once the chatwoot integration is enabled)', async () => {
  const res = await createApp({ db: new FakeDatabase(), sessionSecret: 'sek', webhookSecret: 'whsek', integrations: ['chatwoot'] }).request('/api/webhooks/chatwoot?secret=wrong', {
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
  db.enqueue([{ settings: { enabledModules: ['assistant'] } }]) // module gate: this practice has the assistant on
  db.enqueue([CONTACT]) // resolve(confirm) -> prepareText -> contacts.get
  db.enqueue([CONTACT]) // perform -> prepareText -> contacts.get
  const calls: Array<{ e164: string; body: string; nonce: string }> = []
  const sendText: SendTextFn = async (e164, body, nonce) => {
    calls.push({ e164, body, nonce })
    return { ok: true, messageId: 'gw1' }
  }
  const token = createSession({ operatorId: 'op1' }, 'sek')
  const res = await createApp({ db, sessionSecret: 'sek', webhookSecret: 'whsek', integrations: ['ai'], sendText }).request(
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

test('federation surface is inert (503) when enabled but no token is configured', async () => {
  const res = await createApp({ db: new FakeDatabase(), sessionSecret: 'sek', webhookSecret: 'whsek', integrations: ['federation'] }).request('/federation/capabilities', { headers: { authorization: 'Bearer anything' } })
  expect(res.status).toBe(503)
})

test('federation capabilities answer (200) once a token is configured, 401 on a wrong bearer', async () => {
  const built = createApp({
    db: new FakeDatabase(),
    sessionSecret: 'sek',
    webhookSecret: 'whsek',
    integrations: ['federation'],
    federationServiceToken: 'fed-token',
  })
  const ok = await built.request('/federation/capabilities', { headers: { authorization: 'Bearer fed-token' } })
  expect(ok.status).toBe(200)
  expect(await ok.json()).toMatchObject({ app: 'openlevel' })
  const bad = await built.request('/federation/capabilities', { headers: { authorization: 'Bearer wrong' } })
  expect(bad.status).toBe(401)
})

// --- fixed PsyCRM behavior + per-integration mounting ---------------------------

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INTEGRATION_NAMES, type Integration } from './lib/integrations'

const cookie = () => ({ Cookie: `ol_session=${createSession({ operatorId: 'op1' }, 'sek')}` })

/** The route prefixes each integration puts on the app (read from the router, so the
 *  test cannot pass by accident the way a status-code check could). */
const MOUNTS: Record<Integration, string[]> = {
  chatwoot: ['/api/webhooks/chatwoot'],
  ai: ['/api/loc/:loc/assistant'],
  public_pages: ['/api/public/f', '/api/public/forms', '/api/public/reviews', '/api/public/courses', '/api/public/blog', '/api/public/communities', '/api/public/surveys', '/api/public/proposals', '/api/public/l', '/api/public/ref'],
  payments: ['/api/public/pay'],
  voice: ['/api/public/voice'],
  federation: ['/federation'],
  push: ['/api/push-tokens'],
}
const mounted = (integrations: Integration[]) => {
  // Only real handlers count: app.use() (e.g. a module gate) also lists its path, with method ALL.
  const paths = createApp({ db: new FakeDatabase(), sessionSecret: 'sek', webhookSecret: 'whsek', integrations }).routes.filter((r) => r.method !== 'ALL').map((r) => r.path)
  return (prefix: string) => paths.some((p) => p === prefix || p.startsWith(`${prefix}/`))
}

test('no third-party integration is mounted by default', () => {
  const has = mounted([])
  for (const prefixes of Object.values(MOUNTS)) for (const prefix of prefixes) expect(has(prefix), prefix).toBe(false)
})

test('each integration mounts exactly its own routes and nobody else\'s', () => {
  // the registry and this table must list the same integrations
  expect(Object.keys(MOUNTS).sort()).toEqual([...INTEGRATION_NAMES].sort())
  for (const name of INTEGRATION_NAMES) {
    const has = mounted([name])
    for (const prefix of MOUNTS[name]) expect(has(prefix), `${name} -> ${prefix}`).toBe(true)
    for (const other of INTEGRATION_NAMES.filter((n) => n !== name)) {
      for (const prefix of MOUNTS[other]) expect(has(prefix), `${name} must not mount ${prefix}`).toBe(false)
    }
  }
})

test('unmounted integrations answer 404 and never touch the database', async () => {
  const db = new FakeDatabase()
  const a = app(db)
  const post = (path: string) => a.request(path, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
  expect((await post('/api/webhooks/chatwoot?secret=whsek')).status).toBe(404)
  expect((await post('/api/public/voice/anything')).status).toBe(404)
  expect((await post('/api/public/pay/anything')).status).toBe(404)
  expect((await a.request('/api/public/proposals/x/y')).status).toBe(404)
  expect((await a.request('/federation/anything')).status).toBe(404)
  expect(db.calls).toHaveLength(0)
})

test('the public booking page is always mounted (it reaches the database)', async () => {
  const db = new FakeDatabase()
  await app(db).request('/api/public/booking/locA/missing')
  expect(db.calls.length).toBeGreaterThan(0)
})

test('the module gate looks the practice up once per request, even on the bare route', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'locA' }])
  db.enqueue([{ settings: {} }])
  db.enqueue([])
  await app(db).request('/api/loc/locA/contacts', { headers: cookie() })
  expect(db.calls.filter((c) => /FROM locations WHERE id/.test(c.sql))).toHaveLength(1)
})

test('a module the location has not enabled is 404; an enabled one passes', async () => {
  // campaigns (marketing) is off by default…
  const off = new FakeDatabase()
  off.enqueue([{ id: 'locA' }]) // hasAccess
  off.enqueue([{ settings: {} }]) // moduleGate settings -> PsyCRM defaults
  expect((await app(off).request('/api/loc/locA/campaigns', { headers: cookie() })).status).toBe(404)
  // …contacts is on.
  const on = new FakeDatabase()
  on.enqueue([{ id: 'locA' }])
  on.enqueue([{ settings: {} }])
  on.enqueue([]) // contacts list
  expect((await app(on).request('/api/loc/locA/contacts', { headers: cookie() })).status).toBe(200)
})

test('a practice that lists a module in its settings gets it (modules are data, not a deploy mode)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'locA' }])
  db.enqueue([{ settings: { enabledModules: ['contacts', 'marketing'] } }])
  db.enqueue([]) // campaigns list
  expect((await app(db).request('/api/loc/locA/campaigns', { headers: cookie() })).status).toBe(200)
})

test('security headers and no-store are always on', async () => {
  const res = await app().request('/api/locations')
  expect(res.status).toBe(401)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('strict-transport-security')).toContain('max-age=')
  expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
})

test('public pages get the framing/referrer protections but no CSP (they inline a small script); API and app get the strict CSP', async () => {
  const pub = await app().request('/api/public/booking/locA/none')
  expect(pub.headers.get('x-frame-options')).toBe('DENY')
  expect(pub.headers.get('referrer-policy')).toBe('no-referrer')
  expect(pub.headers.get('content-security-policy')).toBeNull()
  expect(pub.headers.get('x-robots-tag')).toBe('noindex')
  expect(pub.headers.get('cache-control')).toBe('no-store')
  expect((await app().request('/api/locations')).headers.get('content-security-policy')).toContain("default-src 'self'")
})

test('an idle web session is signed out; the limit can be overridden', async () => {
  const old = createSession({ operatorId: 'op1' }, 'sek', { now: Date.now() - 31 * 60_000 })
  expect((await app().request('/api/locations', { headers: { Cookie: `ol_session=${old}` } })).status).toBe(401)
  const roomy = createApp({ db: new FakeDatabase(), sessionSecret: 'sek', webhookSecret: 'whsek', idleTtlMs: 60 * 60_000 })
  expect((await roomy.request('/api/locations', { headers: { Cookie: `ol_session=${old}` } })).status).toBe(200)
})

test('serves the built web app with an SPA fallback, without shadowing the API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'psycrm-static-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  const a = createApp({ db: new FakeDatabase(), sessionSecret: 'sek', webhookSecret: 'whsek', staticDir: dir })

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

test('the session-notes API sits behind the session_notes module: on by default, 404 for a practice that turned it off', async () => {
  const on = new FakeDatabase()
  on.enqueue([{ id: 'locA' }]) // hasAccess
  on.enqueue([{ settings: {} }]) // module gate -> PsyCRM defaults include session_notes
  on.enqueue([]) // the (empty) list
  expect((await app(on).request('/api/loc/locA/session-notes?contactId=c1', { headers: cookie() })).status).toBe(200)

  const off = new FakeDatabase()
  off.enqueue([{ id: 'locA' }])
  off.enqueue([{ settings: { enabledModules: ['contacts'] } }])
  expect((await app(off).request('/api/loc/locA/session-notes?contactId=c1', { headers: cookie() })).status).toBe(404)
  expect(off.calls.some((c) => /session_notes/.test(c.sql))).toBe(false) // never reached the notes table
})

test('the documents API sits behind the documents module: on by default, 404 for a practice that turned it off', async () => {
  const on = new FakeDatabase()
  on.enqueue([{ id: 'locA' }]) // hasAccess
  on.enqueue([{ settings: {} }]) // module gate -> PsyCRM defaults include documents
  on.enqueue([]) // the (empty) template list
  expect((await app(on).request('/api/loc/locA/documents/templates', { headers: cookie() })).status).toBe(200)

  const off = new FakeDatabase()
  off.enqueue([{ id: 'locA' }])
  off.enqueue([{ settings: { enabledModules: ['contacts'] } }])
  expect((await app(off).request('/api/loc/locA/documents/templates', { headers: cookie() })).status).toBe(404)
  expect(off.calls.some((c) => /document_templates/.test(c.sql))).toBe(false)
})

test('the public signing pages carry their own nonce-based CSP (not the app-wide one) and are never cached', async () => {
  const res = await app(new FakeDatabase()).request(`/d/${'A'.repeat(43)}`)
  expect(res.status).toBe(404)
  const csp = res.headers.get('content-security-policy') ?? ''
  expect(csp).toMatch(/script-src 'nonce-[^']+'/)
  expect(csp).not.toMatch(/script-src[^;]*'self'/)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  // and the app's own API keeps the strict policy
  expect((await app(new FakeDatabase()).request('/health')).headers.get('content-security-policy')).toContain("script-src 'self'")
})

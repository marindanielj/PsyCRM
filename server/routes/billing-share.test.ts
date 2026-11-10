import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import type { EmailMessage, EmailSender } from '../lib/sending/provider'
import { addLocation, freshDb } from '../test-utils/pglite'
import { billingRoute } from './billing'
import { publicBillingRoute } from './public-billing'

const SECRET = 'a-session-secret-that-is-long-enough-0123456789'
const PRACTICE = { name: 'Consultorio Rivera', therapist: 'Dra. Rivera', license: 'PR-1234', address: 'Calle Luna 1, San Juan PR 00901', phone: '787-555-0000', email: 'dra@x.com', fees: { session: '$100', intake: '$150', late_cancel: '$50' }, policy: { cancel_hours: '24' } }

async function setup() {
  const { db } = await freshDb()
  const locA = await addLocation(db, 'loc_a')
  const locB = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera','h')")
  for (const loc of [locA, locB]) await db.query('UPDATE locations SET settings = $2::jsonb WHERE id = $1', [loc, JSON.stringify({ practice: PRACTICE, enabledModules: ['billing'] })])
  const contact = (id: string, loc: string, name: string, emails: string[]) =>
    db.query('INSERT INTO contacts (id, location_id, name, first_name, last_name, emails, custom_fields) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [id, loc, name, name.split(' ')[0], name.split(' ')[1], emails, '{}'])
  await contact('c1', locA, 'Maria Lopez', ['maria@example.com'])
  await contact('c2', locA, 'Juan Perez', [])

  const outbox: EmailMessage[] = []
  let failing = false
  const sender: EmailSender = { name: 'test', sendEmail: async (m) => { if (failing) throw new Error('boom'); outbox.push(m); return { externalId: 'x', provider: 'test' } } }
  const resolveEmail = async () => ({ ok: true as const, sender })

  const op = new Hono<AppEnv>()
  op.use('/billing/*', async (c, next) => { c.set('operatorId', 'op1'); c.set('locationId', locA); await next() })
  op.route('/billing', billingRoute({ db, secret: SECRET, resolveEmail, publicBaseUrl: 'https://crm.test' }))
  const pub = new Hono<AppEnv>()
  pub.route('/b', publicBillingRoute({ db, sessionSecret: SECRET, resolveEmail }))

  const call = async (method: string, path: string, json?: unknown) => {
    const res = await op.request(`/billing${path}`, { method, ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } } : {}) })
    return { status: res.status, body: (await res.json().catch(() => null)) as any }
  }
  const mk = async (contactId = 'c1') => (await call('POST', '/charges', { contactId, serviceDate: '2026-11-02', cptCode: '90834', modifiers: [], placeOfService: '11', units: 1, diagnosisCodes: ['F41.1'], feeCents: 10000 })).body.charge.id as string
  const invoice = async () => (await call('POST', '/invoices', { contactId: 'c1', chargeIds: [await mk()] })).body.invoice
  const receipt = async () => (await call('POST', '/payments', { contactId: 'c1', method: 'ath_movil', paidOn: '2026-11-05', allocations: [{ chargeId: await mk(), amountCents: 4000 }] })).body.receipt
  const get = (path: string, cookie?: string) => pub.request(path, { headers: cookie ? { cookie } : {} })
  const post = (path: string, json: unknown) => pub.request(path, { method: 'POST', body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } })
  /** The token of the last link emailed. */
  const lastToken = () => /\/b\/([A-Za-z0-9_-]{43})/.exec(outbox.filter((m) => m.text.includes('/b/')).at(-1)?.text ?? '')?.[1] ?? ''
  const lastCode = () => /\b(\d{6})\b/.exec(outbox.at(-1)?.text ?? '')?.[1] ?? ''
  return { db, locA, locB, call, mk, invoice, receipt, get, post, outbox, lastToken, lastCode, setFailing: (v: boolean) => { failing = v } }
}

/** Verify with the emailed code and return the cookie. */
async function open(s: Awaited<ReturnType<typeof setup>>, token: string) {
  expect((await s.post(`/b/${token}/otp`, {})).status).toBe(200)
  const res = await s.post(`/b/${token}/verify`, { code: s.lastCode() })
  expect(res.status).toBe(200)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!
}

test('an invoice is emailed as a link only: no number, amount, service or diagnosis in the email', async () => {
  const s = await setup()
  const inv = await s.invoice()
  const r = await s.call('POST', `/invoices/${inv.id}/send`, { email: 'Maria@Example.com' })
  expect(r.status).toBe(200)
  expect(s.outbox).toHaveLength(1)
  const m = s.outbox[0]!
  expect(m.to).toBe('maria@example.com')
  expect(m.subject).toBe('Consultorio Rivera: su factura')
  expect(m.text).toContain('https://crm.test/b/')
  for (const secret of [inv.number, '100.00', '$', 'F41', '90834', 'sesión', 'terapia']) expect(m.text + m.subject).not.toContain(secret)
  // only the hash of the token is stored
  const rows = await s.db.query<any>('SELECT token_hash, email, kind FROM billing_shares')
  expect(rows).toHaveLength(1)
  expect(rows[0].token_hash).not.toContain(s.lastToken())
  expect(rows[0]).toMatchObject({ email: 'maria@example.com', kind: 'invoice' })
})

test('only an address the client has on file can be used; a voided document and a missing one are refused', async () => {
  const s = await setup()
  const inv = await s.invoice()
  expect((await s.call('POST', `/invoices/${inv.id}/send`, { email: 'someone@else.com' })).body.error).toBe('email_not_on_file')
  expect((await s.call('POST', `/invoices/${inv.id}/send`, { email: 'not-an-email' })).status).toBe(400)
  expect((await s.call('POST', '/invoices/nope/send', { email: 'maria@example.com' })).status).toBe(404)
  expect((await s.call('POST', '/receipts/nope/send', { email: 'maria@example.com' })).status).toBe(404)
  await s.call('POST', `/invoices/${inv.id}/void`, { reason: 'wrong amount' })
  expect((await s.call('POST', `/invoices/${inv.id}/send`, { email: 'maria@example.com' })).status).toBe(409)
  expect(s.outbox).toHaveLength(0)
  expect(await s.db.query('SELECT 1 FROM billing_shares')).toHaveLength(0)
})

test('when the email cannot be sent, no live link is left behind', async () => {
  const s = await setup()
  const inv = await s.invoice()
  s.setFailing(true)
  const r = await s.call('POST', `/invoices/${inv.id}/send`, { email: 'maria@example.com' })
  expect(r.status).toBe(503)
  expect(r.body.error).toBe('email_unavailable')
  expect(await s.db.query('SELECT 1 FROM billing_shares')).toHaveLength(0)
})

test('the client opens an invoice only after the code; the page shows it in Spanish with its live balance', async () => {
  const s = await setup()
  const inv = await s.invoice()
  await s.call('POST', `/invoices/${inv.id}/send`, { email: 'maria@example.com' })
  const token = s.lastToken()

  const locked = await s.get(`/b/${token}`)
  const lockedHtml = await locked.text()
  expect(locked.status).toBe(200)
  expect(lockedHtml).toContain('Verifique su identidad')
  expect(lockedHtml).not.toContain('Maria Lopez')
  expect(lockedHtml).not.toContain(inv.number)
  expect(locked.headers.get('cache-control')).toBe('no-store')
  expect(locked.headers.get('x-robots-tag')).toContain('noindex')
  expect(locked.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/)
  // the verify page talks to /b, not /d
  expect(lockedHtml).toContain('"/b/"')

  const cookie = await open(s, token)
  const page = await (await s.get(`/b/${token}`, cookie)).text()
  expect(page).toContain('Factura')
  expect(page).toContain('Maria Lopez')
  expect(page).toContain(inv.number)
  expect(page).toContain('Saldo pendiente')
  expect(page).toMatch(/Emitida el \d{1,2} de [a-z]+ de \d{4}/)
  expect(page).toContain('$100.00')
  for (const clinical of ['F41', '90834', 'NPI', 'taxId']) expect(page).not.toContain(clinical)

  // a payment made later shows on the same link
  const charges = (await s.call('GET', '/charges?contactId=c1')).body.charges
  await s.call('POST', '/payments', { contactId: 'c1', method: 'cash', paidOn: '2026-11-06', allocations: [{ chargeId: charges[0].id, amountCents: 10000 }] })
  expect(await (await s.get(`/b/${token}`, cookie)).text()).toContain('PAGADA')
})

test('a receipt is emailed and opened the same way', async () => {
  const s = await setup()
  const rec = await s.receipt()
  expect((await s.call('POST', `/receipts/${rec.id}/send`, { email: 'maria@example.com' })).status).toBe(200)
  expect(s.outbox[0]!.subject).toBe('Consultorio Rivera: su recibo')
  const token = s.lastToken()
  const cookie = await open(s, token)
  const page = await (await s.get(`/b/${token}`, cookie)).text()
  expect(page).toContain('Recibo de pago')
  expect(page).toContain('ATH Móvil')
  expect(page).toContain('$40.00')
  expect(page).toContain('Pagado el 5 de noviembre de 2026')
  expect(page).toContain(rec.number)
})

test('a wrong code is counted and the link locks after five; new codes do not give more guesses', async () => {
  const s = await setup()
  const inv = await s.invoice()
  await s.call('POST', `/invoices/${inv.id}/send`, { email: 'maria@example.com' })
  const token = s.lastToken()
  await s.post(`/b/${token}/otp`, {})
  const real = s.lastCode()
  const wrong = real === '000000' ? '111111' : '000000'
  const statuses: number[] = []
  for (let i = 0; i < 5; i++) statuses.push((await s.post(`/b/${token}/verify`, { code: wrong })).status)
  expect(statuses).toEqual([401, 401, 401, 401, 423])
  // even the right code is refused once locked
  expect((await s.post(`/b/${token}/verify`, { code: real })).status).toBe(423)
  expect((await s.post(`/b/${token}/otp`, {})).status).toBe(423)
  expect((await s.post(`/b/${token}/verify`, { code: 'abc' })).status).toBe(401)
})

test('links that are unknown, expired, voided or from a practice without billing all get the same answer', async () => {
  const s = await setup()
  const invalid = async (path: string) => { const r = await s.get(path); return [r.status, await r.text()] as const }
  const unknown = await invalid(`/b/${'A'.repeat(43)}`)
  expect(unknown[0]).toBe(404)
  expect(await invalid('/b/short')).toEqual(unknown)

  const inv = await s.invoice()
  await s.call('POST', `/invoices/${inv.id}/send`, { email: 'maria@example.com' })
  const token = s.lastToken()
  const cookie = await open(s, token)

  await s.db.query("UPDATE billing_shares SET expires_at = now() - interval '1 minute'")
  expect(await invalid(`/b/${token}`)).toEqual(unknown)
  await s.db.query("UPDATE billing_shares SET expires_at = now() + interval '1 day'")
  expect((await s.get(`/b/${token}`, cookie)).status).toBe(200)

  await s.call('POST', `/invoices/${inv.id}/void`, { reason: 'wrong amount' })
  expect(await invalid(`/b/${token}`)).toEqual(unknown)

  const inv2 = await s.invoice()
  await s.call('POST', `/invoices/${inv2.id}/send`, { email: 'maria@example.com' })
  const t2 = s.lastToken()
  await s.db.query("UPDATE locations SET settings = jsonb_set(settings, '{enabledModules}', '[]'::jsonb) WHERE id = 'loc_a'")
  expect(await invalid(`/b/${t2}`)).toEqual(unknown)
})

test("one client's cookie does not open another link", async () => {
  const s = await setup()
  const a = await s.invoice()
  await s.call('POST', `/invoices/${a.id}/send`, { email: 'maria@example.com' })
  const tokenA = s.lastToken()
  const cookieA = await open(s, tokenA)
  const b = await s.invoice()
  await s.call('POST', `/invoices/${b.id}/send`, { email: 'maria@example.com' })
  const tokenB = s.lastToken()
  const html = await (await s.get(`/b/${tokenB}`, cookieA)).text()
  expect(html).toContain('Verifique su identidad')
  expect(html).not.toContain(b.number)
})

test('the log says an invoice was emailed and opened by the client, never the address, link or code', async () => {
  const s = await setup()
  const inv = await s.invoice()
  await s.call('POST', `/invoices/${inv.id}/send`, { email: 'maria@example.com' })
  const token = s.lastToken()
  await open(s, token)
  const code = s.lastCode()
  const log = await s.db.query<any>("SELECT action, actor_type, details FROM audit_log WHERE action IN ('invoice.emailed','invoice.viewed') ORDER BY id")
  expect(log.map((l: any) => [l.action, l.actor_type])).toEqual([['invoice.emailed', 'operator'], ['invoice.viewed', 'client']])
  const everything = JSON.stringify(await s.db.query('SELECT * FROM audit_log'))
  for (const secret of ['maria@example.com', token, code]) expect(everything).not.toContain(secret)
})

test('a superbill has no send route', async () => {
  const s = await setup()
  expect((await s.call('POST', '/superbills/x/send', { email: 'maria@example.com' })).status).toBe(404)
})

import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { addLocation, freshDb } from '../test-utils/pglite'
import { billingRoute } from './billing'

const SECRET = 'a-session-secret-that-is-long-enough-0123456789'
const YEAR = new Date().getUTCFullYear()
const PRACTICE = { name: 'Consultorio Rivera', therapist: 'Dra. Rivera', license: 'PR-1234', address: 'Calle Luna 1, San Juan PR 00901', phone: '787-555-0000', email: 'dra@x.com', fees: { session: '$100', intake: '$150', late_cancel: '$50' }, policy: { cancel_hours: '24' } }

async function setup() {
  const { db, pg } = await freshDb()
  const locA = await addLocation(db, 'loc_a')
  const locB = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera','h')")
  await db.query('UPDATE locations SET settings = $2::jsonb WHERE id = $1', [locA, JSON.stringify({ practice: PRACTICE })])
  await db.query('UPDATE locations SET settings = $2::jsonb WHERE id = $1', [locB, JSON.stringify({ practice: { ...PRACTICE, name: 'Otro Consultorio' } })])
  const contact = (id: string, loc: string, name: string, dob: string | null) =>
    db.query('INSERT INTO contacts (id, location_id, name, first_name, last_name, custom_fields) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [id, loc, name, name.split(' ')[0], name.split(' ')[1], JSON.stringify(dob ? { date_of_birth: dob } : {})])
  await contact('c1', locA, 'Maria Lopez', '1990-04-12')
  await contact('c2', locA, 'Juan Perez', '1985-02-02')
  await contact('cb', locB, 'Ana Ruiz', '1985-01-01')

  const mount = (loc: string) => {
    const a = new Hono<AppEnv>()
    a.use('/billing/*', async (c, next) => { c.set('operatorId', 'op1'); c.set('locationId', loc); await next() })
    a.route('/billing', billingRoute({ db, secret: SECRET }))
    return a
  }
  const A = mount(locA)
  const B = mount(locB)
  const call = async (app: Hono<AppEnv>, method: string, path: string, json?: unknown) => {
    const res = await app.request(`/billing${path}`, { method, ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } } : {}) })
    return { status: res.status, body: (await res.json().catch(() => null)) as any }
  }
  const charge = (over: Record<string, unknown> = {}) => ({ contactId: 'c1', serviceDate: '2026-11-02', cptCode: '90834', modifiers: [], placeOfService: '11', units: 1, diagnosisCodes: ['F41.1'], feeCents: 10000, ...over })
  /** A charge; returns its id. */
  const mk = async (over: Record<string, unknown> = {}, app = A) => (await call(app, 'POST', '/charges', charge(over))).body.charge.id as string
  const payBody = (allocations: [string, number][], over: Record<string, unknown> = {}) => ({ contactId: 'c1', method: 'cash', paidOn: '2026-11-05', allocations: allocations.map(([chargeId, amountCents]) => ({ chargeId, amountCents })), ...over })
  const pay = (allocations: [string, number][], over: Record<string, unknown> = {}, app = A) => call(app, 'POST', '/payments', payBody(allocations, over))
  const chargeRow = async (id: string) => (await db.query<any>('SELECT paid_cents, payment_method, paid_at, invoice_id, superbill_id FROM charges WHERE id = $1', [id]))[0]
  return { db, pg, locA, locB, A, B, call, mk, pay, chargeRow }
}


const receiptsOf = async (s: S, chargeId: string) => (await s.call(s.A, 'GET', `/charges/${chargeId}/payments`)).body.payments as any[]
type S = Awaited<ReturnType<typeof setup>>

// --- who paid a charge -----------------------------------------------------------------------------------------

test("a charge's payments list each live receipt, with what it paid on this charge and how many charges it covers", async () => {
  const s = await setup()
  const a = await s.mk()
  const b = await s.mk({ serviceDate: '2026-11-03' })
  await s.pay([[a, 3000]], { method: 'ath_movil' })
  await s.pay([[a, 2000], [b, 10000]])
  const list = await receiptsOf(s, a)
  expect(list.map((p) => [p.receipt_number, p.amount_cents, p.method, p.receipt_charge_count, p.receipt_total_cents])).toEqual([
    [`REC-${YEAR}-0001`, 3000, 'ath_movil', 1, 3000],
    [`REC-${YEAR}-0002`, 2000, 'cash', 2, 12000],
  ])
  expect((await s.call(s.A, 'GET', '/charges/nope/payments')).status).toBe(404)
  expect((await s.call(s.B, 'GET', `/charges/${a}/payments`)).status).toBe(404) // another practice
})

// --- taking a charge out of a payment ------------------------------------------------------------------------

test('taking a charge out of a payment voids the receipt and records the rest again as a new receipt', async () => {
  const s = await setup()
  const a = await s.mk()
  const b = await s.mk({ serviceDate: '2026-11-03' })
  const rec = (await s.pay([[a, 4000], [b, 10000]], { method: 'card', paidOn: '2026-11-06' })).body.receipt
  const r = await s.call(s.A, 'POST', `/receipts/${rec.id}/remove-charge`, { chargeId: a, reason: 'Paid the wrong session' })
  expect(r.status).toBe(200)
  expect(r.body.voided).toBe(rec.number)
  expect(r.body.newReceipt).toMatchObject({ number: `REC-${YEAR}-0002`, method: 'card', paid_on: '2026-11-06' })
  expect(r.body.newReceipt.snapshot.lines.map((l: any) => [l.chargeId, l.amountCents])).toEqual([[b, 10000]])
  expect(await s.chargeRow(a)).toMatchObject({ paid_cents: 0 })
  expect(await s.chargeRow(b)).toMatchObject({ paid_cents: 10000 })
  expect((await s.call(s.A, 'GET', `/receipts/${rec.id}`)).body.receipt.voided_at).not.toBeNull()
  expect(await receiptsOf(s, a)).toEqual([])
})

test('taking the only charge out of a payment just voids its receipt', async () => {
  const s = await setup()
  const a = await s.mk()
  const rec = (await s.pay([[a, 4000]])).body.receipt
  const r = await s.call(s.A, 'POST', `/receipts/${rec.id}/remove-charge`, { chargeId: a, reason: 'Entered twice' })
  expect(r.body).toMatchObject({ ok: true, newReceipt: null })
  expect(await s.chargeRow(a)).toMatchObject({ paid_cents: 0 })
  // and again: the receipt is gone, the charge is not on it
  expect((await s.call(s.A, 'POST', `/receipts/${rec.id}/remove-charge`, { chargeId: a, reason: 'Entered twice' })).body.error).toBe('voided')
})

test('a charge that is not on the receipt, a missing reason and another practice are refused, and nothing changes', async () => {
  const s = await setup()
  const a = await s.mk()
  const b = await s.mk({ serviceDate: '2026-11-03' })
  const rec = (await s.pay([[a, 4000]])).body.receipt
  expect((await s.call(s.A, 'POST', `/receipts/${rec.id}/remove-charge`, { chargeId: b, reason: 'Wrong one' })).body.error).toBe('not_on_receipt')
  expect((await s.call(s.A, 'POST', `/receipts/${rec.id}/remove-charge`, { chargeId: a, reason: '' })).status).toBe(400)
  expect((await s.call(s.B, 'POST', `/receipts/${rec.id}/remove-charge`, { chargeId: a, reason: 'Wrong one' })).status).toBe(404)
  expect(await s.chargeRow(a)).toMatchObject({ paid_cents: 4000 })
  expect((await s.call(s.A, 'GET', `/receipts/${rec.id}`)).body.receipt.voided_at).toBeNull()
})

// --- deleting (voiding) a charge ------------------------------------------------------------------------------

test('deleting a paid, invoiced charge with everything that depends on it: one step, one transaction', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/profile', { npi: '1234567893' })
  const a = await s.mk()
  const b = await s.mk({ serviceDate: '2026-11-03' })
  const inv = (await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [a, b] })).body.invoice
  const sb = (await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [a] })).body.superbill
  const rec = (await s.pay([[a, 4000], [b, 1000]])).body.receipt

  // without cascade the usual rule answers
  expect((await s.call(s.A, 'POST', `/charges/${a}/void`, { reason: 'Entered by mistake' })).body.error).toBe('issued')

  const r = await s.call(s.A, 'POST', `/charges/${a}/void`, { reason: 'Entered by mistake', cascade: true })
  expect(r.status).toBe(200)
  expect(r.body.voidedDocuments).toEqual([rec.number, inv.number, sb.number])
  expect(r.body.charge.voided_at).not.toBeNull()
  // the other charge: unpaid again (its receipt was voided), off the voided invoice, still live
  expect(await s.chargeRow(b)).toMatchObject({ paid_cents: 0, invoice_id: null })
  const docs = await s.db.query<{ n: number }>(
    `SELECT (SELECT count(*)::int FROM billing_receipts WHERE voided_at IS NOT NULL) + (SELECT count(*)::int FROM billing_invoices WHERE voided_at IS NOT NULL) + (SELECT count(*)::int FROM superbills WHERE voided_at IS NOT NULL) AS n`,
  )
  expect(docs[0]!.n).toBe(3)
  // nothing is erased: the charge is still listed under "voided", with its reason
  const voided = (await s.call(s.A, 'GET', '/charges?status=void')).body.charges
  expect(voided.map((c: any) => [c.id, c.void_reason])).toEqual([[a, 'Entered by mistake']])
  // and the log says what happened, without the reason
  const log = await s.db.query<{ action: string; details: unknown }>("SELECT action, details FROM audit_log WHERE action LIKE '%.voided' ORDER BY chain_seq")
  expect(log.map((l) => l.action)).toEqual(['receipt.voided', 'invoice.voided', 'superbill.voided', 'charge.voided'])
  expect(JSON.stringify(log)).not.toContain('Entered by mistake')
})

test('deleting a charge that has nothing depending on it needs no cascade', async () => {
  const s = await setup()
  const a = await s.mk()
  const r = await s.call(s.A, 'POST', `/charges/${a}/void`, { reason: 'Duplicate', cascade: true })
  expect(r.body).toMatchObject({ ok: true, voidedDocuments: [] })
  expect((await s.call(s.A, 'POST', `/charges/${a}/void`, { reason: 'Duplicate', cascade: true })).body.error).toBe('voided')
  expect((await s.call(s.B, 'POST', `/charges/${a}/void`, { reason: 'Duplicate', cascade: true })).body.error).toBe('not_found')
})

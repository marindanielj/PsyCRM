import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { addLocation, freshDb } from '../test-utils/pglite'
import { billingRoute } from './billing'

const SECRET = 'a-session-secret-that-is-long-enough-0123456789'
const YEAR = new Date().getUTCFullYear()
const PRACTICE = { name: 'Consultorio Rivera', therapist: 'Dra. Rivera', license: 'PR-1234', address: 'Calle Luna 1, San Juan PR 00901', phone: '787-555-0000', email: 'dra@x.com', fees: { session: '$100', intake: '$150', late_cancel: '$50' }, policy: { cancel_hours: '24' } }
const NPI = '1234567893'
const EIN = '98-7654321'

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

const dbError = async (p: Promise<unknown>) => { try { await p } catch (e) { return String((e as Error).message) } return null }

// --- ATH Móvil and recording a payment -------------------------------------------------------------------------

test('ATH Móvil is a payment method; an unknown method is refused', async () => {
  const s = await setup()
  const id = await s.mk()
  const ok = await s.pay([[id, 4000]], { method: 'ath_movil' })
  expect(ok.status).toBe(201)
  expect(ok.body.receipt.method).toBe('ath_movil')
  expect(ok.body.receipt.snapshot.method).toBe('ath_movil')
  expect(await s.chargeRow(id)).toMatchObject({ paid_cents: 4000, payment_method: 'ath_movil' })
  expect((await s.pay([[id, 100]], { method: 'bitcoin' })).status).toBe(400)
  expect((await s.call(s.A, 'GET', '/meta')).body.paymentMethods).toEqual(['cash', 'card', 'check', 'transfer', 'ath_movil', 'other'])
})

test('a payment issues its receipt in the same act: numbered, in Spanish, with the balance left and nothing clinical', async () => {
  const s = await setup()
  const id = await s.mk({ feeCents: 11000, cptCode: '90791', diagnosisCodes: ['F41.1', 'F32.A'] })
  const first = await s.pay([[id, 4000]], { method: 'card' })
  expect(first.status).toBe(201)
  const r = first.body.receipt
  expect(r.number).toBe(`REC-${YEAR}-0001`)
  expect(r.paid_on).toBe('2026-11-05')
  expect(r.snapshot.client).toEqual({ name: 'Maria Lopez' })
  expect(r.snapshot.provider).toEqual({ name: 'Dra. Rivera', practiceName: 'Consultorio Rivera', address: 'Calle Luna 1, San Juan PR 00901', phone: '787-555-0000', email: 'dra@x.com' })
  expect(r.snapshot.lines).toEqual([{ chargeId: id, serviceDate: '2026-11-02', description: 'Evaluación inicial', amountCents: 4000, feeCents: 11000, balanceAfterCents: 7000 }])
  expect(r.snapshot.totals).toEqual({ paidCents: 4000 })
  // clients show these to employers and banks: no diagnosis, no CPT code, no tax id, no NPI, no licence
  expect(JSON.stringify(r.snapshot)).not.toMatch(/F41|F32|90791|PR-1234|1234567893|98-7654321/)

  const second = await s.pay([[id, 7000]], { method: 'ath_movil' })
  expect(second.body.receipt.number).toBe(`REC-${YEAR}-0002`)
  expect(second.body.receipt.snapshot.lines[0].balanceAfterCents).toBe(0)
  // the charge's figures are derived from its live payments: the total, and the method of the latest
  const row = await s.chargeRow(id)
  expect(row).toMatchObject({ paid_cents: 11000, payment_method: 'ath_movil' })
  expect(row.paid_at).toBeTruthy()
  expect(await s.db.query('SELECT 1 FROM payments')).toHaveLength(2)
})

test('one payment can cover several charges of a client: one receipt, a line each, in date order', async () => {
  const s = await setup()
  const late = await s.mk({ serviceDate: '2026-11-09' })
  const early = await s.mk({ serviceDate: '2026-11-02', cptCode: '90837', feeCents: 12000 })
  const r = (await s.pay([[late, 10000], [early, 5000]], { method: 'transfer' })).body.receipt
  expect(r.snapshot.lines.map((l: any) => [l.serviceDate, l.amountCents, l.balanceAfterCents])).toEqual([['2026-11-02', 5000, 7000], ['2026-11-09', 10000, 0]])
  expect(r.snapshot.totals.paidCents).toBe(15000)
  expect(await s.db.query('SELECT 1 FROM billing_receipts')).toHaveLength(1)
  expect(await s.db.query('SELECT 1 FROM payments')).toHaveLength(2)
  expect((await s.chargeRow(late)).paid_cents).toBe(10000)
  expect((await s.chargeRow(early)).paid_cents).toBe(5000)
})

test('a payment is refused when it does not fit: too much, nothing, someone else\'s charge, a voided one, or a bad date', async () => {
  const s = await setup()
  const id = await s.mk()
  const other = await s.mk({ contactId: 'c2' })
  const voided = await s.mk({ serviceDate: '2026-11-03' })
  await s.call(s.A, 'POST', `/charges/${voided}/void`, { reason: 'Entered twice' })
  const post = (b: unknown) => s.call(s.A, 'POST', '/payments', b)
  expect((await s.pay([[id, 10001]])).body.error).toBe('overpaid')
  expect((await s.pay([[id, 0]])).status).toBe(400)
  expect((await s.pay([[id, -5]])).status).toBe(400)
  expect((await s.pay([[id, 10.5]])).status).toBe(400)
  expect((await s.pay([])).status).toBe(400)
  expect((await s.pay([[id, 100], [id, 100]])).status).toBe(400) // the same charge twice
  expect((await s.pay([[other, 100]])).body.error).toBe('charges_unavailable') // c2's charge on c1's payment
  expect((await s.pay([[voided, 100]])).body.error).toBe('charges_unavailable')
  expect((await s.pay([['nope', 100]])).body.error).toBe('charges_unavailable')
  expect((await s.pay([[id, 100]], { contactId: 'nobody' })).body.error).toBe('unknown_contact')
  expect((await s.pay([[id, 100]], { paidOn: '2999-01-01' })).status).toBe(400)
  expect((await s.pay([[id, 100]], { paidOn: '2026-02-30' })).status).toBe(400)
  expect((await post({ contactId: 'c1', method: 'cash', allocations: [{ chargeId: id, amountCents: 1 }] })).status).toBe(400) // no date
  // exactly what is owed is fine, and after that nothing more can be taken
  expect((await s.pay([[id, 10000]])).status).toBe(201)
  expect((await s.pay([[id, 1]])).body.error).toBe('overpaid')
})

test('a payment is all or nothing: one bad line writes no receipt, no payment and burns no number', async () => {
  const s = await setup()
  const a = await s.mk()
  const b = await s.mk({ serviceDate: '2026-11-03' })
  const bad = await s.pay([[a, 5000], [b, 99999]])
  expect(bad.body.error).toBe('overpaid')
  expect(await s.db.query('SELECT 1 FROM billing_receipts')).toHaveLength(0)
  expect(await s.db.query('SELECT 1 FROM payments')).toHaveLength(0)
  expect((await s.chargeRow(a)).paid_cents).toBe(0)
  expect((await s.pay([[a, 5000]])).body.receipt.number).toBe(`REC-${YEAR}-0001`) // the first number is still free
})

test('two payments at once cannot together take more than is owed', async () => {
  const s = await setup()
  const id = await s.mk()
  const [x, y] = await Promise.all([s.pay([[id, 10000]]), s.pay([[id, 10000]], { method: 'card' })])
  expect([x.status, y.status].sort()).toEqual([201, 422])
  expect((await s.chargeRow(id)).paid_cents).toBe(10000)
  expect(await s.db.query('SELECT 1 FROM payments WHERE voided_at IS NULL')).toHaveLength(1)
})

test('if the stored total ever disagrees with the payments it is derived from, a new payment is refused rather than overwriting it', async () => {
  const s = await setup()
  const id = await s.mk()
  await s.pay([[id, 3000]])
  await s.pg.exec(`UPDATE charges SET paid_cents = 9000 WHERE id = '${id}'`) // written some other way
  const r = await s.pay([[id, 100]])
  expect([r.status, r.body.error]).toEqual([409, 'paid_mismatch'])
  expect((await s.chargeRow(id)).paid_cents).toBe(9000) // untouched
})

// --- voiding a receipt -----------------------------------------------------------------------------------------

test('voiding a receipt keeps it, voids the payments it proves and recomputes what each charge has paid', async () => {
  const s = await setup()
  const id = await s.mk()
  const r1 = (await s.pay([[id, 3000]], { method: 'cash' })).body.receipt
  const r2 = (await s.pay([[id, 2000]], { method: 'card' })).body.receipt
  expect((await s.call(s.A, 'POST', `/receipts/${r1.id}/void`, { reason: 'x' })).status).toBe(400)
  expect((await s.call(s.B, 'POST', `/receipts/${r1.id}/void`, { reason: 'Not yours at all' })).status).toBe(404)
  expect((await s.call(s.A, 'POST', `/receipts/${r1.id}/void`, { reason: 'Recorded on the wrong client' })).status).toBe(200)
  expect(await s.chargeRow(id)).toMatchObject({ paid_cents: 2000, payment_method: 'card' }) // the other payment stands
  expect((await s.call(s.A, 'POST', `/receipts/${r1.id}/void`, { reason: 'Voiding it twice' })).status).toBe(409)
  const shown = (await s.call(s.A, 'GET', `/receipts/${r1.id}`)).body.receipt
  expect(shown).toMatchObject({ number: r1.number, void_reason: 'Recorded on the wrong client' })
  expect(shown.voided_at).toBeTruthy()
  await s.call(s.A, 'POST', `/receipts/${r2.id}/void`, { reason: 'Also a mistake' })
  expect(await s.chargeRow(id)).toMatchObject({ paid_cents: 0, payment_method: null, paid_at: null })
  // the money can be taken again, under a new number (numbers are never reused)
  expect((await s.pay([[id, 10000]])).body.receipt.number).toBe(`REC-${YEAR}-0003`)
  const list = (await s.call(s.A, 'GET', '/receipts')).body.receipts
  expect(list.map((x: any) => [x.number, Boolean(x.voided_at), x.total_cents])).toEqual([[`REC-${YEAR}-0003`, false, 10000], [`REC-${YEAR}-0002`, true, 2000], [`REC-${YEAR}-0001`, true, 3000]])
})

test('the database never lets a payment or a receipt be edited or deleted, only voided once', async () => {
  const s = await setup()
  const id = await s.mk()
  const r = (await s.pay([[id, 3000]])).body.receipt
  expect(await dbError(s.db.query('UPDATE payments SET amount_cents = 1 WHERE receipt_id = $1', [r.id]))).toMatch(/payments_immutable/)
  expect(await dbError(s.db.query("UPDATE payments SET method = 'card' WHERE receipt_id = $1", [r.id]))).toMatch(/payments_immutable/)
  expect(await dbError(s.db.query('DELETE FROM payments WHERE receipt_id = $1', [r.id]))).toMatch(/payments_no_delete/)
  expect(await dbError(s.db.query(`UPDATE billing_receipts SET snapshot = '{}'::jsonb WHERE id = $1`, [r.id]))).toMatch(/billing_receipts_immutable/)
  expect(await dbError(s.db.query("UPDATE billing_receipts SET number = 'REC-1' WHERE id = $1", [r.id]))).toMatch(/billing_receipts_immutable/)
  expect(await dbError(s.db.query('DELETE FROM billing_receipts WHERE id = $1', [r.id]))).toMatch(/billing_receipts_no_delete/)
  expect(await dbError(s.db.query("INSERT INTO payments (id, location_id, contact_id, charge_id, receipt_id, amount_cents, method, paid_on, created_by) VALUES ('p0','loc_a','c1',$1,$2,0,'cash','2026-11-05','op1')", [id, r.id]))).toMatch(/amount_cents|check/i)
  await s.call(s.A, 'POST', `/receipts/${r.id}/void`, { reason: 'Recorded by mistake' })
  expect(await dbError(s.db.query("UPDATE billing_receipts SET void_reason = 'other' WHERE id = $1", [r.id]))).toMatch(/billing_receipts_voided/)
  expect(await dbError(s.db.query("UPDATE payments SET void_reason = 'other' WHERE receipt_id = $1", [r.id]))).toMatch(/payments_voided/)
})

// --- invoices --------------------------------------------------------------------------------------------------

test('an invoice is issued from charges: numbered, in Spanish, with what is due, and nothing clinical or tax-related', async () => {
  const s = await setup()
  const a = await s.mk({ serviceDate: '2026-11-02', cptCode: '90791', feeCents: 15000, diagnosisCodes: ['F41.1'] })
  const b = await s.mk({ serviceDate: '2026-11-09', feeCents: 10000 })
  await s.pay([[a, 5000]]) // already part-paid when invoiced
  const r = await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [b, a], dueOn: '2026-12-01', note: 'Se acepta efectivo, tarjeta, cheque o ATH Móvil.', clientAddress: 'Calle Sol 5, Ponce PR' })
  expect(r.status).toBe(201)
  const inv = r.body.invoice
  expect(inv.number).toBe(`FAC-${YEAR}-0001`)
  expect(inv.due_on).toBe('2026-12-01')
  expect(inv.snapshot.client).toEqual({ name: 'Maria Lopez', address: 'Calle Sol 5, Ponce PR' })
  expect(inv.snapshot.note).toBe('Se acepta efectivo, tarjeta, cheque o ATH Móvil.')
  expect(inv.snapshot.lines).toEqual([
    { chargeId: a, serviceDate: '2026-11-02', description: 'Evaluación inicial', feeCents: 15000, paidAtIssueCents: 5000, dueCents: 10000 },
    { chargeId: b, serviceDate: '2026-11-09', description: 'Sesión de terapia individual', feeCents: 10000, paidAtIssueCents: 0, dueCents: 10000 },
  ])
  expect(inv.snapshot.totals).toEqual({ billedCents: 25000, paidCents: 5000, dueCents: 20000 })
  expect(inv).toMatchObject({ status: 'open', balance_cents: 20000, paid_cents: 5000 })
  expect(JSON.stringify(inv.snapshot)).not.toMatch(/F41|90791|90834|PR-1234|1234567893|98-7654321/)
  expect(await s.chargeRow(a)).toMatchObject({ invoice_id: inv.id })
})

test('an invoice needs no NPI, tax id or diagnosis: those belong to the superbill only', async () => {
  const s = await setup()
  const id = await s.mk({ diagnosisCodes: [] })
  expect((await s.call(s.A, 'GET', '/profile')).body.profile).toMatchObject({ npi: '', hasTaxId: false })
  expect((await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id] })).status).toBe(201)
})

test('an invoice cannot be issued with anything missing, and the answer says exactly what', async () => {
  const s = await setup()
  const ok = await s.mk()
  const free = await s.mk({ feeCents: 0, serviceDate: '2026-11-03' })
  expect((await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [ok, free] })).body).toEqual({ error: 'incomplete', missing: [{ code: 'charge_zero_fee', chargeId: free }] })
  await s.db.query("UPDATE locations SET settings = jsonb_set(settings, '{practice}', $2::jsonb) WHERE id = $1", [s.locA, JSON.stringify({ ...PRACTICE, therapist: '', address: '' })])
  const r = await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [ok] })
  expect(r.body.missing.map((m: any) => m.code).sort()).toEqual(['practice_address', 'provider_name'])
  expect(await s.db.query('SELECT 1 FROM billing_invoices')).toHaveLength(0)
})

test('charges that are another client\'s, already invoiced, voided, unknown or from another practice are refused', async () => {
  const s = await setup()
  const mine = await s.mk()
  const other = await s.mk({ contactId: 'c2' })
  const voided = await s.mk({ serviceDate: '2026-11-05' })
  await s.call(s.A, 'POST', `/charges/${voided}/void`, { reason: 'Entered twice' })
  const issue = (ids: string[], app = s.A, contactId = 'c1') => s.call(app, 'POST', '/invoices', { contactId, chargeIds: ids })
  expect((await issue([mine, other])).body.error).toBe('charges_unavailable')
  expect((await issue([mine, voided])).body.error).toBe('charges_unavailable')
  expect((await issue([mine, 'nope'])).body.error).toBe('charges_unavailable')
  expect((await issue([mine], s.B, 'cb')).body.error).toBe('charges_unavailable')
  expect((await issue([mine], s.B)).body.error).toBe('unknown_contact')
  expect((await issue([mine], s.A, 'nobody')).body.error).toBe('unknown_contact')
  expect((await issue([])).status).toBe(400)
  expect((await issue([mine])).status).toBe(201)
  expect((await issue([mine])).body.error).toBe('charges_unavailable') // already on an invoice
  expect(await s.db.query('SELECT 1 FROM billing_invoices')).toHaveLength(1)
})

test('an invoice\'s state and balance follow the payments live, while the document itself stays as issued', async () => {
  const s = await setup()
  const id = await s.mk()
  const inv = (await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id] })).body.invoice
  const state = async () => { const i = (await s.call(s.A, 'GET', `/invoices/${inv.id}`)).body.invoice; return [i.status, i.balance_cents, i.paid_cents] }
  expect(await state()).toEqual(['open', 10000, 0])
  const r1 = (await s.pay([[id, 4000]])).body.receipt
  expect(await state()).toEqual(['open', 6000, 4000])
  expect((await s.call(s.A, 'GET', `/invoices/${inv.id}`)).body.invoice.paid_by_charge).toEqual({ [id]: 4000 })
  expect(r1.snapshot.invoices).toEqual([`FAC-${YEAR}-0001`]) // the receipt says which invoice it pays
  await s.pay([[id, 6000]], { method: 'ath_movil' })
  expect(await state()).toEqual(['paid', 0, 10000])
  // voiding a receipt re-opens it
  await s.call(s.A, 'POST', `/receipts/${r1.id}/void`, { reason: 'Recorded by mistake' })
  expect(await state()).toEqual(['open', 4000, 6000])
  // the frozen copy never moved
  const frozen = (await s.call(s.A, 'GET', `/invoices/${inv.id}`)).body.invoice.snapshot
  expect(frozen.totals).toEqual({ billedCents: 10000, paidCents: 0, dueCents: 10000 })
  const list = (await s.call(s.A, 'GET', '/invoices')).body.invoices
  expect(list.map((i: any) => [i.number, i.status, i.total_cents, i.balance_cents, i.line_count])).toEqual([[`FAC-${YEAR}-0001`, 'open', 10000, 4000, 1]])
})

test('while a charge is on an invoice its content is frozen, but it can still be paid', async () => {
  const s = await setup()
  const id = await s.mk()
  await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id] })
  expect((await s.call(s.A, 'PATCH', `/charges/${id}`, { feeCents: 1 })).body.error).toBe('issued')
  expect((await s.call(s.A, 'POST', `/charges/${id}/void`, { reason: 'Trying to void it' })).body.error).toBe('issued')
  expect(await dbError(s.db.query('UPDATE charges SET fee_cents = 1 WHERE id = $1', [id]))).toMatch(/charge_issued/)
  expect(await dbError(s.db.query("UPDATE charges SET cpt_code = '90837' WHERE id = $1", [id]))).toMatch(/charge_issued/)
  expect(await dbError(s.db.query('UPDATE charges SET invoice_id = NULL WHERE id = $1', [id]))).toMatch(/charge_issued/)
  expect(await dbError(s.db.query('DELETE FROM charges WHERE id = $1', [id]))).toMatch(/charge_no_delete/)
  expect((await s.pay([[id, 10000]])).status).toBe(201)
})

test('the database refuses to change, delete or void-then-edit an invoice, and refuses an invoice of another client', async () => {
  const s = await setup()
  const a = await s.mk()
  const b = await s.mk({ contactId: 'c2' })
  const inv = (await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [a] })).body.invoice
  expect(await dbError(s.db.query(`UPDATE billing_invoices SET snapshot = '{}'::jsonb WHERE id = $1`, [inv.id]))).toMatch(/billing_invoices_immutable/)
  expect(await dbError(s.db.query("UPDATE billing_invoices SET number = 'FAC-1' WHERE id = $1", [inv.id]))).toMatch(/billing_invoices_immutable/)
  expect(await dbError(s.db.query('DELETE FROM billing_invoices WHERE id = $1', [inv.id]))).toMatch(/billing_invoices_no_delete/)
  expect(await dbError(s.db.query('UPDATE charges SET invoice_id = $2 WHERE id = $1', [b, inv.id]))).toMatch(/charge_invoice_mismatch/) // c2's charge on c1's invoice
})

test('voiding an invoice keeps it, frees its charges, and lets a corrected one be issued under the next number', async () => {
  const s = await setup()
  const id = await s.mk()
  const inv = (await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id] })).body.invoice
  expect((await s.call(s.A, 'POST', `/invoices/${inv.id}/void`, { reason: 'x' })).status).toBe(400)
  expect((await s.call(s.B, 'POST', `/invoices/${inv.id}/void`, { reason: 'Not yours at all' })).status).toBe(404)
  expect((await s.call(s.A, 'POST', `/invoices/${inv.id}/void`, { reason: 'Wrong amount' })).status).toBe(200)
  expect((await s.call(s.A, 'POST', `/invoices/${inv.id}/void`, { reason: 'Voiding twice' })).status).toBe(409)
  const listed = (await s.call(s.A, 'GET', '/invoices')).body.invoices
  expect(listed[0]).toMatchObject({ number: `FAC-${YEAR}-0001`, status: 'void', void_reason: 'Wrong amount', balance_cents: 0, total_cents: 10000 })
  expect(await dbError(s.db.query("UPDATE billing_invoices SET void_reason = 'other' WHERE id = $1", [inv.id]))).toMatch(/billing_invoices_voided/)
  // the charge is free, can be corrected, and is invoiced again
  expect((await s.call(s.A, 'PATCH', `/charges/${id}`, { feeCents: 9000 })).status).toBe(200)
  const again = await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id] })
  expect(again.body.invoice.number).toBe(`FAC-${YEAR}-0002`)
  expect(again.body.invoice.snapshot.totals.billedCents).toBe(9000)
})

test('a charge can be on an invoice and a superbill at once; the two do not interfere', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/profile', { npi: NPI, taxId: EIN })
  const id = await s.mk()
  const inv = (await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id] })).body.invoice
  const sb = await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id] })
  expect(sb.status).toBe(201)
  expect(await s.chargeRow(id)).toMatchObject({ invoice_id: inv.id, superbill_id: sb.body.superbill.id })
  // voiding one leaves the other in place and the charge frozen by it
  await s.call(s.A, 'POST', `/invoices/${inv.id}/void`, { reason: 'Wrong amount' })
  expect(await s.chargeRow(id)).toMatchObject({ invoice_id: null, superbill_id: sb.body.superbill.id })
  expect((await s.call(s.A, 'PATCH', `/charges/${id}`, { feeCents: 1 })).body.error).toBe('issued')
  const charges = (await s.call(s.A, 'GET', '/charges')).body.charges
  expect(charges[0]).toMatchObject({ superbill_number: `SB-${YEAR}-0001`, invoice_number: null })
})

test('invoice, receipt and superbill numbers each count on their own', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/profile', { npi: NPI, taxId: EIN })
  const a = await s.mk()
  const b = await s.mk({ serviceDate: '2026-11-03' })
  expect((await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [a] })).body.invoice.number).toBe(`FAC-${YEAR}-0001`)
  expect((await s.pay([[a, 100]])).body.receipt.number).toBe(`REC-${YEAR}-0001`)
  expect((await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [a] })).body.superbill.number).toBe(`SB-${YEAR}-0001`)
  expect((await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [b] })).body.invoice.number).toBe(`FAC-${YEAR}-0002`)
})

test('two documents issued at once never share a number or a charge', async () => {
  const s = await setup()
  const ids = [await s.mk({ serviceDate: '2026-11-01' }), await s.mk({ serviceDate: '2026-11-02' })]
  const inv = await Promise.all(ids.map((id) => s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id] })))
  expect(inv.map((r) => r.status)).toEqual([201, 201])
  expect(inv.map((r) => r.body.invoice.number).sort()).toEqual([`FAC-${YEAR}-0001`, `FAC-${YEAR}-0002`])
  const rec = await Promise.all(ids.map((id) => s.pay([[id, 100]])))
  expect(rec.map((r) => r.status)).toEqual([201, 201])
  expect(rec.map((r) => r.body.receipt.number).sort()).toEqual([`REC-${YEAR}-0001`, `REC-${YEAR}-0002`])
})

// --- isolation and privacy -------------------------------------------------------------------------------------

test('one practice cannot see, open, print, void, pay or invoice another practice\'s charges and documents', async () => {
  const s = await setup()
  const id = await s.mk()
  const inv = (await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id] })).body.invoice
  const rec = (await s.pay([[id, 100]])).body.receipt
  expect((await s.call(s.B, 'GET', '/invoices')).body.invoices).toEqual([])
  expect((await s.call(s.B, 'GET', '/receipts')).body.receipts).toEqual([])
  expect((await s.call(s.B, 'GET', `/invoices/${inv.id}`)).status).toBe(404)
  expect((await s.call(s.B, 'GET', `/receipts/${rec.id}`)).status).toBe(404)
  expect((await s.call(s.B, 'POST', `/invoices/${inv.id}/printed`)).status).toBe(404)
  expect((await s.call(s.B, 'POST', `/receipts/${rec.id}/printed`)).status).toBe(404)
  expect((await s.pay([[id, 100]], { contactId: 'cb' }, s.B)).body.error).toBe('charges_unavailable')
  expect((await s.call(s.A, 'GET', '/invoices?contactId=c1')).body.invoices).toHaveLength(1)
  expect((await s.call(s.B, 'GET', '/invoices?contactId=c1')).body.invoices).toEqual([])
  expect((await s.call(s.B, 'GET', '/receipts?contactId=c1')).body.receipts).toEqual([])
})

test('opening and printing are audited; the audit log never holds names, diagnoses, addresses, the tax id or what was typed as a reason', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/profile', { npi: NPI, taxId: EIN })
  const id = await s.mk({ diagnosisCodes: ['F41.1'] })
  const inv = (await s.call(s.A, 'POST', '/invoices', { contactId: 'c1', chargeIds: [id], clientAddress: 'Calle Sol 5, Ponce', note: 'Pagar a Dra. Rivera por ATH' })).body.invoice
  const rec = (await s.pay([[id, 4000]], { method: 'ath_movil' })).body.receipt
  await s.call(s.A, 'GET', `/invoices/${inv.id}`)
  await s.call(s.A, 'POST', `/invoices/${inv.id}/printed`)
  await s.call(s.A, 'GET', `/receipts/${rec.id}`)
  await s.call(s.A, 'POST', `/receipts/${rec.id}/printed`)
  await s.call(s.A, 'POST', `/receipts/${rec.id}/void`, { reason: 'Maria Lopez pagó dos veces por error' })
  await s.call(s.A, 'POST', `/invoices/${inv.id}/void`, { reason: 'Factura de Maria Lopez con monto equivocado' })
  const actions = (await s.db.query<{ action: string }>("SELECT action FROM audit_log WHERE action ~ '^(invoice|receipt|payment)\\.' ORDER BY id")).map((r) => r.action)
  expect(actions).toEqual(['invoice.issued', 'payment.recorded', 'receipt.issued', 'invoice.viewed', 'invoice.printed', 'receipt.viewed', 'receipt.printed', 'receipt.voided', 'invoice.voided'])
  const dump = JSON.stringify(await s.db.query('SELECT details, entity_id, actor_label FROM audit_log'))
  expect(dump).not.toMatch(/Maria|Lopez|F41|Calle|Ponce|98-7654321|987654321|1234567893|Rivera|equivocado|dos veces|1990-04-12/)
  expect(dump).toContain('ath_movil') // the method is there; nothing personal is
  // and the typed reasons do live on the documents themselves
  expect((await s.call(s.A, 'GET', `/receipts/${rec.id}`)).body.receipt.void_reason).toBe('Maria Lopez pagó dos veces por error')
})

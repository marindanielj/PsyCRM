import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { addLocation, freshDb } from '../test-utils/pglite'
import { billingRoute } from './billing'

const SECRET = 'a-session-secret-that-is-long-enough-0123456789'
const YEAR = new Date().getUTCFullYear()
const PRACTICE = { name: 'Consultorio Rivera', therapist: 'Dra. Rivera', license: 'PR-1234', address: 'Calle Luna 1, San Juan PR 00901', phone: '787-555-0000', email: 'dra@x.com', fees: { session: '$100', intake: '$150', late_cancel: '$50' }, policy: { cancel_hours: '24' } }
const NPI = '1234567893'
const EIN = '98-7654321' // chosen so its digits do not overlap the NPI fixture

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
  await contact('c2', locA, 'Juan Perez', null)
  await contact('cb', locB, 'Ana Ruiz', '1985-01-01')
  // signed notes, inserted with triggers off (the clinical machinery is tested elsewhere)
  const note = (id: string, loc: string, contact_: string, type: string, modality: string, minutes: number, dx: string[], status = 'signed', date = '2026-11-02') =>
    pg.exec(`SET session_replication_role = replica;
      INSERT INTO session_notes (id, location_id, contact_id, session_date, duration_min, modality, session_type, diagnosis_codes, status, signed_at, signed_by, created_by,
        risk_suicidal, risk_self_harm, risk_harm_others, risk_level)
      VALUES ('${id}','${loc}','${contact_}','${date}',${minutes},'${modality}','${type}','{${dx.join(',')}}','${status}',${status === 'signed' ? 'now()' : 'NULL'},${status === 'signed' ? "'op1'" : 'NULL'},'op1','denied','denied','denied','low');
      SET session_replication_role = DEFAULT;`)
  await note('n1', locA, 'c1', 'individual', 'in_person', 50, ['F41.1', 'F32.A'])
  await note('n2', locA, 'c1', 'intake', 'telehealth_video', 60, ['F41.1'], 'signed', '2026-11-01')
  await note('n3', locA, 'c1', 'individual', 'in_person', 50, ['F41.1'], 'draft', '2026-11-03')
  await note('nb', locB, 'cb', 'individual', 'in_person', 50, ['F43.10'])

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
  /** A fully set-up practice: NPI and tax id saved. */
  const completeProfile = (app = A) => call(app, 'PUT', '/profile', { npi: NPI, taxId: EIN })
  return { db, pg, locA, locB, A, B, call, charge, completeProfile }
}

const dbError = async (p: Promise<unknown>) => { try { await p } catch (e) { return String((e as Error).message) } return null }

// --- profile ---------------------------------------------------------------------------------------------------

test('the NPI must pass its check digit, the tax id must be an EIN or SSN, and nothing else is accepted', async () => {
  const s = await setup()
  expect((await s.call(s.A, 'PUT', '/profile', { npi: '1234567890' })).body.error).toBe('invalid_npi')
  expect((await s.call(s.A, 'PUT', '/profile', { taxId: '12345' })).body.error).toBe('invalid_tax_id')
  expect((await s.call(s.A, 'PUT', '/profile', { taxonomy: 'nope' })).body.error).toBe('invalid_taxonomy')
  expect((await s.call(s.A, 'PUT', '/profile', { fees: { 'bad': 100 } })).body.error).toBe('invalid_cpt')
  expect((await s.call(s.A, 'PUT', '/profile', { fees: { '90837': -5 } })).status).toBe(400)
  const ok = await s.call(s.A, 'PUT', '/profile', { npi: NPI, taxonomy: '103tc0700x', telehealthPos: '02', fees: { '90837': 12000, '90791': 15000 } })
  expect(ok.status).toBe(200)
  expect(ok.body.profile).toMatchObject({ npi: NPI, taxonomy: '103TC0700X', telehealthPos: '02', hasTaxId: false, fees: { '90837': 12000, '90791': 15000 } })
})

test('the tax id is stored sealed, never returned, and never written to the audit log', async () => {
  const s = await setup()
  const saved = await s.call(s.A, 'PUT', '/profile', { taxId: '123-45-6789' })
  expect(saved.body.profile).toMatchObject({ hasTaxId: true, taxIdType: 'ssn', taxIdLast4: '6789' })
  expect(JSON.stringify(saved.body)).not.toMatch(/12345|123-45/)
  expect(JSON.stringify((await s.call(s.A, 'GET', '/profile')).body)).not.toMatch(/12345|123-45/)
  const stored = JSON.stringify(await s.db.query('SELECT settings FROM locations'))
  expect(stored).not.toMatch(/123-45-6789|123456789/)
  expect(stored).toContain('taxIdSealed')
  const audit = await s.db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'billing.profile_updated'")
  expect(audit).toHaveLength(1)
  expect(audit[0]!.details).toEqual({ fields: ['tax_id'] })
  // it can be removed; saving the same profile again changes (and logs) nothing
  expect((await s.call(s.A, 'PUT', '/profile', { taxId: null })).body.profile).toMatchObject({ hasTaxId: false, taxIdLast4: null })
  await s.call(s.A, 'PUT', '/profile', { taxId: null })
  expect(await s.db.query("SELECT 1 FROM audit_log WHERE action = 'billing.profile_updated'")).toHaveLength(2)
})

test('each practice has its own billing profile', async () => {
  const s = await setup()
  await s.completeProfile()
  expect((await s.call(s.B, 'GET', '/profile')).body.profile).toMatchObject({ npi: '', hasTaxId: false })
})

// --- suggestions -----------------------------------------------------------------------------------------------

test('signed notes without a charge are offered pre-filled; drafts and other practices\' notes are not', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/profile', { telehealthPos: '10', fees: { '90834': 11000, '90791': 16000 } })
  const { body } = await s.call(s.A, 'GET', '/suggestions')
  const byNote = Object.fromEntries(body.suggestions.map((x: any) => [x.note_id, x]))
  expect(Object.keys(byNote).sort()).toEqual(['n1', 'n2']) // n3 is a draft; nb is another practice's
  expect(byNote.n1).toMatchObject({ contact_id: 'c1', service_date: '2026-11-02', cpt_code: '90834', place_of_service: '11', modifiers: [], diagnosis_codes: ['F41.1', 'F32.A'], fee_cents: 11000 })
  expect(byNote.n2).toMatchObject({ cpt_code: '90791', place_of_service: '10', modifiers: ['95'], fee_cents: 16000 })
  expect((await s.call(s.B, 'GET', '/suggestions')).body.suggestions.map((x: any) => x.note_id)).toEqual(['nb'])
})

test('with no usual fee set for a code, the suggestion falls back to the Practice honorarium (intake or session)', async () => {
  const s = await setup()
  const byNote = async () => Object.fromEntries((await s.call(s.A, 'GET', '/suggestions')).body.suggestions.map((x: any) => [x.note_id, x]))
  // the practice profile says $100 per session and $150 for an intake
  expect((await byNote()).n1.fee_cents).toBe(10000)
  expect((await byNote()).n2.fee_cents).toBe(15000)
  // a usual fee for that exact code wins
  await s.call(s.A, 'PUT', '/profile', { fees: { '90834': 12500 } })
  expect((await byNote()).n1.fee_cents).toBe(12500)
  expect((await byNote()).n2.fee_cents).toBe(15000)
  // honoraria that are not plain money ("negotiable") leave the fee for her to enter
  await s.db.query("UPDATE locations SET settings = jsonb_set(settings, '{practice,fees}', '{\"session\":\"sliding scale\",\"intake\":\"\",\"late_cancel\":\"\"}') WHERE id = $1", [s.locA])
  await s.call(s.A, 'PUT', '/profile', { fees: {} })
  expect((await byNote()).n1.fee_cents).toBeNull()
  expect((await byNote()).n2.fee_cents).toBeNull()
})

test('a note stops being offered once charged, and is offered again if that charge is voided', async () => {
  const s = await setup()
  const made = await s.call(s.A, 'POST', '/charges', s.charge({ sessionNoteId: 'n1' }))
  expect(made.status).toBe(201)
  expect((await s.call(s.A, 'GET', '/suggestions')).body.suggestions.map((x: any) => x.note_id)).toEqual(['n2'])
  await s.call(s.A, 'POST', `/charges/${made.body.charge.id}/void`, { reason: 'Entered by mistake' })
  expect((await s.call(s.A, 'GET', '/suggestions')).body.suggestions.map((x: any) => x.note_id).sort()).toEqual(['n1', 'n2'])
})

// --- charges ---------------------------------------------------------------------------------------------------

test('a charge is validated: codes have the right shape and are normalised, money is whole cents', async () => {
  const s = await setup()
  const post = (over: Record<string, unknown>) => s.call(s.A, 'POST', '/charges', s.charge(over))
  expect((await post({ cptCode: '9083' })).status).toBe(400)
  expect((await post({ diagnosisCodes: ['not a code'] })).status).toBe(400)
  expect((await post({ modifiers: ['xyz'] })).status).toBe(400)
  expect((await post({ placeOfService: '1' })).status).toBe(400)
  expect((await post({ serviceDate: '2026-02-30' })).status).toBe(400)
  expect((await post({ feeCents: 10.5 })).status).toBe(400)
  expect((await post({ feeCents: -1 })).status).toBe(400)
  expect((await post({ feeCents: 10_000_001 })).status).toBe(400)
  expect((await post({ units: 0 })).status).toBe(400)
  expect((await post({ diagnosisCodes: Array.from({ length: 13 }, (_, i) => `F${10 + i}.1`) })).status).toBe(400)
  const ok = await post({ cptCode: '90834', diagnosisCodes: ['f411', 'F41.1', ' f32.a '], modifiers: ['95'] })
  expect(ok.status).toBe(201)
  expect(ok.body.charge).toMatchObject({ cpt_code: '90834', diagnosis_codes: ['F41.1', 'F32.A'], modifiers: ['95'], units: 1, fee_cents: 10000, paid_cents: 0, service_date: '2026-11-02' })
})

test('a charge needs a client of this practice, and its note must be that client\'s own signed note', async () => {
  const s = await setup()
  expect((await s.call(s.A, 'POST', '/charges', s.charge({ contactId: 'nobody' }))).body.error).toBe('unknown_contact')
  expect((await s.call(s.A, 'POST', '/charges', s.charge({ contactId: 'cb' }))).body.error).toBe('unknown_contact') // another practice's client
  expect((await s.call(s.A, 'POST', '/charges', s.charge({ contactId: 'c2', sessionNoteId: 'n1' }))).body.error).toBe('unknown_note') // c1's note
  expect((await s.call(s.A, 'POST', '/charges', s.charge({ sessionNoteId: 'n3' }))).body.error).toBe('unknown_note') // a draft
  expect((await s.call(s.A, 'POST', '/charges', s.charge({ sessionNoteId: 'nb' }))).body.error).toBe('unknown_note') // another practice's
  expect((await s.call(s.A, 'POST', '/charges', s.charge({ appointmentId: 'nope' }))).body.error).toBe('unknown_appointment')
})

test('one live charge per note, even when two requests race', async () => {
  const s = await setup()
  const [a, b] = await Promise.all([s.call(s.A, 'POST', '/charges', s.charge({ sessionNoteId: 'n1' })), s.call(s.A, 'POST', '/charges', s.charge({ sessionNoteId: 'n1' }))])
  expect([a.status, b.status].sort()).toEqual([201, 409])
  expect([a, b].find((r) => r.status === 409)!.body.error).toBe('note_already_charged')
  expect(await s.db.query('SELECT 1 FROM charges')).toHaveLength(1)
})

test('a charge can be edited until it is on a superbill; an edit that changes nothing is refused', async () => {
  const s = await setup()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const edited = await s.call(s.A, 'PATCH', `/charges/${id}`, { feeCents: 12000, cptCode: '90837', diagnosisCodes: ['f32.a'] })
  expect(edited.body.charge).toMatchObject({ fee_cents: 12000, cpt_code: '90837', diagnosis_codes: ['F32.A'] })
  expect((await s.call(s.A, 'PATCH', `/charges/${id}`, { feeCents: 12000 })).body.error).toBe('nothing_to_change')
  expect((await s.call(s.A, 'PATCH', `/charges/${id}`, { cptCode: 'bad' })).status).toBe(400)
  await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 5000, method: 'cash' })
  expect((await s.call(s.A, 'PATCH', `/charges/${id}`, { feeCents: 4000 })).body.error).toBe('overpaid') // below what was already paid
  expect((await s.call(s.B, 'PATCH', `/charges/${id}`, { feeCents: 1 })).status).toBe(404)
})

test('payments set the total paid: a method is required, it cannot exceed the fee, and zero clears it', async () => {
  const s = await setup()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  expect((await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 5000 })).status).toBe(400) // no method
  expect((await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 10001, method: 'card' })).body.error).toBe('overpaid')
  const half = await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 5000, method: 'card' })
  expect(half.body.charge).toMatchObject({ paid_cents: 5000, payment_method: 'card' })
  expect(half.body.charge.paid_at).toBeTruthy()
  const full = await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 10000, method: 'cash' })
  expect(full.body.charge).toMatchObject({ paid_cents: 10000, payment_method: 'cash' })
  const cleared = await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 0 })
  expect(cleared.body.charge).toMatchObject({ paid_cents: 0, payment_method: null, paid_at: null })
  expect((await s.call(s.B, 'PUT', `/charges/${id}/payment`, { paidCents: 100, method: 'cash' })).status).toBe(404)
  const log = await s.db.query<{ details: { from: number; to: number } }>("SELECT details FROM audit_log WHERE action = 'charge.payment_recorded' ORDER BY id")
  expect(log.map((r) => [r.details.from, r.details.to])).toEqual([[0, 5000], [5000, 10000], [10000, 0]])
})

test('a voided charge needs a reason, stays visible, and cannot be changed again', async () => {
  const s = await setup()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  expect((await s.call(s.A, 'POST', `/charges/${id}/void`, { reason: 'x' })).status).toBe(400)
  const v = await s.call(s.A, 'POST', `/charges/${id}/void`, { reason: 'Session was cancelled' })
  expect(v.body.charge).toMatchObject({ void_reason: 'Session was cancelled' })
  expect(v.body.charge.voided_at).toBeTruthy()
  for (const r of [await s.call(s.A, 'PATCH', `/charges/${id}`, { feeCents: 1 }), await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 1, method: 'cash' }), await s.call(s.A, 'POST', `/charges/${id}/void`, { reason: 'again again' })]) {
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('voided')
  }
  expect((await s.call(s.A, 'GET', '/charges?status=void')).body.charges).toHaveLength(1)
  expect((await s.call(s.A, 'GET', '/charges?status=unbilled')).body.charges).toHaveLength(0)
})

test('the charge list can be filtered by client and status, and only shows this practice\'s charges', async () => {
  const s = await setup()
  await s.call(s.A, 'POST', '/charges', s.charge())
  await s.call(s.A, 'POST', '/charges', s.charge({ contactId: 'c2', serviceDate: '2026-11-03' }))
  expect((await s.call(s.A, 'GET', '/charges')).body.charges.map((c: any) => c.contact_name).sort()).toEqual(['Juan Perez', 'Maria Lopez'])
  expect((await s.call(s.A, 'GET', '/charges?contactId=c2')).body.charges).toHaveLength(1)
  expect((await s.call(s.B, 'GET', '/charges')).body.charges).toEqual([])
  expect((await s.call(s.B, 'GET', '/charges?contactId=c2')).body.charges).toEqual([])
})

// --- issuing a superbill ---------------------------------------------------------------------------------------

test('a superbill cannot be issued with anything missing, and the answer says exactly what', async () => {
  const s = await setup()
  const ok = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const noDx = (await s.call(s.A, 'POST', '/charges', s.charge({ diagnosisCodes: [], serviceDate: '2026-11-03' }))).body.charge.id
  const free = (await s.call(s.A, 'POST', '/charges', s.charge({ feeCents: 0, serviceDate: '2026-11-04' }))).body.charge.id
  const r = await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [ok, noDx, free] })
  expect(r.status).toBe(422)
  expect(r.body.error).toBe('incomplete')
  expect(r.body.missing).toEqual(expect.arrayContaining([{ code: 'provider_npi' }, { code: 'provider_tax_id' }, { code: 'charge_no_diagnosis', chargeId: noDx }, { code: 'charge_zero_fee', chargeId: free }]))
  expect(r.body.missing).not.toContainEqual({ code: 'practice_license' }) // that one is set
  expect(await s.db.query('SELECT 1 FROM superbills')).toHaveLength(0)

  // a client without a date of birth, and a practice without a licence or address
  await s.completeProfile()
  const c2 = (await s.call(s.A, 'POST', '/charges', s.charge({ contactId: 'c2' }))).body.charge.id
  await s.db.query("UPDATE locations SET settings = jsonb_set(settings, '{practice}', $2::jsonb) WHERE id = $1", [s.locA, JSON.stringify({ ...PRACTICE, license: '', address: '' })])
  const r2 = await s.call(s.A, 'POST', '/superbills', { contactId: 'c2', chargeIds: [c2] })
  expect(r2.body.missing.map((m: any) => m.code).sort()).toEqual(['client_date_of_birth', 'practice_address', 'practice_license'])
})

test('issuing freezes a complete superbill: numbered, with diagnosis letters, pointers and totals', async () => {
  const s = await setup()
  await s.completeProfile()
  const a = (await s.call(s.A, 'POST', '/charges', s.charge({ diagnosisCodes: ['F41.1', 'F32.A'], feeCents: 11000, serviceDate: '2026-11-01', cptCode: '90791' }))).body.charge.id
  const b = (await s.call(s.A, 'POST', '/charges', s.charge({ diagnosisCodes: ['F32.A'], feeCents: 10000, serviceDate: '2026-11-08', modifiers: ['95'], placeOfService: '10' }))).body.charge.id
  await s.call(s.A, 'PUT', `/charges/${a}/payment`, { paidCents: 11000, method: 'card' })
  const r = await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [b, a], clientAddress: 'Calle Sol 5, Ponce PR', memberId: 'XYZ123' })
  expect(r.status).toBe(201)
  const sb = r.body.superbill
  expect(sb.number).toBe(`SB-${YEAR}-0001`)
  expect(sb.period_from).toBe('2026-11-01')
  expect(sb.period_to).toBe('2026-11-08')
  expect(sb.snapshot.diagnoses).toEqual([{ letter: 'A', code: 'F41.1' }, { letter: 'B', code: 'F32.A' }])
  expect(sb.snapshot.lines.map((l: any) => [l.date, l.cpt, l.dxPointers, l.feeCents, l.paidCents, l.modifiers, l.placeOfService])).toEqual([
    ['2026-11-01', '90791', 'AB', 11000, 11000, [], '11'],
    ['2026-11-08', '90834', 'B', 10000, 0, ['95'], '10'],
  ])
  expect(sb.snapshot.lines[0].label).toBe('Diagnostic evaluation (intake)')
  expect(sb.snapshot.totals).toEqual({ billedCents: 21000, paidCents: 11000, balanceCents: 10000 })
  expect(sb.snapshot.client).toEqual({ name: 'Maria Lopez', dateOfBirth: '1990-04-12', address: 'Calle Sol 5, Ponce PR', memberId: 'XYZ123' })
  expect(sb.snapshot.provider).toMatchObject({ name: 'Dra. Rivera', practiceName: 'Consultorio Rivera', license: 'PR-1234', npi: NPI, taxId: EIN, taxIdLast4: '4321' })
  expect(sb.snapshot.provider.taxIdSealed).toBeUndefined() // the sealed copy never leaves the server

  // the charges are now billed
  expect((await s.call(s.A, 'GET', '/charges?status=billed')).body.charges.map((c: any) => c.superbill_number)).toEqual([`SB-${YEAR}-0001`, `SB-${YEAR}-0001`])
  expect((await s.call(s.A, 'GET', '/charges?status=unbilled')).body.charges).toEqual([])
  // numbers go on in order
  const c = (await s.call(s.A, 'POST', '/charges', s.charge({ serviceDate: '2026-11-15' }))).body.charge.id
  expect((await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [c] })).body.superbill.number).toBe(`SB-${YEAR}-0002`)
})

test('the stored copy keeps the tax id sealed, and the full number appears only when the superbill is shown', async () => {
  const s = await setup()
  await s.completeProfile()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const sbId = (await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id] })).body.superbill.id
  const raw = JSON.stringify((await s.db.query('SELECT snapshot FROM superbills'))[0])
  expect(raw).not.toMatch(/98-7654321|987654321/)
  expect(raw).toContain('taxIdSealed')
  const shown = (await s.call(s.A, 'GET', `/superbills/${sbId}`)).body.superbill
  expect(shown.snapshot.provider.taxId).toBe(EIN)
  expect(JSON.stringify(shown)).not.toContain('taxIdSealed')
})

test('a superbill is a snapshot: changing the profile or the charge afterwards does not alter it', async () => {
  const s = await setup()
  await s.completeProfile()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const sbId = (await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id] })).body.superbill.id
  await s.call(s.A, 'PUT', '/profile', { npi: '', taxId: '55-5555555' })
  await s.db.query("UPDATE locations SET settings = jsonb_set(settings, '{practice,license}', '\"CHANGED\"') WHERE id = $1", [s.locA])
  await s.db.query("UPDATE contacts SET name = 'Renamed Person' WHERE id = 'c1'")
  const sb = (await s.call(s.A, 'GET', `/superbills/${sbId}`)).body.superbill
  expect(sb.snapshot.provider).toMatchObject({ npi: NPI, license: 'PR-1234', taxId: EIN })
  expect(sb.snapshot.client.name).toBe('Maria Lopez')
})

test('charges that are another client\'s, already billed, voided, unknown or from another practice are refused', async () => {
  const s = await setup()
  await s.completeProfile()
  await s.completeProfile(s.B)
  const mine = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const other = (await s.call(s.A, 'POST', '/charges', s.charge({ contactId: 'c2' }))).body.charge.id
  const voided = (await s.call(s.A, 'POST', '/charges', s.charge({ serviceDate: '2026-11-05' }))).body.charge.id
  await s.call(s.A, 'POST', `/charges/${voided}/void`, { reason: 'Entered twice' })
  const issue = (ids: string[], app = s.A, contactId = 'c1') => s.call(app, 'POST', '/superbills', { contactId, chargeIds: ids })
  expect((await issue([mine, other])).body.error).toBe('charges_unavailable') // c2's charge on c1's superbill
  expect((await issue([mine, voided])).body.error).toBe('charges_unavailable')
  expect((await issue([mine, 'nope'])).body.error).toBe('charges_unavailable')
  expect((await issue([mine], s.B, 'cb')).body.error).toBe('charges_unavailable') // practice B using practice A's charge
  expect((await issue([mine], s.B)).body.error).toBe('unknown_contact')
  expect((await issue([mine], s.A, 'nobody')).body.error).toBe('unknown_contact')
  expect((await issue([])).status).toBe(400)
  expect((await issue([mine])).status).toBe(201)
  expect((await issue([mine])).body.error).toBe('charges_unavailable') // already on a superbill
  expect(await s.db.query('SELECT 1 FROM superbills')).toHaveLength(1)
})

test('more than twelve different diagnoses on one superbill is refused', async () => {
  const s = await setup()
  await s.completeProfile()
  const codes = ['F10.10', 'F11.10', 'F12.10', 'F13.10', 'F14.10', 'F15.10', 'F16.10', 'F18.10', 'F19.10', 'F20.0', 'F22', 'F23', 'F25.0']
  const a = (await s.call(s.A, 'POST', '/charges', s.charge({ diagnosisCodes: codes.slice(0, 7) }))).body.charge.id
  const b = (await s.call(s.A, 'POST', '/charges', s.charge({ diagnosisCodes: codes.slice(7), serviceDate: '2026-11-03' }))).body.charge.id
  expect((await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [a, b] })).body.error).toBe('too_many_diagnoses')
})

test('two superbills issued at once never share a number or a charge', async () => {
  const s = await setup()
  await s.completeProfile()
  const ids = [] as string[]
  for (let i = 1; i <= 2; i++) ids.push((await s.call(s.A, 'POST', '/charges', s.charge({ serviceDate: `2026-11-0${i}` }))).body.charge.id)
  const [x, y] = await Promise.all(ids.map((id) => s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id] })))
  expect([x!.status, y!.status]).toEqual([201, 201])
  expect([x!.body.superbill.number, y!.body.superbill.number].sort()).toEqual([`SB-${YEAR}-0001`, `SB-${YEAR}-0002`])
})

// --- what the database itself enforces --------------------------------------------------------------------------

test('once issued, the database refuses to change, delete or re-point the superbill or its charges', async () => {
  const s = await setup()
  await s.completeProfile()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const sbId = (await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id] })).body.superbill.id

  // through the API
  expect((await s.call(s.A, 'PATCH', `/charges/${id}`, { feeCents: 1 })).body.error).toBe('issued')
  expect((await s.call(s.A, 'POST', `/charges/${id}/void`, { reason: 'Trying to void it' })).body.error).toBe('issued')
  // directly in SQL: a bug in the application could not do it either
  expect(await dbError(s.db.query('UPDATE charges SET fee_cents = 1 WHERE id = $1', [id]))).toMatch(/charge_issued/)
  expect(await dbError(s.db.query("UPDATE charges SET cpt_code = '90837' WHERE id = $1", [id]))).toMatch(/charge_issued/)
  expect(await dbError(s.db.query("UPDATE charges SET diagnosis_codes = '{Z00.0}' WHERE id = $1", [id]))).toMatch(/charge_issued/)
  expect(await dbError(s.db.query('UPDATE charges SET superbill_id = NULL WHERE id = $1', [id]))).toMatch(/charge_issued/)
  expect(await dbError(s.db.query('DELETE FROM charges WHERE id = $1', [id]))).toMatch(/charge_no_delete/)
  expect(await dbError(s.db.query(`UPDATE superbills SET snapshot = '{}'::jsonb WHERE id = $1`, [sbId]))).toMatch(/superbill_immutable/)
  expect(await dbError(s.db.query("UPDATE superbills SET number = 'SB-1' WHERE id = $1", [sbId]))).toMatch(/superbill_immutable/)
  expect(await dbError(s.db.query('DELETE FROM superbills WHERE id = $1', [sbId]))).toMatch(/superbill_no_delete/)
  // ...but a payment can still be written down
  expect((await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 10000, method: 'check' })).status).toBe(200)
})

test('the database refuses a superbill that mixes clients, a live superbill on another client\'s charge, and bad money', async () => {
  const s = await setup()
  await s.completeProfile()
  const c1 = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const c2 = (await s.call(s.A, 'POST', '/charges', s.charge({ contactId: 'c2' }))).body.charge.id
  const sbId = (await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [c1] })).body.superbill.id
  expect(await dbError(s.db.query('UPDATE charges SET superbill_id = $2 WHERE id = $1', [c2, sbId]))).toMatch(/charge_superbill_mismatch/)
  expect(await dbError(s.db.query('UPDATE charges SET paid_cents = 20000 WHERE id = $1', [c2]))).toMatch(/charge_not_overpaid/)
  expect(await dbError(s.db.query("UPDATE charges SET paid_cents = 100 WHERE id = $1", [c2]))).toMatch(/charge_payment_complete/)
  expect(await dbError(s.db.query("INSERT INTO charges (id, location_id, contact_id, service_date, cpt_code, fee_cents, created_by) VALUES ('x','loc_a','c1','2026-11-01','nope',1,'op1')"))).toMatch(/cpt_code|check/i)
  expect(await dbError(s.db.query("INSERT INTO charges (id, location_id, contact_id, service_date, cpt_code, fee_cents, created_by) VALUES ('y','loc_a','c1','2026-11-01','90834',-1,'op1')"))).toMatch(/fee_cents|check/i)
})

// --- voiding a superbill ---------------------------------------------------------------------------------------

test('voiding a superbill keeps it, frees its charges, and lets a corrected one be issued', async () => {
  const s = await setup()
  await s.completeProfile()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const sbId = (await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id] })).body.superbill.id
  expect((await s.call(s.A, 'POST', `/superbills/${sbId}/void`, { reason: 'x' })).status).toBe(400)
  expect((await s.call(s.B, 'POST', `/superbills/${sbId}/void`, { reason: 'Not yours at all' })).status).toBe(404)
  expect((await s.call(s.A, 'POST', `/superbills/${sbId}/void`, { reason: 'Wrong diagnosis' })).status).toBe(200)
  expect((await s.call(s.A, 'POST', `/superbills/${sbId}/void`, { reason: 'Voiding twice' })).status).toBe(409)
  // it is still there, marked void
  const listed = (await s.call(s.A, 'GET', '/superbills')).body.superbills
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({ number: `SB-${YEAR}-0001`, void_reason: 'Wrong diagnosis', total_cents: 10000, line_count: 1 })
  expect(listed[0].voided_at).toBeTruthy()
  // a voided superbill never changes again
  expect(await dbError(s.db.query("UPDATE superbills SET void_reason = 'other' WHERE id = $1", [sbId]))).toMatch(/superbill_voided/)
  // the charge is free again, can be corrected, and goes on a new superbill with the next number (never reused)
  expect((await s.call(s.A, 'PATCH', `/charges/${id}`, { diagnosisCodes: ['F32.A'] })).status).toBe(200)
  const again = await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id] })
  expect(again.status).toBe(201)
  expect(again.body.superbill.number).toBe(`SB-${YEAR}-0002`)
  expect(again.body.superbill.snapshot.diagnoses).toEqual([{ letter: 'A', code: 'F32.A' }])
})

// --- isolation and privacy -------------------------------------------------------------------------------------

test('one practice cannot see or open another practice\'s superbills', async () => {
  const s = await setup()
  await s.completeProfile()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge())).body.charge.id
  const sbId = (await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id] })).body.superbill.id
  expect((await s.call(s.B, 'GET', '/superbills')).body.superbills).toEqual([])
  expect((await s.call(s.B, 'GET', `/superbills/${sbId}`)).status).toBe(404)
  expect((await s.call(s.B, 'POST', `/superbills/${sbId}/printed`)).status).toBe(404)
  expect((await s.call(s.A, 'GET', '/superbills?contactId=c1')).body.superbills).toHaveLength(1)
  expect((await s.call(s.B, 'GET', '/superbills?contactId=c1')).body.superbills).toEqual([])
})

test('opening and printing a superbill are audited; the audit log never holds names, diagnoses, addresses or the tax id', async () => {
  const s = await setup()
  await s.completeProfile()
  const id = (await s.call(s.A, 'POST', '/charges', s.charge({ sessionNoteId: 'n1' }))).body.charge.id
  const sbId = (await s.call(s.A, 'POST', '/superbills', { contactId: 'c1', chargeIds: [id], clientAddress: 'Calle Sol 5, Ponce', memberId: 'XYZ123' })).body.superbill.id
  await s.call(s.A, 'GET', `/superbills/${sbId}`)
  await s.call(s.A, 'POST', `/superbills/${sbId}/printed`)
  await s.call(s.A, 'PUT', `/charges/${id}/payment`, { paidCents: 100, method: 'cash' })
  const actions = (await s.db.query<{ action: string }>("SELECT action FROM audit_log WHERE action ~ '^(charge|superbill|billing)\\.' ORDER BY id")).map((r) => r.action)
  expect(actions).toEqual(['billing.profile_updated', 'charge.created', 'superbill.issued', 'superbill.viewed', 'superbill.printed', 'charge.payment_recorded'])
  const dump = JSON.stringify(await s.db.query('SELECT details, entity_id, actor_label FROM audit_log'))
  expect(dump).not.toMatch(/Maria|Lopez|F41|F32|Calle|Ponce|XYZ123|98-7654321|987654321|1234567893|1990-04-12/)
})

test('the form options list the common CPT codes, modifiers and places of service', async () => {
  const s = await setup()
  const { body } = await s.call(s.A, 'GET', '/meta')
  expect(body.cpt.map((c: any) => c.code)).toEqual(expect.arrayContaining(['90791', '90834', '90837']))
  expect(body.modifiers.map((m: any) => m.code)).toEqual(['95', '93', 'GT'])
  expect(body.placesOfService.map((p: any) => p.code)).toEqual(['11', '10', '02'])
  expect(body.maxDiagnoses).toBe(12)
})

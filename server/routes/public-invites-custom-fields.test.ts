import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { seedPractice } from '../lib/practice-seed'
import type { EmailMessage } from '../lib/sending/provider'
import { CustomFieldsRepo } from '../repos/custom-fields-repo'
import { freshDb } from '../test-utils/pglite'
import { customFieldsRoute } from './custom-fields'
import { invitesRoute } from './invites'
import { publicInvitesRoute } from './public-invites'

async function setup() {
  const { db } = await freshDb()
  const seeded = await seedPractice(db, { practiceName: 'Consultorio Prueba', ownerEmail: 'dra@example.com', ownerName: 'Dra. Prueba', ownerPassword: 'a-long-test-password' })
  const loc = seeded.locationId
  const outbox: EmailMessage[] = []
  const resolveEmail = async () => ({ ok: true, sender: { name: 't', sendEmail: async (m: EmailMessage) => (outbox.push(m), { externalId: 'x', provider: 't' }) } }) as const
  const app = new Hono<AppEnv>()
  app.use('/api/*', async (c, next) => {
    c.set('operatorId', seeded.operatorId)
    c.set('locationId', loc)
    await next()
  })
  app.route('/api/invites', invitesRoute({ db, resolveEmail, publicBaseUrl: 'https://app.test' }))
  app.route('/api/custom-fields', customFieldsRoute({ db }))
  app.route('/i', publicInvitesRoute({ db }))
  const fields = new CustomFieldsRepo(db, loc)
  return { db, loc, app, outbox, fields }
}
type S = Awaited<ReturnType<typeof setup>>

async function invite(s: S, to: string, kind: 'adult' | 'guardian' = 'adult', name = 'Marta Prueba') {
  const res = await s.app.request('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email: to, kind }) })
  expect(res.status).toBe(201)
  return /\/i\/([A-Za-z0-9_-]{43})/.exec([...s.outbox].reverse().find((m) => m.to === to)!.text)![1]!
}
async function visit(s: S, token: string, body?: unknown) {
  const res = await s.app.request(`/i/${token}${body === undefined ? '' : '/submit'}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, json: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null }
}
const ADULT = { firstName: 'Marta', lastName: 'Prueba', phone: '787-555-0142', dateOfBirth: '1988-03-04' }
const MINOR = { firstName: 'Luis', lastName: 'Díaz', dateOfBirth: '2015-06-01', guardianName: 'Rosa Díaz', guardianPhone: '787-555-0100' }
const contactByEmail = async (s: S, email: string) => (await s.db.query<any>('SELECT id, custom_fields FROM contacts WHERE emails @> ARRAY[$1]::text[]', [email]))[0]

test('the form asks the practice\'s custom fields, but not the ones it already asks itself', async () => {
  const s = await setup()
  const page = await visit(s, await invite(s, 'marta@example.com'))
  expect(page.status).toBe(200)
  expect(page.text).toContain('Información adicional')
  for (const label of ['Preferred name', 'Pronouns', 'Emergency contact', 'Emergency contact phone', 'Relationship', 'Referral source', 'Preferred language']) expect(page.text).toContain(label)
  // date of birth and the guardian fields are asked by the form's own questions, never twice
  expect(page.text.match(/data-cf="date_of_birth"/g) ?? []).toHaveLength(0)
  expect(page.text).not.toContain('data-cf="guardian_name"')
  expect(page.text).toContain('name="dateOfBirth"')
})

test('a field added today is on the form of the next invitation, and one removed is gone, even for a link already sent', async () => {
  const s = await setup()
  const early = await invite(s, 'early@example.com') // sent BEFORE the change
  expect((await visit(s, early)).text).not.toContain('Alergias')

  const created = await s.fields.create({ label: 'Alergias', type: 'textarea' })
  const later = await invite(s, 'later@example.com')
  expect((await visit(s, later)).text).toContain('Alergias')
  expect((await visit(s, early)).text).toContain('Alergias') // the link sent earlier shows today's fields too

  await s.fields.update(created.id, { label: 'Alergias o condiciones' })
  expect((await visit(s, later)).text).toContain('Alergias o condiciones')

  await s.fields.remove(created.id)
  const after = (await visit(s, later)).text
  expect(after).not.toContain('Alergias')
  expect(after).toContain('Preferred name') // the rest is untouched
})

test('every field type renders as the right control, in the order the practice arranged them', async () => {
  const s = await setup()
  for (const id of (await s.fields.list()).map((f) => f.id)) await s.fields.remove(id)
  await s.fields.create({ label: 'Notas', type: 'textarea', placeholder: 'Escriba aquí' })
  await s.fields.create({ label: 'Hijos', type: 'number' })
  await s.fields.create({ label: 'Desde', type: 'date' })
  await s.fields.create({ label: 'Turno', type: 'dropdown', options: ['Mañana', 'Tarde'] })
  await s.fields.create({ label: 'Acepta recordatorios', type: 'checkbox' })
  await s.fields.create({ label: 'Apodo', type: 'text' })
  const html = (await visit(s, await invite(s, 'marta@example.com'))).text
  expect(html).toMatch(/<textarea[^>]*data-cf="notas"[^>]*placeholder="Escriba aquí"/)
  expect(html).toMatch(/<input[^>]*data-cf="hijos"[^>]*type="number"/)
  expect(html).toMatch(/<input[^>]*data-cf="desde"[^>]*type="date"/)
  expect(html).toMatch(/<select[^>]*data-cf="turno"><option value="">—<\/option><option value="Mañana">Mañana<\/option><option value="Tarde">Tarde<\/option>/)
  expect(html).toMatch(/<input type="checkbox"[^>]*data-cf="acepta_recordatorios"/)
  expect(html).toMatch(/data-cf="apodo"[^>]*type="text"/)
  const order = ['notas', 'hijos', 'desde', 'turno', 'acepta_recordatorios', 'apodo'].map((k) => html.indexOf(`data-cf="${k}"`))
  expect(order).toEqual([...order].sort((a, b) => a - b))
})

test('labels, options and placeholders are escaped: a field name cannot inject markup into the client\'s page', async () => {
  const s = await setup()
  await s.fields.create({ label: '<img src=x onerror=alert(1)>', type: 'dropdown', options: ['"><script>alert(2)</script>'], placeholder: '" autofocus onfocus="alert(3)' })
  const html = (await visit(s, await invite(s, 'marta@example.com'))).text
  expect(html).not.toContain('<img src=x')
  expect(html).not.toContain('<script>alert(2)')
  expect(html).not.toMatch(/autofocus onfocus="alert\(3\)/)
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
})

test('a new client\'s answers are saved on the contact by key, with the right types', async () => {
  const s = await setup()
  await s.fields.create({ label: 'Hijos', type: 'number' })
  await s.fields.create({ label: 'Desde', type: 'date' })
  await s.fields.create({ label: 'Turno', type: 'dropdown', options: ['Mañana', 'Tarde'] })
  await s.fields.create({ label: 'Acepta recordatorios', type: 'checkbox' })
  await s.fields.create({ label: 'Recibe correo', type: 'checkbox' })
  const token = await invite(s, 'marta@example.com')
  const res = await visit(s, token, {
    ...ADULT,
    custom: { preferred_name: '  Marti ', hijos: '2', desde: '2020-01-31', turno: 'Tarde', acepta_recordatorios: true, recibe_correo: false, pronouns: '' },
  })
  expect(res.status, res.text).toBe(200)
  const c = await contactByEmail(s, 'marta@example.com')
  expect(c.custom_fields).toMatchObject({ date_of_birth: '1988-03-04', preferred_name: 'Marti', hijos: 2, desde: '2020-01-31', turno: 'Tarde', acepta_recordatorios: true })
  expect(c.custom_fields).not.toHaveProperty('recibe_correo') // an unchecked box is no answer
  expect(c.custom_fields).not.toHaveProperty('pronouns') // neither is an empty one
})

test('answers for fields that do not exist, are hidden, or are the system\'s own are ignored', async () => {
  const s = await setup()
  const secret = await s.fields.create({ label: 'Solo para la terapeuta', type: 'text', showOnInvite: false })
  const token = await invite(s, 'marta@example.com')
  const res = await visit(s, token, {
    ...ADULT,
    custom: { fabricado: 'x', [secret.key]: 'el cliente lo escribe', guardian_name: 'Nadie', intake_conflicts: 'x', date_of_birth: '1900-01-01' },
  })
  expect(res.status, res.text).toBe(200)
  const c = await contactByEmail(s, 'marta@example.com')
  expect(c.custom_fields.date_of_birth).toBe('1988-03-04') // the form's own question, not the custom bag
  for (const k of ['fabricado', secret.key, 'guardian_name', 'intake_conflicts']) expect(c.custom_fields).not.toHaveProperty(k)
})

test('nested values cannot be smuggled in: an answer is a string, a number or a yes/no', async () => {
  const s = await setup()
  const token = await invite(s, 'marta@example.com')
  expect((await visit(s, token, { ...ADULT, custom: { preferred_name: { a: 1 } } })).status).toBe(422)
  expect((await visit(s, token, { ...ADULT, custom: { preferred_name: ['x'] } })).status).toBe(422)
  expect(await contactByEmail(s, 'marta@example.com')).toBeUndefined()
})

test('a field the practice hides from the invitation is not asked, and one it shows again is', async () => {
  const s = await setup()
  const f = await s.fields.create({ label: 'Notas internas', type: 'text' })
  const token = await invite(s, 'marta@example.com')
  expect((await visit(s, token)).text).toContain('Notas internas') // visible by default
  await s.fields.update(f.id, { showOnInvite: false })
  expect((await visit(s, token)).text).not.toContain('Notas internas')
  await s.fields.update(f.id, { showOnInvite: true })
  expect((await visit(s, token)).text).toContain('Notas internas')
})

test('an answer that does not fit its field is refused naming the field, and nothing is created', async () => {
  const s = await setup()
  await s.fields.create({ label: 'Hijos', type: 'number' })
  await s.fields.create({ label: 'Desde', type: 'date' })
  await s.fields.create({ label: 'Turno', type: 'dropdown', options: ['Mañana', 'Tarde'] })
  const token = await invite(s, 'marta@example.com')
  const refused = async (custom: Record<string, unknown>) => {
    const r = await visit(s, token, { ...ADULT, custom })
    expect(r.status, r.text).toBe(422)
    return r.json
  }
  expect(await refused({ hijos: 'muchos' })).toEqual({ error: 'invalid_custom_field', field: 'Hijos' })
  expect(await refused({ desde: '31/01/2020' })).toEqual({ error: 'invalid_custom_field', field: 'Desde' })
  expect(await refused({ desde: '2020-02-31' })).toEqual({ error: 'invalid_custom_field', field: 'Desde' })
  expect(await refused({ turno: 'Noche' })).toEqual({ error: 'invalid_custom_field', field: 'Turno' })
  expect(await refused({ preferred_name: 'x'.repeat(501) })).toEqual({ error: 'invalid_custom_field', field: 'Preferred name' })
  expect(await contactByEmail(s, 'marta@example.com')).toBeUndefined()
  expect((await s.db.query<any>('SELECT status FROM client_invites'))[0].status).toBe('sent') // still usable after the correction
  expect((await visit(s, token, { ...ADULT, custom: { hijos: 3 } })).status).toBe(200)
})

test('a field removed between opening the page and sending it is ignored instead of failing the registration', async () => {
  const s = await setup()
  const f = await s.fields.create({ label: 'Hijos', type: 'number' })
  const token = await invite(s, 'marta@example.com')
  expect((await visit(s, token)).text).toContain('Hijos')
  await s.fields.remove(f.id)
  const res = await visit(s, token, { ...ADULT, custom: { hijos: '2' } })
  expect(res.status, res.text).toBe(200)
  expect((await contactByEmail(s, 'marta@example.com')).custom_fields).not.toHaveProperty('hijos')
})

test('an existing client keeps what is recorded: only empty fields are filled, differences are flagged for review', async () => {
  const s = await setup()
  await s.fields.create({ label: 'Hijos', type: 'number' })
  await s.db.query(
    `INSERT INTO contacts (id, location_id, name, emails, custom_fields) VALUES ('c_known', $1, 'Marta Prueba', ARRAY['marta@example.com'], $2::jsonb)`,
    [s.loc, JSON.stringify({ date_of_birth: '1988-03-04', preferred_name: 'Marti' })],
  )
  const token = await invite(s, 'marta@example.com')
  const res = await visit(s, token, { ...ADULT, custom: { preferred_name: 'Martita', hijos: 2, pronouns: 'ella' } })
  expect(res.status, res.text).toBe(200)
  const c = await contactByEmail(s, 'marta@example.com')
  expect(c.custom_fields.preferred_name).toBe('Marti') // recorded value is never replaced
  expect(c.custom_fields).toMatchObject({ hijos: 2, pronouns: 'ella' }) // empty ones are filled
  expect(c.custom_fields.intake_conflicts).toEqual({ preferred_name: { record: 'Marti', answered: 'Martita' } })

  const log = await s.db.query<any>("SELECT action, details FROM audit_log WHERE action IN ('contact.updated_from_intake','contact.created')")
  const upd = log.find((a) => a.action === 'contact.updated_from_intake')!
  expect([...upd.details.fields].sort()).toEqual(['hijos', 'pronouns'])
  expect(JSON.stringify(log)).not.toMatch(/Martita|ella/) // field names only, never answers
})

test('on a guardian invitation the answers belong to the minor\'s record', async () => {
  const s = await setup()
  await s.fields.create({ label: 'Escuela', type: 'text' })
  const token = await invite(s, 'rosa@example.com', 'guardian', 'Rosa Díaz')
  const page = await visit(s, token)
  expect(page.text).toContain('Información adicional del paciente')
  const res = await visit(s, token, { ...MINOR, custom: { escuela: 'Escuela Central' } })
  expect(res.status, res.text).toBe(200)
  const [minor] = await s.db.query<any>("SELECT custom_fields FROM contacts WHERE first_name='Luis'")
  expect(minor.custom_fields).toMatchObject({ escuela: 'Escuela Central', guardian_name: 'Rosa Díaz', date_of_birth: '2015-06-01' })
})

test('the audit log names the fields filled from a new registration, never the answers', async () => {
  const s = await setup()
  await s.fields.create({ label: 'Escuela', type: 'text' })
  await visit(s, await invite(s, 'marta@example.com'), { ...ADULT, custom: { escuela: 'Escuela Central', pronouns: 'ella' } })
  const created = (await s.db.query<any>("SELECT details FROM audit_log WHERE action='contact.created'"))[0]
  expect(created.details.fields).toEqual(expect.arrayContaining(['escuela', 'pronouns']))
  expect(JSON.stringify(await s.db.query('SELECT details FROM audit_log'))).not.toMatch(/Escuela Central|ella/)
})

test('too many answers, or oversized ones, are refused before reaching the database', async () => {
  const s = await setup()
  const token = await invite(s, 'marta@example.com')
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'x']))
  expect((await visit(s, token, { ...ADULT, custom: many })).status).toBe(422)
  expect((await visit(s, token, { ...ADULT, custom: { preferred_name: 'x'.repeat(2001) } })).status).toBe(422)
  expect(await contactByEmail(s, 'marta@example.com')).toBeUndefined()
})

test('the practice settings API accepts and returns showOnInvite (on by default)', async () => {
  const s = await setup()
  const post = async (body: unknown) => (await s.app.request('/api/custom-fields', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>
  expect((await post({ label: 'A' })).field.show_on_invite).toBe(true)
  const hidden = (await post({ label: 'B', showOnInvite: false })).field
  expect(hidden.show_on_invite).toBe(false)
  const patched = await (await s.app.request(`/api/custom-fields/${hidden.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ showOnInvite: true }) })).json() as any
  expect(patched.field.show_on_invite).toBe(true)
})

import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { CRISIS_LINES, EMPTY_PAGE, NO_INSURANCE_ACK, type PageInput, type PublicPageConfig } from '../lib/public-page'
import type { EmailMessage } from '../lib/sending/provider'
import { addLocation, freshDb } from '../test-utils/pglite'
import { inquiriesRoute, publicPageAdminRoute } from './public-page-admin'
import { publicPageRoute } from './public-page'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)])
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`

async function setup(practice: Record<string, unknown> = { name: 'Consultorio Rivera', therapist: 'Dra. Rivera', license: '99', email: 'dra@example.com', fees: { session: '$100', intake: '$150', late_cancel: '$50' }, policy: { cancel_hours: '24' } }) {
  const { db } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  const other = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra','h')")
  await db.query('UPDATE locations SET settings = $2::jsonb, branding = $3::jsonb WHERE id = $1', [loc, JSON.stringify({ practice }), JSON.stringify({ color: '#0e7490' })])
  const outbox: EmailMessage[] = []
  const resolveEmail = async () => ({ ok: true, sender: { name: 't', sendEmail: async (m: EmailMessage) => (outbox.push(m), { externalId: 'x', provider: 't' }) } }) as const
  const mount = (location: string) => {
    const a = new Hono<AppEnv>()
    a.use('/api/*', async (c, next) => {
      c.set('operatorId', 'op1')
      c.set('locationId', location)
      await next()
    })
    a.route('/api/public-page', publicPageAdminRoute({ db, publicBaseUrl: 'https://app.test' }))
    a.route('/api/inquiries', inquiriesRoute({ db }))
    a.route('/p', publicPageRoute({ db, resolveEmail, publicBaseUrl: 'https://app.test' }))
    return a
  }
  const app = mount(loc)
  const call = async (a: Hono<AppEnv>, method: string, path: string, body?: unknown, ip = '198.51.100.20') => {
    const res = await a.request(path, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'user-agent': 'Phone/1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    const ct = res.headers.get('content-type') ?? ''
    return { status: res.status, headers: res.headers, text, json: ct.includes('json') ? JSON.parse(text) : null }
  }
  const op = (method: string, path: string, body?: unknown, a = app) => call(a, method, `/api${path}`, body)
  const page = (over: Partial<PageInput> = {}): PageInput => ({
    enabled: true, slug: 'dra-rivera', headline: 'Terapia en Puerto Rico', subheadline: 'Un espacio seguro', about: 'Atendemos adultos y adolescentes.',
    services: [{ title: 'Terapia individual', text: 'Sesiones de 50 minutos.' }], showFees: true,
    insurance: { accepted: false, plans: [], note: 'Damos recibo para reembolso.' },
    faq: [{ q: '¿Aceptan plan médico?', a: 'No, por ahora no.' }, { q: '¿Cuánto cuesta?', a: 'Vea las tarifas.' }],
    hours: 'Lunes y martes', location: 'San Juan', showTherapist: true, showCrisis: true,
    form: { intro: '', askInsurance: true, acknowledgements: ['Leí las preguntas frecuentes de esta página.', 'Vi las tarifas.'], modes: ['presencial', 'virtual'], days: ['lunes', 'martes'], slots: ['manana', 'tarde'] },
    ...over,
  })
  const publish = async (over: Partial<PageInput> = {}) => {
    const r = await op('PUT', '/public-page', page(over))
    expect(r.status, r.text).toBe(200)
    return r
  }
  const ask = (over: Record<string, unknown> = {}, slug = 'dra-rivera', ip?: string) =>
    call(app, 'POST', `/p/${slug}/inquiry`, {
      name: 'Marta Prueba', email: 'Marta@Example.com', phone: '787-555-0142', who: 'adult', mode: 'presencial', days: ['lunes'], slots: ['tarde'],
      acknowledged: ['Leí las preguntas frecuentes de esta página.', 'Vi las tarifas.', NO_INSURANCE_ACK], message: 'Prefiero que me escriban.', consent: true, ...over,
    }, ip)
  return { db, loc, other, app, mount, op, call, publish, page, ask, outbox }
}
type S = Awaited<ReturnType<typeof setup>>

test('the page does not exist until the practice publishes it, and an unknown address looks the same', async () => {
  const s = await setup()
  expect((await s.call(s.app, 'GET', '/p/dra-rivera')).status).toBe(404)
  await s.op('PUT', '/public-page', s.page({ enabled: false }))
  const draft = await s.call(s.app, 'GET', '/p/dra-rivera')
  expect(draft.status).toBe(404)
  expect(draft.text).toContain('no está disponible')
  expect((await s.call(s.app, 'GET', '/p/nadie-aqui')).text).toBe(draft.text)
  await s.publish()
  expect((await s.call(s.app, 'GET', '/p/dra-rivera')).status).toBe(200)
  expect((await s.ask()).status).toBe(200)
  await s.publish({ enabled: false })
  expect((await s.ask({ email: 'otra@example.com' })).status).toBe(404) // switching it off closes the form too
})

test('a page cannot go live without an address and a headline, addresses are unique and some are reserved', async () => {
  const s = await setup()
  const noHeadline = await s.op('PUT', '/public-page', s.page({ headline: '' }))
  expect(noHeadline.status).toBe(422)
  expect(noHeadline.json).toEqual({ error: 'incomplete', missing: ['headline'] })
  expect((await s.op('PUT', '/public-page', s.page({ slug: null }))).json).toEqual({ error: 'incomplete', missing: ['slug'] })
  expect((await s.op('PUT', '/public-page', s.page({ headline: '', slug: null, enabled: false }))).status).toBe(200) // a draft may be empty
  expect((await s.op('PUT', '/public-page', s.page({ slug: 'admin' }))).json).toEqual({ error: 'slug_reserved' })
  expect((await s.op('PUT', '/public-page', s.page({ slug: 'Mala Dirección!' }))).status).toBe(400)
  expect((await s.op('PUT', '/public-page', s.page({ slug: 'a' }))).status).toBe(400)

  await s.publish()
  const taken = await s.op('PUT', '/public-page', s.page({ slug: 'dra-rivera' }), s.mount('loc_b'))
  expect(taken.status).toBe(409)
  expect(taken.json).toEqual({ error: 'slug_taken' })
  expect((await s.op('GET', '/public-page')).json).toMatchObject({ slug: 'dra-rivera', url: 'https://app.test/p/dra-rivera', suggestedSlug: 'consultorio-rivera' })
})

test('the page shows what was written, the fees from the practice profile, and says plainly that insurance is not accepted', async () => {
  const s = await setup()
  await s.publish()
  const html = (await s.call(s.app, 'GET', '/p/dra-rivera')).text
  for (const t of ['Terapia en Puerto Rico', 'Un espacio seguro', 'Atendemos adultos y adolescentes.', 'Terapia individual', '$150', '$100', '$50', 'Dra. Rivera · Licencia 99', 'Lunes y martes', 'San Juan', 'Damos recibo para reembolso.']) expect(html).toContain(t)
  expect(html).toContain('Por ahora no aceptamos planes médicos.')
  expect(html).toContain('<summary>¿Aceptan plan médico?</summary>')
  expect(html).toContain('con 24 horas de anticipación')
  for (const l of CRISIS_LINES) expect(html).toContain(l.detail)
  expect(html).not.toContain('<meta name="robots"') // a landing page is meant to be found
  expect(html).toContain('<meta name="description" content="Un espacio seguro">')
})

test('the fees block follows the toggle and the practice profile, and insurance lists the plans when they are accepted', async () => {
  const s = await setup()
  await s.publish({ showFees: false, insurance: { accepted: true, plans: ['Triple-S', 'MCS'], note: '' } })
  const html = (await s.call(s.app, 'GET', '/p/dra-rivera')).text
  expect(html).not.toContain('id="tarifas"')
  expect(html).toContain('Estos son los planes que aceptamos:')
  expect(html).toContain('>Triple-S<')
  expect(html).not.toContain('Por ahora no aceptamos planes médicos.')
  const empty = await setup({ name: 'Sin tarifas' })
  await empty.publish()
  expect((await empty.call(empty.app, 'GET', '/p/dra-rivera')).text).not.toContain('id="tarifas"') // no fees written: no empty block
})

test('everything the practice wrote is escaped: a question, a plan or a headline cannot inject markup', async () => {
  const s = await setup()
  const evil = '<img src=x onerror=alert(1)>'
  await s.publish({ headline: evil, subheadline: '"><script>alert(2)</script>', about: evil, services: [{ title: evil, text: evil }], faq: [{ q: evil, a: `${evil}\n\n${evil}` }], hours: evil, location: evil, form: { intro: evil, askInsurance: true, acknowledgements: [evil], modes: ['presencial'], days: ['lunes'], slots: ['tarde'] }, insurance: { accepted: true, plans: [evil], note: evil } })
  const html = (await s.call(s.app, 'GET', '/p/dra-rivera')).text
  expect(html).not.toContain('<img src=x')
  expect(html).not.toContain('<script>alert')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(html.match(/<script nonce=/g)).toHaveLength(1) // only the form's own script
})

test('the answer to the visitor lives outside the form, so hiding the form after sending does not hide the thanks', async () => {
  const s = await setup()
  await s.publish()
  const html = (await s.call(s.app, 'GET', '/p/dra-rivera')).text
  const form = /<form id="req"[\s\S]*?<\/form>/.exec(html)![0]
  expect(form).not.toContain('id="msg"')
  expect(html).toContain('<div id="msg" class="msg" hidden role="status"></div>')
})

test('the page sets its own strict policy with a nonce and is not cached', async () => {
  const s = await setup()
  await s.publish()
  const r = await s.call(s.app, 'GET', '/p/dra-rivera')
  const csp = r.headers.get('content-security-policy')!
  expect(csp).toMatch(/script-src 'nonce-/)
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("form-action 'none'")
  expect(r.headers.get('cache-control')).toBe('no-store')
  const nonce = /nonce-([^']+)'/.exec(csp)![1]!
  expect(r.text).toContain(`<script nonce="${nonce}">`)
})

test('the form offers exactly the modes, days, slots and statements the practice set, with the insurance statement added while no plans are accepted', async () => {
  const s = await setup()
  await s.publish({ form: { intro: 'Cuéntenos cuándo puede venir.', askInsurance: true, acknowledgements: ['Leí las preguntas frecuentes de esta página.', 'Vi las tarifas.'], modes: ['presencial', 'virtual'], days: ['lunes', 'martes'], slots: ['manana', 'tarde'] } })
  const html = (await s.call(s.app, 'GET', '/p/dra-rivera')).text
  expect(html).toContain('Cuéntenos cuándo puede venir.')
  expect(html).toMatch(/name="mode" value="presencial"/)
  expect(html).toMatch(/name="mode" value="virtual"/)
  expect(html).toMatch(/name="days" value="lunes"/)
  expect(html).toMatch(/name="days" value="martes"/)
  expect(html).not.toMatch(/name="days" value="miercoles"/)
  expect(html).toMatch(/name="slots" value="manana"/)
  expect(html).toMatch(/name="slots" value="tarde"/)
  for (const a of ['Leí las preguntas frecuentes de esta página.', 'Vi las tarifas.', NO_INSURANCE_ACK]) expect(html).toContain(`data-ack="${a}"`)
  expect(html).not.toContain('name="insurance"') // no plans accepted: nothing to choose
  expect(html).toContain('No incluya información médica ni de salud')

  await s.publish({ insurance: { accepted: true, plans: ['Triple-S'], note: '' }, form: { intro: '', askInsurance: true, acknowledgements: ['Vi las tarifas.'], modes: ['presencial'], days: ['miercoles'], slots: ['tarde'] } })
  const h2 = (await s.call(s.app, 'GET', '/p/dra-rivera')).text
  expect(h2).not.toContain(NO_INSURANCE_ACK) // the page now accepts plans: no such statement
  expect(h2).toContain('name="insurance"')
  expect(h2).toContain('>Triple-S<')
  expect(h2).not.toMatch(/name="mode" value="virtual"/)
  expect(h2).toMatch(/name="days" value="miercoles"/)
})

test('a request is stored as shown: modality, days, slots and what the person acknowledged, and it is not a client', async () => {
  const s = await setup()
  await s.publish()
  const before = await s.db.query("SELECT 1 FROM contacts WHERE location_id = 'loc_a'")
  const r = await s.ask({ days: ['lunes', 'martes'], slots: ['manana', 'tarde'], mode: 'virtual', who: 'minor' })
  expect(r.status, r.text).toBe(200)
  const list = (await s.op('GET', '/inquiries')).json
  expect(list.newCount).toBe(1)
  expect(list.inquiries[0]).toMatchObject({
    status: 'new', name: 'Marta Prueba', email: 'marta@example.com', phone: '787-555-0142', who: 'minor', mode: 'virtual', days: ['lunes', 'martes'], slots: ['manana', 'tarde'],
    insurance: null, message: 'Prefiero que me escriban.', acknowledged: ['Leí las preguntas frecuentes de esta página.', 'Vi las tarifas.', NO_INSURANCE_ACK],
  })
  expect(await s.db.query("SELECT 1 FROM contacts WHERE location_id = 'loc_a'")).toHaveLength(before.length) // nothing became a client
})

test('a request that skips a statement, an offered option or a required field is refused and stores nothing', async () => {
  const s = await setup()
  await s.publish()
  let n = 0 // a different address each time: the per-address limit counts every attempt, valid or not
  const refused = async (over: Record<string, unknown>, error: string) => {
    const r = await s.ask(over, 'dra-rivera', `203.0.113.${++n}`)
    expect(r.status, JSON.stringify(over)).toBe(422)
    expect(r.json.error).toBe(error)
  }
  await refused({ acknowledged: ['Leí las preguntas frecuentes de esta página.', 'Vi las tarifas.'] }, 'acknowledgement_required') // the automatic insurance statement is missing
  await refused({ acknowledged: [NO_INSURANCE_ACK] }, 'acknowledgement_required')
  await refused({ acknowledged: ['Acepto todo.'] }, 'acknowledgement_required')
  await refused({ days: ['jueves'] }, 'invalid_days') // not offered
  await refused({ days: [] }, 'invalid_days')
  await refused({ slots: [] }, 'invalid_slots')
  await refused({ mode: 'telefono' }, 'invalid')
  await refused({ consent: false }, 'invalid')
  await refused({ email: 'no-es-un-correo' }, 'invalid')
  await refused({ name: 'M' }, 'invalid')
  await refused({ message: 'x'.repeat(601) }, 'invalid')
  expect((await s.op('GET', '/inquiries')).json.inquiries).toHaveLength(0)
})

test('when the practice takes insurance the form must choose one of its options', async () => {
  const s = await setup()
  await s.publish({ insurance: { accepted: true, plans: ['Triple-S', 'MCS'], note: '' }, form: { intro: '', askInsurance: true, acknowledgements: ['Vi las tarifas.'], modes: ['presencial'], days: ['lunes'], slots: ['tarde'] } })
  const ok = { acknowledged: ['Vi las tarifas.'] }
  expect((await s.ask({ ...ok, insurance: 'Aseguradora Inventada' }, 'dra-rivera', '203.0.113.1')).json.error).toBe('invalid_insurance')
  expect((await s.ask({ ...ok }, 'dra-rivera', '203.0.113.2')).json.error).toBe('invalid_insurance')
  expect((await s.ask({ ...ok, insurance: 'MCS' }, 'dra-rivera', '203.0.113.3')).status).toBe(200)
  expect((await s.op('GET', '/inquiries')).json.inquiries[0].insurance).toBe('MCS')
})

test('a bot that fills the hidden field is told "ok" and nothing is stored; the same email twice is one request', async () => {
  const s = await setup()
  await s.publish()
  expect((await s.ask({ website: 'http://spam.example' })).status).toBe(200)
  expect((await s.op('GET', '/inquiries')).json.inquiries).toHaveLength(0)
  await s.ask()
  await s.ask({ email: 'MARTA@example.com', name: 'Otra Vez' }, 'dra-rivera', '203.0.113.7')
  expect((await s.op('GET', '/inquiries')).json.inquiries).toHaveLength(1)
})

test('asking too often from one address is throttled, and a request cannot be oversized', async () => {
  const s = await setup()
  await s.publish()
  for (let i = 0; i < 5; i++) expect((await s.ask({ email: `p${i}@example.com` }, 'dra-rivera', '192.0.2.50')).status).toBe(200)
  expect((await s.ask({ email: 'p9@example.com' }, 'dra-rivera', '192.0.2.50')).status).toBe(429)
  const big = await s.call(s.app, 'POST', '/p/dra-rivera/inquiry', { name: 'x'.repeat(30_000) }, '192.0.2.51')
  expect(big.status).toBe(422) // body parsed but refused by the schema; content-length cap applies to real clients
})

test('the audit log records that a request arrived and what happened to it, never who it was or what they wrote', async () => {
  const s = await setup()
  await s.publish()
  await s.ask({ message: 'MENSAJE-PRIVADO' })
  const id = (await s.op('GET', '/inquiries')).json.inquiries[0].id as string
  await s.op('PATCH', `/inquiries/${id}`, { handled: true })
  expect((await s.op('DELETE', `/inquiries/${id}`)).status).toBe(200)
  const log = await s.db.query<{ action: string; details: unknown }>("SELECT action, details FROM audit_log WHERE action LIKE 'inquiry.%' OR action LIKE 'publicpage.%' ORDER BY id")
  expect(log.map((a) => a.action)).toEqual(['publicpage.updated', 'inquiry.received', 'inquiry.handled', 'inquiry.deleted'])
  expect(log[1]!.details).toEqual({ who: 'adult', mode: 'presencial' })
  const dump = JSON.stringify(await s.db.query('SELECT * FROM audit_log'))
  for (const secret of ['Marta Prueba', 'marta@example.com', '787-555-0142', 'MENSAJE-PRIVADO']) expect(dump).not.toContain(secret)
})

test('the inbox is per practice: another practice cannot read, change or delete a request', async () => {
  const s = await setup()
  await s.publish()
  await s.ask()
  const id = (await s.op('GET', '/inquiries')).json.inquiries[0].id as string
  const other = s.mount('loc_b')
  expect((await s.op('GET', '/inquiries', undefined, other)).json.inquiries).toHaveLength(0)
  expect((await s.op('PATCH', `/inquiries/${id}`, { handled: true }, other)).status).toBe(404)
  expect((await s.op('DELETE', `/inquiries/${id}`, undefined, other)).status).toBe(404)
  expect((await s.op('GET', '/inquiries', undefined, s.app)).json.inquiries).toHaveLength(1)
})

test('a request can be handled, reopened, linked to the invitation sent from it, and filtered by state', async () => {
  const s = await setup()
  await s.publish()
  await s.ask()
  const id = (await s.op('GET', '/inquiries')).json.inquiries[0].id as string
  expect((await s.op('POST', `/inquiries/${id}/invited`, { inviteId: 'nope' })).status).toBe(400)
  await s.db.query("INSERT INTO client_invites (id, location_id, kind, name, email, token_hash, status, sent_by) VALUES ('inv1','loc_a','adult','Marta','marta@example.com','h1','sent','op1')")
  const inv = await s.op('POST', `/inquiries/${id}/invited`, { inviteId: 'inv1' })
  expect(inv.json.inquiry).toMatchObject({ status: 'invited', inviteId: 'inv1' })
  expect((await s.op('GET', '/inquiries?status=new')).json).toMatchObject({ inquiries: [], newCount: 0 })
  expect((await s.op('GET', '/inquiries?status=invited')).json.inquiries).toHaveLength(1)
  await s.op('PATCH', `/inquiries/${id}`, { handled: true })
  expect((await s.op('GET', '/inquiries?status=handled')).json.inquiries).toHaveLength(1)
  await s.op('PATCH', `/inquiries/${id}`, { handled: false })
  expect((await s.op('GET', '/inquiries/count')).json).toEqual({ newCount: 1 })
  expect((await s.op('GET', '/inquiries?status=bogus')).status).toBe(400)
})

test('the practice is told by email that something arrived, once an hour, with nothing about the person', async () => {
  const s = await setup()
  await s.publish()
  await s.ask({ email: 'a@example.com' }, 'dra-rivera', '192.0.2.61')
  await s.ask({ email: 'b@example.com' }, 'dra-rivera', '192.0.2.62')
  await new Promise((r) => setTimeout(r, 50))
  expect(s.outbox).toHaveLength(1)
  expect(s.outbox[0]).toMatchObject({ to: 'dra@example.com', subject: 'Consultorio Rivera: nueva solicitud' })
  expect(s.outbox[0]!.text).toContain('https://app.test/contacts')
  for (const secret of ['Marta', 'a@example.com', 'b@example.com', 'Prefiero']) expect(s.outbox[0]!.text).not.toContain(secret)
})

test('the banner picture is validated by its first bytes, served only while the page is public, and removable', async () => {
  const s = await setup()
  await s.publish()
  expect((await s.op('PUT', '/public-page/banner', { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status).toBe(422)
  expect((await s.op('PUT', '/public-page/banner', { dataUrl: dataUrl(Buffer.from('not an image at all, just text bytes')) })).status).toBe(422)
  expect((await s.op('PUT', '/public-page/banner', { dataUrl: dataUrl(Buffer.concat([PNG, Buffer.alloc(800 * 1024)])) })).status).toBeGreaterThanOrEqual(400)
  const put = await s.op('PUT', '/public-page/banner', { dataUrl: dataUrl(PNG) })
  expect(put.status, put.text).toBe(200)
  const v = put.json.page.bannerVersion as string
  expect(v).toMatch(/^[0-9a-f]{8}$/)
  const html = (await s.call(s.app, 'GET', '/p/dra-rivera')).text
  expect(html).toContain(`src="/p/dra-rivera/banner?v=${v}"`)
  const img = await s.app.request('/p/dra-rivera/banner')
  expect(img.status).toBe(200)
  expect(img.headers.get('content-type')).toBe('image/png')
  expect(img.headers.get('x-content-type-options')).toBe('nosniff')
  expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true)
  await s.op('PUT', '/public-page', s.page()) // saving the text does not lose the picture
  expect((await s.op('GET', '/public-page')).json.page.bannerVersion).toBe(v)
  await s.publish({ enabled: false })
  expect((await s.app.request('/p/dra-rivera/banner')).status).toBe(404)
  await s.publish()
  expect((await s.op('DELETE', '/public-page/banner')).json.page.bannerVersion).toBeNull()
  expect((await s.app.request('/p/dra-rivera/banner')).status).toBe(404)
  expect((await s.call(s.app, 'GET', '/p/dra-rivera')).text).not.toContain('/banner?v=')
})

test('the preview shows an unpublished page to the operator, with the form switched off and no script', async () => {
  const s = await setup()
  await s.op('PUT', '/public-page', s.page({ enabled: false }))
  const r = await s.op('GET', '/public-page/preview')
  expect(r.status).toBe(200)
  expect(r.text).toContain('Vista previa')
  expect(r.text).toContain('Terapia en Puerto Rico')
  expect(r.text).toContain('disabled')
  expect(r.text).not.toContain('<script')
  expect(r.text).toContain('<meta name="robots" content="noindex,nofollow">')
  expect((await s.call(s.app, 'GET', '/p/dra-rivera')).status).toBe(404) // still not public
})

test('changes to the page are audited by field name, not by content', async () => {
  const s = await setup()
  await s.publish()
  await s.publish({ headline: 'Otro titular', hours: 'Martes' })
  const log = await s.db.query<{ details: { fields: string[] } }>("SELECT details FROM audit_log WHERE action = 'publicpage.updated' ORDER BY id")
  expect(log[0]!.details.fields).toEqual(expect.arrayContaining(['enabled', 'headline', 'slug']))
  expect([...log[1]!.details.fields].sort()).toEqual(['headline', 'hours'])
  expect(JSON.stringify(log)).not.toContain('Otro titular')
})

test('the crisis numbers on the page are the same ones the intake documents give', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/document-seed-content.ts', import.meta.url), 'utf8')
  for (const l of CRISIS_LINES) {
    const digits = l.detail.match(/\d[\d-]*/)![0]
    expect(src, l.name).toContain(digits)
  }
})

test('defaults: nothing is published, no insurance is accepted, and the offered schedule is Monday or Tuesday, morning or afternoon', () => {
  const d: PublicPageConfig = EMPTY_PAGE
  expect(d.enabled).toBe(false)
  expect(d.insurance.accepted).toBe(false)
  expect(d.form.days).toEqual(['lunes', 'martes'])
  expect(d.form.slots).toEqual(['manana', 'tarde'])
  expect(d.form.modes).toEqual(['presencial', 'virtual'])
})

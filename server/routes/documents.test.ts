import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { seedDocuments } from '../lib/document-seed'
import { addLocation, freshDb } from '../test-utils/pglite'
import { documentsRoute } from './documents'

async function setup() {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  const other = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera','h')")
  await db.query("UPDATE locations SET settings = $2::jsonb WHERE id=$1", [loc, JSON.stringify({ practice: { name: 'Consultorio Rivera', therapist: 'Dra. Rivera', license: '99', fees: { session: '$100', intake: '$150', late_cancel: '$50' }, policy: { cancel_hours: '24' } } })])
  await db.query("INSERT INTO contacts (id, location_id, name, first_name, last_name, custom_fields) VALUES ('c1',$1,'Luis Mora','Luis','Mora','{\"date_of_birth\":\"1985-02-03\"}'),('cx',$2,'Foreign','F','C','{}')", [loc, other])
  const mount = (location: string) => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('operatorId', 'op1')
      c.set('locationId', location)
      await next()
    })
    app.route('/', documentsRoute({ db, today: () => '2026-11-05' }))
    return app
  }
  const app = mount(loc)
  const call = async (method: string, path: string, body?: unknown, a = app) => {
    const res = await a.request(path, { method, headers: { 'content-type': 'application/json', 'user-agent': 'UA/1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
    return { status: res.status, json }
  }
  const create = async (extra: Record<string, unknown> = {}) => {
    const r = await call('POST', '/templates', { title: 'Consent', kind: 'agreement', bodyMd: 'Hola {{client.first_name}}', ...extra })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    return r.json.template as { id: string; familyId: string; version: number }
  }
  const audits = () => db.query<{ action: string; details: Record<string, unknown> }>('SELECT action, details FROM audit_log WHERE location_id=$1 ORDER BY chain_seq', [loc])
  return { db, pg, loc, other, app, mount, call, create, audits }
}

test('create -> edit -> activate -> edit refused -> new version -> activate retires the old one', async () => {
  const s = await setup()
  const t = await s.create({ fields: [{ key: 'a', type: 'text', label: 'A' }] })
  expect(t.version).toBe(1)

  expect((await s.call('PATCH', `/templates/${t.id}`, { title: 'Consentimiento' })).status).toBe(200)
  const act = await s.call('POST', `/templates/${t.id}/activate`)
  expect(act.status).toBe(200)
  expect(act.json.template.status).toBe('active')
  expect(act.json.retiredVersion).toBeNull()

  const edit = await s.call('PATCH', `/templates/${t.id}`, { bodyMd: 'cambiado' })
  expect(edit).toMatchObject({ status: 409, json: { error: 'template_immutable' } })
  expect((await s.call('GET', `/templates/${t.id}`)).json.template.bodyMd).toBe('Hola {{client.first_name}}')

  const nv = await s.call('POST', `/templates/${t.id}/new-version`)
  expect(nv.status).toBe(201)
  expect(nv.json.template).toMatchObject({ version: 2, status: 'draft', familyId: t.familyId, title: 'Consentimiento' })
  // a second click while a draft exists
  expect((await s.call('POST', `/templates/${t.id}/new-version`)).json).toMatchObject({ error: 'draft_exists', draftId: nv.json.template.id })

  await s.call('PATCH', `/templates/${nv.json.template.id}`, { bodyMd: 'v2' })
  const act2 = await s.call('POST', `/templates/${nv.json.template.id}/activate`)
  expect(act2.json.retiredVersion).toBe(1)
  const hist = await s.call('GET', `/templates/families/${t.familyId}`)
  expect(hist.json.versions.map((v: any) => [v.version, v.status])).toEqual([[2, 'active'], [1, 'retired']])
  expect((await s.call('GET', `/templates/${t.id}`)).json.template.bodyMd).toBe('Hola {{client.first_name}}') // v1 still exactly as signed

  expect((await s.audits()).map((a) => a.action)).toEqual([
    'template.created', 'template.updated', 'template.activated', 'template.version_created', 'template.updated', 'template.retired', 'template.activated',
  ])
})

test('the list shows the newest version of each family with the version in force', async () => {
  const s = await setup()
  const t = await s.create()
  await s.call('POST', `/templates/${t.id}/activate`)
  await s.call('POST', `/templates/${t.id}/new-version`)
  const other = await s.create({ title: 'Otro' })
  const list = (await s.call('GET', '/templates')).json.templates
  expect(list).toHaveLength(2)
  const fam = list.find((x: any) => x.familyId === t.familyId)
  expect(fam).toMatchObject({ version: 2, status: 'draft', activeVersion: 1 })
  expect(list.find((x: any) => x.id === other.id).activeVersion).toBeNull()
  expect(fam.bodyMd).toBeUndefined()
})

test('lifecycle refusals: activate a non-draft, retire a non-active, unknown ids', async () => {
  const s = await setup()
  const t = await s.create()
  expect((await s.call('POST', `/templates/${t.id}/retire`)).json.error).toBe('not_active')
  await s.call('POST', `/templates/${t.id}/activate`)
  expect((await s.call('POST', `/templates/${t.id}/activate`)).json.error).toBe('not_draft')
  expect((await s.call('POST', `/templates/${t.id}/retire`)).status).toBe(200)
  expect((await s.call('PATCH', `/templates/${t.id}`, { title: 'x' })).status).toBe(409)
  for (const [m, p] of [['GET', '/templates/nope'], ['PATCH', '/templates/nope'], ['POST', '/templates/nope/activate'], ['POST', '/templates/nope/new-version'], ['POST', '/templates/nope/preview']] as const) {
    expect((await s.call(m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(404)
  }
})

test('invalid input is a 400: duplicate field keys, select without options, unknown kind', async () => {
  const s = await setup()
  const dup = await s.call('POST', '/templates', { title: 'x', kind: 'agreement', fields: [{ key: 'a', type: 'text', label: 'A' }, { key: 'a', type: 'text', label: 'B' }] })
  expect(dup.status).toBe(400)
  expect((await s.call('POST', '/templates', { title: 'x', kind: 'agreement', fields: [{ key: 'a', type: 'select', label: 'A' }] })).status).toBe(400)
  expect((await s.call('POST', '/templates', { title: 'x', kind: 'nope' })).status).toBe(400)
})

test('preview renders merge fields with the practice and a real client, or a sample one', async () => {
  const s = await setup()
  const t = await s.create({ bodyMd: '{{client.full_name}} nació el {{client.date_of_birth}} · {{practice.name}} · <script>x</script>' })
  const real = await s.call('POST', `/templates/${t.id}/preview`, { contactId: 'c1' })
  expect(real.json.html).toContain('Luis Mora nació el 3 de febrero de 1985 · Consultorio Rivera')
  expect(real.json.html).not.toContain('<script>x')
  const sample = await s.call('POST', `/templates/${t.id}/preview`, {})
  expect(sample.json.html).toContain('Ana Rivera')
  expect((await s.call('POST', `/templates/${t.id}/preview`, { contactId: 'nope' })).status).toBe(400)
  expect((await s.call('POST', `/templates/${t.id}/preview`, { contactId: 'cx' })).status).toBe(400) // another practice's client
})

test('tenancy: another location sees none of it and cannot touch it', async () => {
  const s = await setup()
  const t = await s.create()
  const b = s.mount(s.other)
  expect((await s.call('GET', '/templates', undefined, b)).json.templates).toEqual([])
  expect((await s.call('GET', `/templates/${t.id}`, undefined, b)).status).toBe(404)
  expect((await s.call('PATCH', `/templates/${t.id}`, { title: 'hack' }, b)).status).toBe(404)
  expect((await s.call('POST', `/templates/${t.id}/activate`, {}, b)).status).toBe(404)
  expect((await s.call('POST', '/packets', { name: 'p', familyIds: [t.familyId], audience: 'adult' }, b)).json.error).toBe('unknown_family')
  expect((await s.call('GET', '/templates', undefined, s.app)).json.templates).toHaveLength(1)
})

test('packets: order is kept, unknown families are refused, inactive ones are flagged, preview shows all in sequence', async () => {
  const s = await setup()
  const a = await s.create({ title: 'Alfa', bodyMd: 'AAA' })
  const b = await s.create({ title: 'Beta', bodyMd: 'BBB' })
  await s.call('POST', `/templates/${a.id}/activate`)

  const bad = await s.call('POST', '/packets', { name: 'P', familyIds: [a.familyId, 'ghost'], audience: 'adult' })
  expect(bad).toMatchObject({ status: 400, json: { error: 'unknown_family', familyIds: ['ghost'] } })

  const mk = await s.call('POST', '/packets', { name: 'Adulto', familyIds: [b.familyId, a.familyId], audience: 'adult' })
  expect(mk.status).toBe(201)
  const id = mk.json.packet.id
  const list = (await s.call('GET', '/packets')).json.packets
  expect(list[0]).toMatchObject({ familyIds: [b.familyId, a.familyId], inactiveFamilyIds: [b.familyId] })
  const detail = (await s.call('GET', `/packets/${id}`)).json
  expect(detail.documents.map((d: any) => d.title)).toEqual(['Beta', 'Alfa'])
  const html = (await s.call('POST', `/packets/${id}/preview`, {})).json.html as string
  expect(html.indexOf('BBB')).toBeLessThan(html.indexOf('AAA'))

  const up = await s.call('PATCH', `/packets/${id}`, { familyIds: [a.familyId], audience: 'adolescent' })
  expect(up.json.packet).toMatchObject({ familyIds: [a.familyId], audience: 'adolescent' })
  const arch = await s.call('PATCH', `/packets/${id}`, { archived: true })
  expect(arch.json.packet.archivedAt).not.toBeNull()
  expect((await s.call('GET', '/packets')).json.packets).toHaveLength(0)
  expect((await s.call('GET', '/packets?includeArchived=true')).json.packets).toHaveLength(1)
  expect((await s.call('PATCH', '/packets/nope', { name: 'x' })).status).toBe(404)
  expect((await s.audits()).map((x) => x.action)).toEqual(expect.arrayContaining(['packet.created', 'packet.updated']))
})

test('audit rows name ids and fields, never the document text', async () => {
  const s = await setup()
  const t = await s.create({ bodyMd: 'SECRET-CLAUSE-TEXT' })
  await s.call('PATCH', `/templates/${t.id}`, { bodyMd: 'OTHER-SECRET' })
  const rows = await s.audits()
  expect(JSON.stringify(rows)).not.toContain('SECRET')
  expect(rows[1]!.details).toMatchObject({ changed: ['bodyMd'] })
})

test('the starter set: 9 draft templates and 2 packets, idempotent, and a re-seed keeps the therapist\'s edits', async () => {
  const s = await setup()
  expect(await seedDocuments(s.db, s.loc)).toEqual({ templates: 9, packets: 2 })
  expect(await seedDocuments(s.db, s.loc)).toEqual({ templates: 0, packets: 0 })
  const list = (await s.call('GET', '/templates')).json.templates
  expect(list).toHaveLength(9)
  expect(list.every((t: any) => t.status === 'draft' && t.locale === 'es')).toBe(true)
  const consent = list.find((t: any) => t.familyId === 'seed_informed_consent')
  await s.call('PATCH', `/templates/${consent.id}`, { title: 'Mi consentimiento' })
  await seedDocuments(s.db, s.loc)
  expect((await s.call('GET', `/templates/${consent.id}`)).json.template.title).toBe('Mi consentimiento')
  const packets = (await s.call('GET', '/packets')).json.packets
  expect(packets.map((p: any) => [p.name, p.audience, p.familyIds.length])).toEqual([['Onboarding – Adolescente', 'adolescent', 6], ['Onboarding – Adulto', 'adult', 6]])
  // every seeded template renders for a real client without an unknown merge field
  for (const t of list) {
    const html = (await s.call('POST', `/templates/${t.id}/preview`, { contactId: 'c1' })).json.html as string
    expect(html, t.title).not.toContain('campo desconocido')
  }
  // seeding a second practice does not collide with the first
  await seedDocuments(s.db, s.other)
  expect((await s.call('GET', '/templates', undefined, s.mount(s.other))).json.templates).toHaveLength(9)
})

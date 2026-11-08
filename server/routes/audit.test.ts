import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { audit } from '../lib/audit'
import type { AuditAction } from '../lib/audit-vocab'
import { addLocation, freshDb } from '../test-utils/pglite'
import { auditRoute } from './audit'

async function setup() {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  const other = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera','h')")
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana Rivera'),('c2',$1,'Luis Mora')", [loc])
  const put = (l: string, action: AuditAction, e: Partial<Parameters<typeof audit>[2]> = {}) =>
    audit(db, l, { action, entityType: action.split('.')[0]!, actor: { type: 'operator', id: 'op1' }, ...e })
  await put(loc, 'auth.login')
  await put(loc, 'contact.created', { entityId: 'c1', contactId: 'c1', details: { fields: ['name'] } })
  await put(loc, 'contact.created', { entityId: 'c2', contactId: 'c2' })
  await put(loc, 'note.signed', { entityId: 'n1', contactId: 'c1' })
  await put(loc, 'pipeline.stage_changed', { entityId: 'o1', contactId: 'c1', actor: { type: 'workflow', id: 'wf1', label: 'Workflow: Onboarding' } })
  await put(other, 'contact.created', { entityId: 'zz', contactId: 'zz' }) // a different practice
  const mount = (loc_: string) => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('operatorId', 'op1')
      c.set('locationId', loc_)
      await next()
    })
    app.route('/', auditRoute({ db }))
    return app
  }
  return { db, pg, loc, other, app: mount(loc), otherApp: mount(other) }
}
type Entry = { seq: number; action: string; actorName: string | null; actorType: string; contactId: string | null; contactName: string | null; details: Record<string, unknown> }
const get = async (app: Hono<AppEnv>, qs = '') => {
  const res = await app.request(`/${qs}`)
  return { res, body: (await res.json()) as { entries: Entry[]; nextBefore: number | null } }
}

test('lists the practice\'s history newest first, resolving operator and client names', async () => {
  const { app } = await setup()
  const { body } = await get(app)
  expect(body.entries.map((e) => e.action)).toEqual(['pipeline.stage_changed', 'note.signed', 'contact.created', 'contact.created', 'auth.login'])
  expect(body.entries.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1])
  expect(body.entries[1]).toMatchObject({ actorName: 'Dra. Rivera', contactName: 'Ana Rivera' })
  expect(body.entries[0]).toMatchObject({ actorType: 'workflow', actorName: 'Workflow: Onboarding' }) // label snapshot for non-operators
  expect(body.entries[3]).toMatchObject({ contactId: 'c1', details: { fields: ['name'] } })
  expect(body.nextBefore).toBeNull()
})

test('another practice\'s rows never appear, and each practice has its own chain', async () => {
  const { app, otherApp } = await setup()
  expect((await get(app)).body.entries.some((e) => e.contactId === 'zz')).toBe(false)
  const theirs = (await get(otherApp)).body.entries
  expect(theirs).toHaveLength(1)
  expect(theirs[0]).toMatchObject({ seq: 1, contactId: 'zz' })
  // asking for a foreign client's history through our location returns nothing
  expect((await get(app, '?contactId=zz')).body.entries).toHaveLength(0)
})

test('filters: client, category, exact action, action prefix, actor type, entity, date range', async () => {
  const { app } = await setup()
  const actions = async (qs: string) => (await get(app, qs)).body.entries.map((e) => e.action)
  expect(await actions('?contactId=c1')).toEqual(['pipeline.stage_changed', 'note.signed', 'contact.created'])
  expect(await actions('?category=contacts')).toEqual(['contact.created', 'contact.created'])
  expect(await actions('?category=notes')).toEqual(['note.signed'])
  expect(await actions('?category=bogus')).toEqual([]) // unknown category matches nothing, not everything
  expect(await actions('?action=note.signed')).toEqual(['note.signed'])
  expect(await actions('?action=contact.')).toEqual(['contact.created', 'contact.created'])
  expect(await actions('?actorType=workflow')).toEqual(['pipeline.stage_changed'])
  expect(await actions('?entityType=contact&entityId=c2')).toEqual(['contact.created'])
  expect(await actions('?from=2999-01-01T00:00:00Z')).toEqual([])
  expect((await actions('?from=2000-01-01T00:00:00Z&to=2999-01-01T00:00:00Z')).length).toBe(5)
  expect(await actions('?to=2000-01-01T00:00:00Z')).toEqual([])
})

test('paginates with a cursor and a limit', async () => {
  const { app } = await setup()
  const p1 = (await get(app, '?limit=2')).body
  expect(p1.entries.map((e) => e.seq)).toEqual([5, 4])
  expect(p1.nextBefore).toBe(4)
  const p2 = (await get(app, `?limit=2&before=${p1.nextBefore}`)).body
  expect(p2.entries.map((e) => e.seq)).toEqual([3, 2])
  const p3 = (await get(app, `?limit=2&before=${p2.nextBefore}`)).body
  expect(p3.entries.map((e) => e.seq)).toEqual([1])
  expect(p3.nextBefore).toBeNull()
})

test('rejects malformed filters instead of passing them to SQL', async () => {
  const { app } = await setup()
  for (const qs of ['?from=notadate', "?category=a'b", '?action=%25', '?actorType=hacker', '?limit=9999', '?before=-1', "?entityType=x;DROP"]) {
    expect((await app.request(`/${qs}`)).status, qs).toBe(400)
  }
})

test('verify reports an intact chain, then the first broken row once the table is tampered with', async () => {
  const { app, pg, loc } = await setup()
  const ok = (await (await app.request('/verify')).json()) as { ok: boolean; count: number; brokenAtSeq: number | null }
  expect(ok).toEqual({ ok: true, count: 5, brokenAtSeq: null })

  await pg.exec(`SET session_replication_role = replica; UPDATE audit_log SET details = '{"x":1}' WHERE location_id = '${loc}' AND chain_seq = 3; SET session_replication_role = DEFAULT;`)
  const bad = (await (await app.request('/verify')).json()) as { ok: boolean; brokenAtSeq: number | null }
  expect(bad).toMatchObject({ ok: false, brokenAtSeq: 3 })
})

test('export.csv returns the filtered rows as a spreadsheet-safe file and records the export itself', async () => {
  const { app, db, loc } = await setup()
  const res = await app.request('/export.csv?category=contacts')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/csv')
  expect(res.headers.get('content-disposition')).toContain('audit-log.csv')
  // Response.text() strips a leading BOM, so check the raw bytes: EF BB BF (UTF-8 BOM, for Excel).
  const bytes = new Uint8Array(await res.arrayBuffer())
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
  expect(text.codePointAt(0)).toBe(0xfeff)
  expect(text.slice(1).startsWith('Seq,When,')).toBe(true)
  expect(text.trimEnd().split('\r\n')).toHaveLength(3) // header + 2 contact rows
  expect(text).toContain('Ana Rivera')
  expect(text).not.toContain('Workflow: Onboarding')

  const logged = await db.query<{ action: string; details: Record<string, unknown>; actor_id: string }>("SELECT action, details, actor_id FROM audit_log WHERE location_id=$1 AND action='audit.exported'", [loc])
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatchObject({ actor_id: 'op1', details: { rows: 2, truncated: false, filters: ['category'] } })
})

test('the audit API is read-only: there is no way to write, change or delete a row through it', async () => {
  const { app } = await setup()
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    expect((await app.request('/', { method })).status, method).toBe(404)
  }
})

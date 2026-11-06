import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import type { WorkflowEvent } from '../jobs/workflow-dispatcher'
import { addLocation, closeNoteWindow, freshDb, setNoteWindow } from '../test-utils/pglite'
import { sessionNotesRoute } from './session-notes'

const TODAY = '2026-11-05'
const RISK_OK = { riskSuicidal: 'denied', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'low' }
const PHI = 'Client disclosed childhood trauma and a recent argument with her sister'

async function setup() {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  const other = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera','h'),('op2','asst@x.com','Dr. Mora','h')")
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana Rivera'),('c2',$1,'Luis Mora'),('cx',$2,'Foreign Client')", [loc, other])
  await db.query("INSERT INTO calendars (id, location_id, name) VALUES ('cal1',$1,'Sessions')", [loc])
  await db.query(
    "INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at) VALUES ('ap1',$1,'cal1','c1','t','2026-11-05T14:00:00Z','2026-11-05T14:50:00Z'),('ap2',$1,'cal1','c2','t','2026-11-05T16:00:00Z','2026-11-05T16:50:00Z')",
    [loc],
  )
  const events: WorkflowEvent[] = []
  const mount = (location: string, operator = 'op1') => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('operatorId', operator)
      c.set('locationId', location)
      await next()
    })
    app.route('/', sessionNotesRoute({ db, today: () => TODAY, dispatch: (e) => void events.push(e) }))
    return app
  }
  const app = mount(loc)
  const call = async (method: string, path: string, body?: unknown, a = app) => {
    const res = await a.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'user-agent': 'UA/1', 'x-forwarded-for': '203.0.113.9' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text } // e.g. the plain-text body of an unhandled 500
    }
    return { res, status: res.status, json }
  }
  const create = async (extra: Record<string, unknown> = {}) => {
    const r = await call('POST', '/', { contactId: 'c1', sessionDate: TODAY, ...extra })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    return r.json.note.id as string
  }
  const audits = async () => db.query<{ action: string; entity_id: string; contact_id: string; actor_id: string; details: Record<string, unknown> }>('SELECT action, entity_id, contact_id, actor_id, details FROM audit_log WHERE location_id=$1 ORDER BY chain_seq', [loc])
  return { db, pg, loc, other, app, mount, call, create, audits, events }
}
type S = Awaited<ReturnType<typeof setup>>

// --- create ----------------------------------------------------------------------------

test('creating a note returns a draft with a 72 h window, a "create" revision, and an audit row that names fields but not content', async () => {
  const s = await setup()
  const r = await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, appointmentId: 'ap1', sessionType: 'intake', dataSubjective: PHI, mse: { affect: { values: ['restricted'] } } })
  expect(r.status).toBe(201)
  expect(r.json.note).toMatchObject({ contact_id: 'c1', appointment_id: 'ap1', status: 'draft', session_type: 'intake', created_by: 'op1', data_subjective: PHI })
  expect(r.json.note.lock.locked).toBe(false)
  expect(r.json.note.lock.msRemaining).toBeGreaterThan(71.9 * 3600_000)
  expect(r.json.note.lock.msRemaining).toBeLessThanOrEqual(72 * 3600_000)

  const revs = await s.db.query<{ kind: string; changed_by: string }>('SELECT kind, changed_by FROM session_note_revisions')
  expect(revs).toEqual([{ kind: 'create', changed_by: 'op1' }])
  const a = (await s.audits())[0]!
  expect(a).toMatchObject({ action: 'note.created', entity_id: r.json.note.id, contact_id: 'c1', actor_id: 'op1' })
  expect(a.details).toEqual({ fields: ['sessionDate', 'appointmentId', 'sessionType', 'dataSubjective', 'mse'] })
  expect(JSON.stringify(await s.audits())).not.toContain('trauma')
})

test('create refuses: an unknown or foreign client, a bad appointment, a future date, unknown fields and values outside the vocabulary', async () => {
  const s = await setup()
  const post = (b: Record<string, unknown>) => s.call('POST', '/', b)
  expect((await post({ contactId: 'nobody', sessionDate: TODAY })).status).toBe(400)
  expect((await post({ contactId: 'cx', sessionDate: TODAY })).status).toBe(400) // a client of ANOTHER practice
  expect((await post({ contactId: 'c1', sessionDate: TODAY, appointmentId: 'nope' })).json.error).toBe('unknown appointment')
  expect((await post({ contactId: 'c1', sessionDate: TODAY, appointmentId: 'ap2' })).json.error).toBe('appointment belongs to another client')
  expect((await post({ contactId: 'c1', sessionDate: '2026-11-06' })).json.error).toBe('session_date_in_future')
  expect((await post({ contactId: 'c1', sessionDate: '2026-02-30' })).status).toBe(400)
  expect((await post({ contactId: 'c1', sessionDate: TODAY, modality: 'hologram' })).status).toBe(400)
  expect((await post({ contactId: 'c1', sessionDate: TODAY, riskLevel: 'catastrophic' })).status).toBe(400)
  expect((await post({ contactId: 'c1', sessionDate: TODAY, mse: { affect: { values: ['ecstatic'] } } })).status).toBe(400)
  expect((await post({ contactId: 'c1', sessionDate: TODAY, riskActions: ['none', 'consultation'] })).status).toBe(400)
  expect((await post({ contactId: 'c1', sessionDate: TODAY, status: 'signed' })).status).toBe(400) // cannot create pre-signed
  expect((await post({ contactId: 'c1', sessionDate: TODAY, moodRating: 11 })).status).toBe(400)
  expect(await s.db.query('SELECT 1 FROM session_notes')).toHaveLength(0)
  expect(await s.audits()).toHaveLength(0)
})

// --- read ------------------------------------------------------------------------------

test('the list carries no clinical text; deleted notes appear only when asked, with their reason', async () => {
  const s = await setup()
  const a = await s.create({ dataSubjective: PHI, assessment: 'secret assessment', riskNotes: 'secret rationale' })
  const b = await s.create({ sessionDate: '2026-11-01' })
  await s.call('DELETE', `/${b}`, { reason: 'Wrong client' })
  const list = await s.call('GET', '/?contactId=c1')
  expect(list.json.notes.map((n: any) => n.id)).toEqual([a])
  const text = JSON.stringify(list.json)
  for (const secret of [PHI, 'secret assessment', 'secret rationale', 'data_subjective', 'assessment', 'plan"']) expect(text).not.toContain(secret)
  expect(list.json.notes[0]).toMatchObject({ status: 'draft', contact_name: 'Ana Rivera', lock: { locked: false } })
  const all = await s.call('GET', '/?contactId=c1&includeDeleted=true')
  expect(all.json.notes).toHaveLength(2)
  expect(all.json.notes.find((n: any) => n.id === b)).toMatchObject({ delete_reason: 'Wrong client' })
  expect((await s.call('GET', '/')).status).toBe(400) // contactId is required
})

test('opening a note returns it with its addenda and lock, and is audited; a deleted note answers 410 without its content', async () => {
  const s = await setup()
  const id = await s.create({ dataSubjective: PHI })
  const r = await s.call('GET', `/${id}`)
  expect(r.status).toBe(200)
  expect(r.json.note.data_subjective).toBe(PHI)
  expect(r.json).toMatchObject({ addenda: [], revisionCount: 1, lock: { locked: false } })
  expect((await s.audits()).map((a) => a.action)).toEqual(['note.created', 'note.viewed'])

  await s.call('DELETE', `/${id}`, { reason: 'Duplicate' })
  const gone = await s.call('GET', `/${id}`)
  expect(gone.status).toBe(410)
  expect(JSON.stringify(gone.json)).not.toContain('trauma')
  expect((await s.call('GET', '/nope')).status).toBe(404)
})

test('another practice can neither read nor change nor sign nor delete a note (and its revisions stay private)', async () => {
  const s = await setup()
  const id = await s.create({ dataSubjective: PHI })
  const foreign = s.mount(s.other)
  for (const [method, path, body] of [
    ['GET', `/${id}`], ['PATCH', `/${id}`, { assessment: 'x' }], ['POST', `/${id}/sign`], ['DELETE', `/${id}`, { reason: 'x' }],
    ['POST', `/${id}/addenda`, { body: 'x' }], ['GET', `/${id}/revisions`], ['GET', `/${id}/revisions/1`], ['POST', `/${id}/printed`],
  ] as const) {
    const r = await s.call(method, path, body, foreign)
    expect([404, 200], `${method} ${path}`).toContain(r.status)
    expect(JSON.stringify(r.json ?? {}), `${method} ${path}`).not.toContain('trauma')
  }
  expect((await s.call('GET', `/${id}/revisions`, undefined, foreign)).json.revisions).toEqual([])
  expect((await s.call('GET', '/?contactId=c1', undefined, foreign)).json.notes).toEqual([])
  const row = (await s.db.query<{ data_subjective: string; status: string; deleted_at: unknown }>('SELECT data_subjective, status, deleted_at FROM session_notes WHERE id=$1', [id]))[0]!
  expect(row).toEqual({ data_subjective: PHI, status: 'draft', deleted_at: null })
})

// --- editing a draft -------------------------------------------------------------------

test('editing a draft updates it, audits which FIELDS changed (never the text), and blank text becomes empty', async () => {
  const s = await setup()
  const id = await s.create({ dataSubjective: 'first' })
  const r = await s.call('PATCH', `/${id}`, { dataSubjective: PHI, plan: '   ', moodRating: 4, mse: { mood_reported: 'I feel stuck' } })
  expect(r.status).toBe(200)
  expect(r.json.note).toMatchObject({ data_subjective: PHI, plan: null, mood_rating: 4 })
  expect(r.json.changed.sort()).toEqual(['data_subjective', 'mood_rating', 'mse'])
  const upd = (await s.audits()).find((a) => a.action === 'note.updated')!
  expect(upd.details).toEqual({ fields: expect.arrayContaining(['data_subjective', 'mood_rating', 'mse']) })
  expect(JSON.stringify(await s.audits())).not.toContain('trauma')
  expect(JSON.stringify(await s.audits())).not.toContain('stuck')
  // an empty patch is a no-op: nothing audited, nothing written
  const before = (await s.audits()).length
  expect((await s.call('PATCH', `/${id}`, {})).json.changed).toEqual([])
  expect((await s.audits()).length).toBe(before)
  // unknown / forbidden fields and bad values
  expect((await s.call('PATCH', `/${id}`, { status: 'signed' })).status).toBe(400)
  expect((await s.call('PATCH', `/${id}`, { locksAt: '2999-01-01' })).status).toBe(400)
  expect((await s.call('PATCH', `/${id}`, { contactId: 'c2' })).status).toBe(400)
  expect((await s.call('PATCH', `/${id}`, { mse: { affect: { values: ['nope'] } } })).status).toBe(400)
  expect((await s.call('PATCH', `/${id}`, { sessionDate: '2026-11-06' })).json.error).toBe('session_date_in_future')
  expect((await s.call('PATCH', '/ghost', { plan: 'x' })).status).toBe(404)
})

test('autosave: the database keeps one revision per author per 5 minutes, and the audit log mirrors that', async () => {
  const s = await setup()
  const id = await s.create()
  // same author right after creating: no new revision, so no audit row
  const a1 = await s.call('PATCH', `/${id}`, { dataSubjective: 'typing…', autosave: true })
  expect(a1.status).toBe(200)
  expect((await s.audits()).filter((a) => a.action === 'note.autosaved')).toHaveLength(0)
  expect((await s.call('GET', `/${id}`)).json.note.data_subjective).toBe('typing…') // yet the text IS saved
  // a different author's autosave is a new revision and is logged
  const asOp2 = s.mount(s.loc, 'op2')
  await s.call('PATCH', `/${id}`, { dataSubjective: 'typing… more', autosave: true }, asOp2)
  expect((await s.audits()).filter((a) => a.action === 'note.autosaved')).toHaveLength(1)
  expect((await s.call('GET', `/${id}/revisions`)).json.revisions.map((r: any) => `${r.kind}:${r.changed_by}`)).toEqual(['create:op1', 'autosave:op2'])
})

// --- signing: risk is mandatory ----------------------------------------------------------

test('signing without a complete risk assessment is refused with the exact missing fields', async () => {
  const s = await setup()
  const id = await s.create({ dataSubjective: 'x' })
  const r = await s.call('POST', `/${id}/sign`)
  expect(r.status).toBe(422)
  expect(r.json).toEqual({ error: 'risk_incomplete', missing: ['risk_suicidal', 'risk_self_harm', 'risk_harm_others', 'risk_level'] })
  await s.call('PATCH', `/${id}`, { riskSuicidal: 'passive', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'moderate' })
  expect((await s.call('POST', `/${id}/sign`)).json.missing).toEqual(['risk_notes', 'risk_actions'])
  await s.call('PATCH', `/${id}`, { riskNotes: 'Passive thoughts, no plan; safety plan reviewed', riskActions: ['safety_plan_reviewed'] })
  expect((await s.call('POST', `/${id}/sign`)).status).toBe(200)
  expect((await s.audits()).filter((a) => a.action === 'note.signed')).toHaveLength(1)
})

test('signing records the signature, a timeline fact with no clinical content, the audit, and fires the trigger exactly once', async () => {
  const s = await setup()
  const id = await s.create({ ...RISK_OK, dataSubjective: PHI, sessionType: 'individual' })
  const r = await s.call('POST', `/${id}/sign`)
  expect(r.status).toBe(200)
  expect(r.json.note).toMatchObject({ status: 'signed', signed_by: 'op1', signed_late: false })
  expect(r.json.late).toBe(false)

  const tl = await s.db.query<{ type: string; contact_id: string; payload: Record<string, unknown> }>("SELECT type, contact_id, payload FROM timeline_events WHERE type='session_note_signed'")
  expect(tl).toHaveLength(1)
  expect(tl[0]).toMatchObject({ contact_id: 'c1', payload: { sessionDate: TODAY, sessionType: 'individual', late: false } })
  expect(JSON.stringify(tl)).not.toContain('trauma')
  expect(s.events).toEqual([{ locationId: 'loc_a', triggerType: 'session_note_signed', contactId: 'c1' }])

  // signing again is idempotent: no second audit row, timeline entry or trigger
  const again = await s.call('POST', `/${id}/sign`)
  expect(again.status).toBe(200)
  expect((await s.audits()).filter((a) => a.action === 'note.signed')).toHaveLength(1)
  expect(await s.db.query("SELECT 1 FROM timeline_events WHERE type='session_note_signed'")).toHaveLength(1)
  expect(s.events).toHaveLength(1)
  expect((await s.call('POST', '/ghost/sign')).status).toBe(404)
})

test('a change of risk level between signed notes is audited (from → to); the same level is not', async () => {
  const s = await setup()
  const n1 = await s.create({ sessionDate: '2026-11-01', ...RISK_OK })
  await s.call('POST', `/${n1}/sign`)
  const n2 = await s.create({ sessionDate: '2026-11-03', ...RISK_OK })
  await s.call('POST', `/${n2}/sign`) // low -> low
  expect((await s.audits()).filter((a) => a.action === 'risk.level_changed')).toHaveLength(0)
  const n3 = await s.create({ ...RISK_OK, riskSuicidal: 'passive', riskLevel: 'moderate', riskNotes: 'Passive ideation', riskActions: ['safety_plan_created'] })
  await s.call('POST', `/${n3}/sign`)
  const changed = (await s.audits()).filter((a) => a.action === 'risk.level_changed')
  expect(changed).toHaveLength(1)
  expect(changed[0]).toMatchObject({ entity_id: n3, contact_id: 'c1', details: { from: 'low', to: 'moderate', previousNoteId: n2 } })
})

// --- editing a signed note ------------------------------------------------------------------

test('a signed note can be edited inside the window only with a reason; the signature renews and the reason is kept; risk cannot be blanked', async () => {
  const s = await setup()
  const id = await s.create({ ...RISK_OK })
  await s.call('POST', `/${id}/sign`)
  expect((await s.call('PATCH', `/${id}`, { assessment: 'Improving' })).json.error).toBe('change_reason_required')
  expect((await s.call('PATCH', `/${id}`, { assessment: 'Improving', autosave: true, changeReason: 'x' })).json.error).toBe('autosave_on_signed')
  const asOp2 = s.mount(s.loc, 'op2')
  const ok = await s.call('PATCH', `/${id}`, { assessment: 'Improving', changeReason: 'Added my assessment' }, asOp2)
  expect(ok.status).toBe(200)
  expect(ok.json.note).toMatchObject({ assessment: 'Improving', status: 'signed', signed_by: 'op2' })
  const revs = (await s.call('GET', `/${id}/revisions`)).json.revisions
  expect(revs.at(-1)).toMatchObject({ kind: 'update', changed_by: 'op2', change_reason: 'Added my assessment', changed_by_name: 'Dr. Mora' })

  const blank = await s.call('PATCH', `/${id}`, { riskLevel: null, changeReason: 'oops' })
  expect(blank.status).toBe(422)
  expect(blank.json).toEqual({ error: 'risk_incomplete', missing: ['risk_level'] })
  const elevate = await s.call('PATCH', `/${id}`, { riskLevel: 'high', changeReason: 'Re-assessed' }) // high with no rationale/action
  expect(elevate.json.missing).toEqual(['risk_notes', 'risk_actions'])
  expect((await s.call('GET', `/${id}`)).json.note.risk_level).toBe('low') // unchanged
})

// --- the 72 h lock ---------------------------------------------------------------------------

test('after 72 h: edit and delete answer 409 note_locked, and each attempt is recorded', async () => {
  const s = await setup()
  const id = await s.create({ ...RISK_OK, dataSubjective: 'original' })
  await s.call('POST', `/${id}/sign`)
  await closeNoteWindow(s.pg, id)

  const edit = await s.call('PATCH', `/${id}`, { dataSubjective: 'rewritten history', changeReason: 'x' })
  expect(edit).toMatchObject({ status: 409, json: { error: 'note_locked' } })
  const del = await s.call('DELETE', `/${id}`, { reason: 'make it disappear' })
  expect(del).toMatchObject({ status: 409, json: { error: 'note_locked' } })

  const note = (await s.call('GET', `/${id}`)).json
  expect(note.note.data_subjective).toBe('original')
  expect(note.note.deleted_at).toBeNull()
  expect(note.lock).toMatchObject({ locked: true, msRemaining: 0 })
  expect((await s.audits()).filter((a) => a.action === 'note.edit_rejected_locked')).toHaveLength(2) // the refusals persisted
})

test('a draft nobody signed can still be signed late (flagged, audited as note.signed_late) but only if its risk assessment is complete', async () => {
  const s = await setup()
  const incomplete = await s.create()
  const complete = await s.create({ ...RISK_OK })
  await closeNoteWindow(s.pg, incomplete)
  await closeNoteWindow(s.pg, complete)
  expect((await s.call('POST', `/${incomplete}/sign`)).status).toBe(422)
  expect((await s.call('PATCH', `/${incomplete}`, { riskSuicidal: 'denied' })).status).toBe(409) // cannot complete it now either
  const r = await s.call('POST', `/${complete}/sign`)
  expect(r.status).toBe(200)
  expect(r.json).toMatchObject({ late: true, note: { status: 'signed', signed_late: true } })
  expect((await s.audits()).map((a) => a.action)).toContain('note.signed_late')
  expect((await s.call('PATCH', `/${complete}`, { assessment: 'x', changeReason: 'x' })).status).toBe(409)
})

test('addenda are the way to add to a frozen note: allowed on signed and locked notes, listed with their author, audited without their text', async () => {
  const s = await setup()
  const id = await s.create({ ...RISK_OK })
  await s.call('POST', `/${id}/sign`)
  await closeNoteWindow(s.pg, id)
  const asOp2 = s.mount(s.loc, 'op2')
  const r = await s.call('POST', `/${id}/addenda`, { body: 'Client asked to correct the date of the incident to March.' }, asOp2)
  expect(r.status).toBe(201)
  expect(r.json.addendum).toMatchObject({ note_id: id, author: 'op2' })
  const note = (await s.call('GET', `/${id}`)).json
  expect(note.addenda).toHaveLength(1)
  expect(note.addenda[0]).toMatchObject({ body: 'Client asked to correct the date of the incident to March.', author: 'op2', author_name: 'Dr. Mora' })
  const a = (await s.audits()).find((x) => x.action === 'note.addendum_added')!
  expect(a).toMatchObject({ entity_id: id, contact_id: 'c1', actor_id: 'op2', details: { addendumId: r.json.addendum.id } })
  expect(JSON.stringify(await s.audits())).not.toContain('March')
  expect((await s.call('POST', `/${id}/addenda`, { body: '   ' })).status).toBe(400)
  expect((await s.call('POST', '/ghost/addenda', { body: 'x' })).status).toBe(404)
})

// --- delete ------------------------------------------------------------------------------------

test('a draft or signed note can be soft-deleted inside the window with a reason; it vanishes from the record but nothing is destroyed', async () => {
  const s = await setup()
  const id = await s.create({ ...RISK_OK, dataSubjective: PHI })
  await s.call('POST', `/${id}/sign`)
  expect((await s.call('DELETE', `/${id}`, {})).status).toBe(400) // a reason is mandatory
  expect((await s.call('DELETE', `/${id}`, { reason: '  ' })).status).toBe(400)
  const del = await s.call('DELETE', `/${id}`, { reason: 'Entered on the wrong client' })
  expect(del.status).toBe(204)
  expect((await s.call('GET', '/?contactId=c1')).json.notes).toEqual([])
  expect((await s.call('GET', `/${id}`)).status).toBe(410)
  expect((await s.call('PATCH', `/${id}`, { plan: 'x', changeReason: 'x' })).json.error).toBe('note_deleted')
  expect((await s.call('DELETE', `/${id}`, { reason: 'again' })).json.error).toBe('note_deleted')
  expect((await s.call('POST', `/${id}/addenda`, { body: 'x' })).json.error).toBe('note_deleted')

  const row = (await s.db.query<{ data_subjective: string; deleted_by: string; delete_reason: string }>('SELECT data_subjective, deleted_by, delete_reason FROM session_notes WHERE id=$1', [id]))[0]!
  expect(row).toEqual({ data_subjective: PHI, deleted_by: 'op1', delete_reason: 'Entered on the wrong client' }) // the content is still on record
  const revs = (await s.call('GET', `/${id}/revisions`)).json.revisions
  expect(revs.map((r: any) => r.kind)).toEqual(['create', 'sign', 'delete'])
  const a = (await s.audits()).find((x) => x.action === 'note.deleted')!
  expect(a.details).toEqual({ wasSigned: true })
  expect(JSON.stringify(await s.audits())).not.toContain('wrong client') // the reason is free text: not in the audit
  expect(await s.db.query('SELECT 1 FROM session_notes')).toHaveLength(1)
})

// --- history ------------------------------------------------------------------------------------

test('the revision history lists who changed what and when; opening a revision returns the full snapshot and is audited', async () => {
  const s = await setup()
  const id = await s.create({ dataSubjective: 'v1' })
  await s.call('PATCH', `/${id}`, { dataSubjective: 'v2' })
  await s.call('PATCH', `/${id}`, { ...RISK_OK })
  await s.call('POST', `/${id}/sign`)
  const list = (await s.call('GET', `/${id}/revisions`)).json.revisions
  expect(list.map((r: any) => [r.revision, r.kind, r.changed_by_name])).toEqual([
    [1, 'create', 'Dra. Rivera'], [2, 'update', 'Dra. Rivera'], [3, 'update', 'Dra. Rivera'], [4, 'sign', 'Dra. Rivera'],
  ])
  expect(JSON.stringify(list)).not.toContain('v2') // the list carries no content

  const rev = await s.call('GET', `/${id}/revisions/2`)
  expect(rev.json.revision.snapshot).toMatchObject({ data_subjective: 'v2', status: 'draft' })
  expect((await s.audits()).filter((a) => a.action === 'note.revision_viewed')[0]!.details).toEqual({ revision: 2 })
  for (const bad of ['0', '99', 'abc', '-1']) expect((await s.call('GET', `/${id}/revisions/${bad}`)).status, bad).toBe(404)
})

test('printing is recorded; an unknown note is 404', async () => {
  const s = await setup()
  const id = await s.create()
  expect((await s.call('POST', `/${id}/printed`)).status).toBe(204)
  expect((await s.audits()).map((a) => a.action)).toContain('note.printed')
  expect((await s.call('POST', '/ghost/printed')).status).toBe(404)
})

// --- risk summary / locking soon --------------------------------------------------------------------

test('the elevated-risk list uses each client\'s LATEST signed note, ignores drafts and deleted notes, and puts the worst first', async () => {
  const s = await setup()
  const elevated = { riskSuicidal: 'active_plan', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskNotes: 'Plan reported; safety plan made', riskActions: ['safety_plan_created', 'crisis_line_provided'] }
  // c1: moderate earlier, then low later -> NOT listed
  await s.call('POST', `/${await s.create({ sessionDate: '2026-10-01', ...elevated, riskLevel: 'moderate' })}/sign`)
  await s.call('POST', `/${await s.create({ sessionDate: '2026-11-01', ...RISK_OK })}/sign`)
  // c2: imminent (signed) -> listed first; a later DRAFT does not hide it
  await s.call('POST', '/', { contactId: 'c2', sessionDate: '2026-10-20', ...elevated, riskLevel: 'imminent' }).then((r) => s.call('POST', `/${r.json.note.id}/sign`))
  await s.call('POST', '/', { contactId: 'c2', sessionDate: '2026-11-02', ...RISK_OK })
  const r = (await s.call('GET', '/risk/summary')).json.elevated
  expect(r.map((x: any) => [x.contact_name, x.risk_level])).toEqual([['Luis Mora', 'imminent']])

  // a deleted newer low note does not change the "latest signed" either
  const hidden = await s.call('POST', '/', { contactId: 'c2', sessionDate: '2026-11-04', ...RISK_OK }).then((x) => x.json.note.id)
  await s.call('POST', `/${hidden}/sign`)
  expect((await s.call('GET', '/risk/summary')).json.elevated).toEqual([]) // the newer signed low note takes over
  await s.call('DELETE', `/${hidden}`, { reason: 'Wrong client' })
  expect((await s.call('GET', '/risk/summary')).json.elevated.map((x: any) => x.contact_name)).toEqual(['Luis Mora']) // deleted -> back to imminent
})

test('"locking soon" lists unsigned drafts whose window closes within the hour range, soonest first', async () => {
  const s = await setup()
  const a = await s.create()
  const b = await s.create({ sessionDate: '2026-11-04' })
  const signed = await s.create({ sessionDate: '2026-11-03', ...RISK_OK })
  await s.call('POST', `/${signed}/sign`)
  await setNoteWindow(s.pg, a, 600) // 10 h left
  await setNoteWindow(s.pg, b, 120) // 2 h left
  await setNoteWindow(s.pg, signed, 60) // signed notes never appear
  const r = (await s.call('GET', '/locking-soon')).json.notes
  expect(r.map((n: any) => n.id)).toEqual([b, a])
  expect(r[0]).toMatchObject({ contact_name: 'Ana Rivera', status: 'draft' })
  expect(r[0].lock.msRemaining).toBeGreaterThan(110 * 60_000)
  expect((await s.call('GET', '/locking-soon?hours=5')).json.notes.map((n: any) => n.id)).toEqual([b])
  expect((await s.call('GET', '/locking-soon?hours=999')).status).toBe(400)
})

// --- integrity -----------------------------------------------------------------------------------------

test('if the audit row cannot be written, the note change is rolled back (note, revision and audit are one unit)', async () => {
  const s = await setup()
  const id = await s.create({ dataSubjective: 'original' })
  const revisionsBefore = (await s.db.query('SELECT 1 FROM session_note_revisions')).length
  await s.pg.exec('ALTER TABLE audit_log RENAME TO audit_log_gone')
  const r = await s.call('PATCH', `/${id}`, { dataSubjective: 'changed while audit is down' })
  expect(r.status).toBe(500)
  expect((await s.db.query<{ data_subjective: string }>('SELECT data_subjective FROM session_notes WHERE id=$1', [id]))[0]!.data_subjective).toBe('original')
  expect(await s.db.query('SELECT 1 FROM session_note_revisions')).toHaveLength(revisionsBefore)
})

test('after a full lifecycle the audit chain is intact and no clinical text ever reached it', async () => {
  const s = await setup()
  const id = await s.create({ dataSubjective: PHI, assessment: 'A-secret', plan: 'P-secret', riskNotes: 'R-secret', mse: { mood_reported: 'M-secret' } })
  await s.call('PATCH', `/${id}`, { dataObjective: 'O-secret', ...RISK_OK })
  await s.call('POST', `/${id}/sign`)
  await s.call('GET', `/${id}`)
  await s.call('POST', `/${id}/printed`)
  await s.call('POST', `/${id}/addenda`, { body: 'Addendum-secret' })
  await s.call('PATCH', `/${id}`, { assessment: 'A2-secret', changeReason: 'Reason-secret' })
  await s.call('GET', `/${id}/revisions/1`)
  const logged = JSON.stringify(await s.db.query('SELECT * FROM audit_log'))
  for (const secret of ['trauma', 'A-secret', 'P-secret', 'R-secret', 'M-secret', 'O-secret', 'Addendum-secret', 'A2-secret', 'Reason-secret']) expect(logged).not.toContain(secret)
  expect((await s.db.query<{ v: string | number | null }>('SELECT audit_log_verify($1) AS v', [s.loc]))[0]!.v).toBeNull()
  expect((await s.audits()).map((a) => a.action)).toEqual([
    'note.created', 'note.updated', 'note.signed', 'note.viewed', 'note.printed', 'note.addendum_added', 'note.updated', 'note.revision_viewed',
  ])
})

// --- day 4: appointment closes when its note is signed; backlog; current risk -----------------

const setStatus = (s: S, id: string, status: string) => s.db.query('UPDATE appointments SET status=$2 WHERE id=$1', [id, status])
const apptStatus = async (s: S, id: string) => (await s.db.query<{ status: string }>('SELECT status FROM appointments WHERE id=$1', [id]))[0]!.status

test('signing a note linked to an appointment completes it (and says so in the audit log); cancelled/no-show stay as they are', async () => {
  const s = await setup()
  await setStatus(s, 'ap1', 'checked_in')
  const id = await s.create({ appointmentId: 'ap1', ...RISK_OK })
  expect(await apptStatus(s, 'ap1')).toBe('checked_in') // a draft does not close it
  await s.call('POST', `/${id}/sign`)
  expect(await apptStatus(s, 'ap1')).toBe('completed')
  const a = (await s.audits()).find((x) => x.action === 'appointment.status_changed')!
  expect(a).toMatchObject({ entity_id: 'ap1', contact_id: 'c1', details: { from: 'checked_in', to: 'completed', via: 'note_signed' } })

  for (const [i, status] of (['cancelled', 'no_show'] as const).entries()) {
    await s.db.query(
      "INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at, status) VALUES ($1,$2,'cal1','c1','t',$3::timestamptz,$3::timestamptz + interval '50 minutes',$4)",
      [`ap-${status}`, s.loc, `2026-11-2${i}T14:00:00Z`, status],
    )
    const n = await s.create({ appointmentId: `ap-${status}`, ...RISK_OK })
    await s.call('POST', `/${n}/sign`)
    expect(await apptStatus(s, `ap-${status}`)).toBe(status)
  }
  // a note without an appointment signs fine
  const plain = await s.create({ ...RISK_OK })
  expect((await s.call('POST', `/${plain}/sign`)).status).toBe(200)
})

test('the documentation backlog lists recent sessions that happened but have no live note', async () => {
  const s = await setup()
  const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString()
  const addAppt = (id: string, contact: string, hoursAgo: number, status: string) =>
    s.db.query(
      "INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at, status) VALUES ($1,$2,'cal1',$3,$4,$5::timestamptz,$5::timestamptz + interval '50 minutes',$6)",
      [id, s.loc, contact, `Session ${id}`, iso(hoursAgo), status],
    )
  await s.db.query("DELETE FROM appointments") // start clean (setup adds two future-dated ones)
  await addAppt('done', 'c1', 5, 'completed')
  await addAppt('arrived', 'c2', 30, 'checked_in')
  await addAppt('old', 'c1', 24 * 10, 'completed') // outside the 3-day window
  await addAppt('noshow', 'c1', 6, 'no_show') // never happened
  await addAppt('cancelled', 'c1', 7, 'cancelled')
  await addAppt('future', 'c1', -5, 'checked_in') // starts later
  await addAppt('documented', 'c2', 8, 'completed')
  await addAppt('deleted-note', 'c1', 9, 'completed')

  const doc = await s.call('POST', '/', { contactId: 'c2', sessionDate: TODAY, appointmentId: 'documented' })
  expect(doc.status).toBe(201)
  const del = await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, appointmentId: 'deleted-note' })
  await s.call('DELETE', `/${del.json.note.id}`, { reason: 'Wrong client' })

  const r = (await s.call('GET', '/without-note')).json.sessions
  expect(r.map((x: any) => x.appointment_id)).toEqual(['done', 'deleted-note', 'arrived']) // newest first; a deleted note is not documentation
  expect(r[0]).toMatchObject({ contact_name: 'Ana Rivera', status: 'completed' })
  expect((await s.call('GET', '/without-note?days=14')).json.sessions.map((x: any) => x.appointment_id)).toContain('old')
  expect((await s.call('GET', '/without-note?days=99')).status).toBe(400)
  // another practice sees none of it
  expect((await s.call('GET', '/without-note', undefined, s.mount(s.other))).json.sessions).toEqual([])
})

test('the current risk of a client is the level of their latest signed, live note (null until one exists)', async () => {
  const s = await setup()
  expect((await s.call('GET', '/risk/latest?contactId=c1')).json).toEqual({ risk: null })
  await s.call('POST', `/${await s.create({ sessionDate: '2026-10-01', ...RISK_OK })}/sign`)
  const mod = await s.create({ sessionDate: '2026-11-02', riskSuicidal: 'passive', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'moderate', riskNotes: 'Passive thoughts', riskActions: ['safety_plan_created'] })
  expect((await s.call('GET', '/risk/latest?contactId=c1')).json.risk.risk_level).toBe('low') // a draft does not count
  await s.call('POST', `/${mod}/sign`)
  expect((await s.call('GET', '/risk/latest?contactId=c1')).json.risk).toMatchObject({ risk_level: 'moderate', session_date: '2026-11-02', note_id: mod })
  await s.call('DELETE', `/${mod}`, { reason: 'Wrong client' })
  expect((await s.call('GET', '/risk/latest?contactId=c1')).json.risk.risk_level).toBe('low') // deleted -> back to the previous one
  expect((await s.call('GET', '/risk/latest')).status).toBe(400)
  expect((await s.call('GET', '/risk/latest?contactId=c1', undefined, s.mount(s.other))).json).toEqual({ risk: null })
})

test('the single-note view says WHO signed and created it by name', async () => {
  const s = await setup()
  const id = await s.create({ ...RISK_OK })
  await s.call('POST', `/${id}/sign`, undefined, s.mount(s.loc, 'op2'))
  const note = (await s.call('GET', `/${id}`)).json.note
  expect(note).toMatchObject({ created_by: 'op1', created_by_name: 'Dra. Rivera', signed_by: 'op2', signed_by_name: 'Dr. Mora' })
})

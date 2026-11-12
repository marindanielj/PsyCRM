import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { addLocation, freshDb } from '../test-utils/pglite'
import { sessionNotesRoute } from './session-notes'

const TODAY = '2026-11-05'
const RISK_OK = { riskSuicidal: 'denied', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'low' }
const PHI = 'Discusión con su hermana; duerme 4 horas'

async function setup() {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  const other = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera','h')")
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana Rivera'),('c2',$1,'Luis Mora'),('cx',$2,'Foreign Client')", [loc, other])
  const mount = (location: string) => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('operatorId', 'op1')
      c.set('locationId', location)
      await next()
    })
    app.route('/', sessionNotesRoute({ db, today: () => TODAY }))
    return app
  }
  const app = mount(loc)
  const call = async (method: string, path: string, body?: unknown, a = app) => {
    const res = await a.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  const intake = async (contactId = 'c1', extra: Record<string, unknown> = {}) => {
    const r = await call('POST', '/', { contactId, sessionDate: TODAY, sessionType: 'intake', ...extra })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    return r.json.note
  }
  const audits = () => db.query<{ action: string; details: Record<string, unknown> }>('SELECT action, details FROM audit_log WHERE location_id=$1 ORDER BY chain_seq', [loc])
  return { db, pg, loc, other, app, mount, call, intake, audits }
}

const FORM = {
  texts: { presenting_problem: PHI, problem_history: 'Desde junio' },
  functioning: { sleep: { marked: true, text: 'Duerme 4 horas' }, occupational: { marked: false, text: 'Escuela Central' } },
  mh_history: { medications: { marked: true, text: 'Sertralina 50 mg (2024)' } },
}

test('an intake note gets the form; a client has one live intake, and a deleted one frees the place', async () => {
  const s = await setup()
  const note = await s.intake('c1', { intake: FORM })
  expect(note.intake).toMatchObject({ version: 1, texts: { presenting_problem: PHI } })

  const second = await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, sessionType: 'intake' })
  expect(second.status).toBe(409)
  expect(second.json.error).toBe('intake_exists')
  await s.intake('c2') // another client is fine

  expect((await s.call('DELETE', `/${note.id}`, { reason: 'wrong client' })).status).toBe(204)
  await s.intake('c1')
})

test('the database itself keeps one live intake per client', async () => {
  const s = await setup()
  await s.intake('c1')
  await expect(
    s.pg.exec(`SET psycrm.actor = 'op1'; INSERT INTO session_notes (id, location_id, contact_id, session_date, session_type, intake, created_by) VALUES ('n2','${s.loc}','c1','${TODAY}','intake','{"version":1}','op1')`),
  ).rejects.toThrow(/session_notes_one_intake/)
})

test('the form is only for intake notes, has closed keys, and its version is set by the server', async () => {
  const s = await setup()
  expect((await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, sessionType: 'individual', intake: FORM })).json.error).toBe('not_intake')
  expect((await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, sessionType: 'intake', intake: { version: 7 } })).status).toBe(400)
  expect((await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, sessionType: 'intake', intake: { texts: { diagnosis_secret: 'x' } } })).status).toBe(400)
  expect((await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, sessionType: 'intake', intake: { functioning: { sleep: { marked: true } } } })).status).toBe(400)
  expect((await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, sessionType: 'intake', intake: { texts: { presenting_problem: 'x'.repeat(20_001) } } })).status).toBe(400)
  const note = await s.intake('c1')
  const individual = (await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY })).json.note
  expect((await s.call('PATCH', `/${individual.id}`, { intake: FORM })).json.error).toBe('not_intake')
  // a long history fits: the mental health history is the part she writes the most
  const long = 'Hospitalización 2019. '.repeat(800)
  const r = await s.call('PATCH', `/${note.id}`, { intake: { mh_history: { hospitalizations: { marked: true, text: long } } } })
  expect(r.status).toBe(200)
  expect(r.json.note.intake.mh_history.hospitalizations.text).toBe(long)
  expect(r.json.note.intake.version).toBe(1)
})

test('saving the form replaces it, keeps the version, and the audit names the parts that changed, never the text', async () => {
  const s = await setup()
  const note = await s.intake('c1', { intake: FORM })
  const r = await s.call('PATCH', `/${note.id}`, { intake: { ...FORM, texts: { ...FORM.texts, goals_short: 'Dormir mejor' } }, autosave: false })
  expect(r.status).toBe(200)
  expect(r.json.changed).toEqual(['intake.texts.goals_short'])
  expect(r.json.note.intake.version).toBe(1)
  const log = JSON.stringify(await s.audits())
  expect(log).toContain('intake.texts.presenting_problem') // on create: names
  expect(log).toContain('intake.texts.goals_short')
  for (const text of [PHI, 'Duerme 4 horas', 'Sertralina', 'Dormir mejor', 'Escuela Central']) expect(log).not.toContain(text)
})

test('to sign an intake, the presenting problem and the risk assessment are required; nothing else', async () => {
  const s = await setup()
  const note = await s.intake('c1', { ...RISK_OK })
  const r = await s.call('POST', `/${note.id}/sign`)
  expect(r.status).toBe(422)
  expect(r.json).toEqual({ error: 'intake_incomplete', missing: ['presenting_problem'] })
  await s.call('PATCH', `/${note.id}`, { intake: { texts: { presenting_problem: '   ' } } })
  expect((await s.call('POST', `/${note.id}/sign`)).status).toBe(422)
  await s.call('PATCH', `/${note.id}`, { intake: { texts: { presenting_problem: PHI } } })
  const signed = await s.call('POST', `/${note.id}/sign`)
  expect(signed.status).toBe(200)
  expect(signed.json.note.status).toBe('signed')

  // a signed intake cannot be edited into an incomplete one
  const edit = await s.call('PATCH', `/${note.id}`, { intake: { texts: { presenting_problem: '' } }, changeReason: 'typo' })
  expect(edit.status).toBe(422)
  expect(edit.json.error).toBe('intake_incomplete')
})

test('without the risk assessment an intake does not sign either', async () => {
  const s = await setup()
  const note = await s.intake('c1', { intake: FORM })
  const r = await s.call('POST', `/${note.id}/sign`)
  expect(r.status).toBe(422)
  expect(r.json.error).toBe('risk_incomplete')
})

test('the database refuses to sign an intake without the presenting problem, even with direct SQL', async () => {
  const s = await setup()
  const note = await s.intake('c1', { ...RISK_OK })
  await expect(
    s.pg.exec(`SET psycrm.actor = 'op1'; UPDATE session_notes SET status = 'signed', signed_at = now(), signed_by = 'op1' WHERE id = '${note.id}'`),
  ).rejects.toThrow(/session_notes_intake_required/)
})

test('changing a draft into an intake switches the form on; changing it away sets the form aside', async () => {
  const s = await setup()
  const n = (await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY })).json.note
  const on = await s.call('PATCH', `/${n.id}`, { sessionType: 'intake', intake: FORM })
  expect(on.status).toBe(200)
  expect(on.json.note.intake).toMatchObject({ version: 1, texts: { presenting_problem: PHI } })
  expect((await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, sessionType: 'intake' })).status).toBe(409)

  const off = await s.call('PATCH', `/${n.id}`, { sessionType: 'individual' })
  expect(off.status).toBe(200)
  expect(off.json.note.intake.version).toBeUndefined()
  expect(off.json.note.intake.texts.presenting_problem).toBe(PHI) // kept, not shown
  await s.intake('c1') // the place is free again

  // a second draft cannot become an intake while one is live
  const other = (await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY })).json.note
  expect((await s.call('PATCH', `/${other.id}`, { sessionType: 'intake' })).json.error).toBe('intake_exists')
})

test('an older intake written as DAP keeps working and does not block the new form', async () => {
  const s = await setup()
  await s.pg.exec(`SET psycrm.actor = 'op1'; INSERT INTO session_notes (id, location_id, contact_id, session_date, session_type, data_subjective, risk_suicidal, risk_self_harm, risk_harm_others, risk_level, created_by) VALUES ('old1','${s.loc}','c1','2026-10-01','intake','dap text','denied','denied','denied','low','op1')`)
  expect((await s.call('POST', '/old1/sign')).status).toBe(200)
  expect((await s.call('PATCH', '/old1', { intake: FORM, changeReason: 'x' })).json.error).toBe('not_intake')
  const status = (await s.call('GET', '/intake?contactId=c1')).json.intake
  expect(status).toMatchObject({ status: 'none', noteId: null, otherSignedNotes: 1 })
  await s.intake('c1')
})

test('intake status: none, then draft, then signed; and whether the informed consent is signed', async () => {
  const s = await setup()
  const get = async () => (await s.call('GET', '/intake?contactId=c1')).json
  expect(await get()).toEqual({ intake: { status: 'none', noteId: null, otherSignedNotes: 0, informedConsentSigned: false } })
  const note = await s.intake('c1', { ...RISK_OK, intake: FORM })
  expect((await get()).intake).toMatchObject({ status: 'draft', noteId: note.id })
  await s.call('POST', `/${note.id}/sign`)
  expect((await get()).intake).toMatchObject({ status: 'signed', noteId: note.id, otherSignedNotes: 0 })

  await signedDoc(s, 'seed_informed_consent', 'agreement', {})
  expect((await get()).intake.informedConsentSigned).toBe(true)
  // another practice sees nothing of this client
  expect((await s.call('GET', '/intake?contactId=c1', undefined, s.mount(s.other))).json.intake).toMatchObject({ status: 'none', informedConsentSigned: false })
})

test("the client's questionnaire answers come back mapped, only the known keys, and opening them is logged", async () => {
  const s = await setup()
  expect((await s.call('GET', '/intake?contactId=c1&withAnswers=true')).json.clientAnswers).toBeNull()
  await signedDoc(s, 'seed_intake_form', 'intake_form', {
    reason: 'Ansiedad en el trabajo', meds_list: 'Sertralina', substances: 'ocasional', goals: 'Dormir', first_name: 'Ana', date_of_birth: '1990-01-01', health: '   ',
  })
  const r = (await s.call('GET', '/intake?contactId=c1&withAnswers=true')).json
  expect(r.clientAnswers.answers).toEqual({ reason: 'Ansiedad en el trabajo', meds_list: 'Sertralina', substances: 'Ocasional', goals: 'Dormir' })
  expect(typeof r.clientAnswers.signedAt).toBe('string')
  const log = await s.audits()
  const viewed = log.filter((l) => l.action === 'document.viewed_by_operator')
  expect(viewed).toHaveLength(1)
  expect(JSON.stringify(viewed)).not.toContain('Ansiedad')
  // without asking for the answers, nothing is read or logged
  await s.call('GET', '/intake?contactId=c1')
  expect((await s.audits()).filter((l) => l.action === 'document.viewed_by_operator')).toHaveLength(1)
})

/** A signed document of a template family for c1 (the signing flow is tested elsewhere; foreign keys are skipped here). */
async function signedDoc(s: Awaited<ReturnType<typeof setup>>, family: string, kind: string, values: Record<string, unknown>) {
  const id = `${family}_doc`
  await s.pg.exec(`SET session_replication_role = replica;
    INSERT INTO document_templates (id, location_id, family_id, translation_group_id, kind, title, status) VALUES ('t_${id}','${s.loc}','${family}','tg_${id}','${kind}','T','active');
    INSERT INTO signed_documents (id, location_id, contact_id, request_id, signer_id, signer_role, template_id, template_title, template_version, locale, field_values, rendered_html, content_sha256, signer_name, esign_consent, signer_ip, signer_user_agent, verified_via)
    VALUES ('${id}','${s.loc}','c1','r1','sg1_${id}','client','t_${id}','T',1,'es','${JSON.stringify(values).replace(/'/g, "''")}','<p></p>','x','Ana',true,'1.1.1.1','UA','email_otp');
    SET session_replication_role = DEFAULT;`)
}

test('the schema applies again over a database that already has notes (as in production): data kept, rules in force', async () => {
  const s = await setup()
  await s.pg.exec(`SET psycrm.actor = 'op1'; INSERT INTO session_notes (id, location_id, contact_id, session_date, session_type, data_subjective, risk_suicidal, risk_self_harm, risk_harm_others, risk_level, created_by) VALUES ('old1','${s.loc}','c1','2026-10-01','intake','dap text','denied','denied','denied','low','op1')`)
  await s.call('POST', '/old1/sign')
  const form = await s.intake('c1', { intake: FORM })
  const { readFileSync } = await import('node:fs')
  const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')
  await s.pg.exec(schema)
  await s.pg.exec(schema)
  const rows = await s.db.query<{ id: string; intake: Record<string, unknown> }>('SELECT id, intake FROM session_notes ORDER BY id')
  expect(rows.find((r) => r.id === 'old1')?.intake).toEqual({})
  expect(rows.find((r) => r.id === form.id)?.intake).toMatchObject({ version: 1 })
  expect((await s.call('POST', '/', { contactId: 'c1', sessionDate: TODAY, sessionType: 'intake' })).status).toBe(409)
})

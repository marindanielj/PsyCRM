import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { seedOnboardingWorkflows } from '../lib/onboarding-workflows'
import { seedPractice } from '../lib/practice-seed'
import type { TemplateField } from '../lib/document-vocab'
import type { EmailMessage } from '../lib/sending/provider'
import { contactsRoute } from '../routes/contacts'
import { publicDocumentsRoute } from '../routes/public-documents'
import { freshDb } from '../test-utils/pglite'
import { type WorkflowEvent, dispatchWorkflowEvent } from './workflow-dispatcher'

const PNG = `data:image/png;base64,${'A'.repeat(400)}`

async function setup(opts: { activateDocuments?: boolean; email?: boolean } = {}) {
  const { db, pg } = await freshDb()
  const seeded = await seedPractice(db, { practiceName: 'Consultorio Prueba', ownerEmail: 'dra@example.com', ownerName: 'Dra. Prueba', ownerPassword: 'a-long-test-password' })
  const loc = seeded.locationId
  const stages = seeded.onboarding.stages as Record<string, string>
  if (opts.activateDocuments !== false) {
    await pg.exec("UPDATE document_templates SET status='active' WHERE family_id LIKE 'seed_%'")
    await db.query("UPDATE workflows SET status='live' WHERE location_id=$1", [loc])
  }
  const outbox: EmailMessage[] = []
  const resolveEmail = async () =>
    opts.email === false
      ? ({ ok: false, reason: 'no email provider connected' } as const)
      : ({ ok: true, sender: { name: 't', sendEmail: async (m: EmailMessage) => (outbox.push(m), { externalId: 'x1', provider: 't' }) } } as const)
  const events: WorkflowEvent[] = []
  const deps = { db, resolveEmail, publicBaseUrl: 'https://app.test', dispatch: undefined as any }
  const dispatch = async (e: WorkflowEvent) => {
    events.push(e)
    await dispatchWorkflowEvent(deps, e)
  }
  deps.dispatch = dispatch

  const app = new Hono<AppEnv>()
  app.use('/api/*', async (c, next) => {
    c.set('operatorId', seeded.operatorId)
    c.set('locationId', loc)
    await next()
  })
  app.route('/api/contacts', contactsRoute({ db, requireDateOfBirth: true, dispatch, today: () => '2026-11-05' }))
  app.route('/d', publicDocumentsRoute({ db, sessionSecret: 'test-secret', resolveEmail, dispatch, publicBaseUrl: 'https://app.test' }))

  const addContact = async (body: Record<string, unknown>) => {
    const res = await app.request('/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json()
    expect(res.status, JSON.stringify(json)).toBe(201)
    return json.contact as { id: string }
  }
  const stageOf = async (contactId: string) =>
    (await db.query<{ name: string }>('SELECT s.name FROM opportunities o JOIN pipeline_stages s ON s.id = o.stage_id WHERE o.contact_id=$1 AND o.status=\'open\'', [contactId]))[0]?.name ?? null
  const audits = (action?: string) => db.query<{ action: string; actor_type: string; details: any; contact_id: string | null }>(`SELECT action, actor_type, details, contact_id FROM audit_log WHERE location_id=$1 ${action ? 'AND action=$2' : ''} ORDER BY chain_seq`, action ? [loc, action] : [loc])
  const runs = (contactId: string) => db.query<{ name: string; status: string; steps: { type: string; status: string; detail: string }[] }>('SELECT w.name, r.status, r.steps FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.contact_id=$1 ORDER BY r.started_at', [contactId])
  const tasks = (contactId: string) => db.query<{ title: string; due_at: string | null }>('SELECT title, due_at FROM contact_tasks WHERE contact_id=$1', [contactId])
  const workflowId = async (name: string) => (await db.query<{ id: string }>('SELECT id FROM workflows WHERE location_id=$1 AND name=$2', [loc, name]))[0]!.id
  return { db, pg, loc, stages, deps, dispatch, events, outbox, app, addContact, stageOf, audits, runs, tasks, workflowId, seeded }
}
type S = Awaited<ReturnType<typeof setup>>

/** Plausible, valid answers for every field of a template. */
function answersFor(fields: TemplateField[], dob: string): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const f of fields) {
    switch (f.type) {
      case 'text': v[f.key] = f.key === 'first_name' ? 'Ana' : f.key === 'last_name' ? 'Rivera' : 'x'; break
      case 'textarea': v[f.key] = 'x'; break
      case 'email': v[f.key] = 'ana@example.com'; break
      case 'phone': v[f.key] = '787-555-0101'; break
      case 'date': v[f.key] = dob; break
      case 'number': v[f.key] = '1'; break
      case 'select': case 'radio': v[f.key] = f.options![0]!.value; break
      case 'checkbox': v[f.key] = true; break
      case 'checkbox_group': v[f.key] = [f.options![0]!.value]; break
      case 'yes_no': v[f.key] = 'no'; break
      case 'initials': v[f.key] = 'AR'; break
    }
  }
  return v
}

/** Open the emailed link, verify with the emailed code, sign every document. */
async function completePacket(s: S, email: string, dob: string) {
  const link = [...s.outbox].reverse().find((m) => m.to === email && /\/d\/[A-Za-z0-9_-]{43}/.test(m.text))!
  const token = /\/d\/([A-Za-z0-9_-]{43})/.exec(link.text)![1]!
  let cookie = ''
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await s.app.request(`/d${path}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7', 'user-agent': 'Phone/1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    const text = await res.text()
    return { status: res.status, json: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null }
  }
  expect((await call('POST', `/${token}/otp`)).status).toBe(200)
  const code = /es (\d{6})/.exec([...s.outbox].reverse().find((m) => /código de verificación/.test(m.text))!.text)![1]
  expect((await call('POST', `/${token}/verify`, { code })).status).toBe(200)
  const req = (await s.db.query<{ template_ids: string[] }>('SELECT template_ids FROM document_requests ORDER BY sent_at DESC LIMIT 1'))[0]!
  for (const tid of req.template_ids) {
    const t = (await s.db.query<{ fields: TemplateField[] }>('SELECT fields FROM document_templates WHERE id=$1', [tid]))[0]!
    const r = await call('POST', `/${token}/sign/${tid}`, { values: answersFor(t.fields, dob), signerName: 'Ana Rivera', signaturePng: PNG, agreeTerms: true, esignConsent: true })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
  }
}

test('a new client walks the whole pipeline on their own: packet sent, documents signed, appointment booked, first note signed', async () => {
  const s = await setup()
  const c = await s.addContact({ name: 'Ana Rivera', email: 'ana@example.com', dateOfBirth: '1990-04-12' })

  // 1. created -> New contact -> packet emailed -> Documents sent (three workflow steps, actor "workflow")
  expect(await s.stageOf(c.id)).toBe('Documents sent')
  const first = (await s.runs(c.id))[0]!
  expect(first).toMatchObject({ name: 'Onboarding: new client', status: 'completed' })
  expect(first.steps.map((x) => [x.type, x.status])).toEqual([['move_to_stage', 'done'], ['send_document_packet', 'done'], ['move_to_stage', 'done']])
  const link = s.outbox.find((m) => m.to === 'ana@example.com' && m.subject.includes('documentos pendientes'))!
  expect(link.text).toMatch(/https:\/\/app\.test\/d\/[A-Za-z0-9_-]{43}/)
  const wfAudit = (await s.audits('workflow.step_executed')).filter((a) => a.contact_id === c.id)
  expect(wfAudit).toHaveLength(3)
  expect(wfAudit.every((a) => a.actor_type === 'workflow')).toBe(true)
  const moves = (await s.audits('pipeline.stage_changed')).filter((a) => a.contact_id === c.id)
  expect(moves.map((m) => m.details.toStage)).toEqual(['Documents sent'])
  expect(moves[0]!.actor_type).toBe('workflow')
  expect((await s.audits('packet.sent'))[0]!.actor_type).toBe('workflow')
  expect((await s.db.query<{ sent_by: string }>('SELECT sent_by FROM document_requests'))[0]!.sent_by).toMatch(/^workflow:/)

  // 2. documents signed on the public page -> Documents signed + "Schedule first appointment" task
  await completePacket(s, 'ana@example.com', '1990-04-12')
  expect(await s.stageOf(c.id)).toBe('Documents signed')
  expect(await s.tasks(c.id)).toEqual([{ title: 'Schedule first appointment with Ana', due_at: expect.anything() }])

  // 3. an appointment is booked -> First appointment booked
  await s.dispatch({ locationId: s.loc, triggerType: 'appointment_booked', contactId: c.id, payload: { appointmentId: 'ap1', calendarId: 'cal1' }, depth: 0 })
  expect(await s.stageOf(c.id)).toBe('First appointment booked')

  // 4. the first signed note -> Active client; the second does nothing at all
  await s.dispatch({ locationId: s.loc, triggerType: 'session_note_signed', contactId: c.id, payload: { noteId: 'n1', sessionType: 'individual', isFirst: true }, depth: 0 })
  expect(await s.stageOf(c.id)).toBe('Active client')
  const before = (await s.runs(c.id)).length
  await s.dispatch({ locationId: s.loc, triggerType: 'session_note_signed', contactId: c.id, payload: { noteId: 'n2', sessionType: 'individual', isFirst: false }, depth: 0 })
  expect((await s.runs(c.id)).length).toBe(before) // firstOnly: no run was even started

  // one card, moved forward the whole way
  expect(await s.db.query('SELECT 1 FROM opportunities WHERE contact_id=$1', [c.id])).toHaveLength(1)
  expect((await s.audits('pipeline.stage_changed')).filter((a) => a.contact_id === c.id).map((m) => m.details.toStage)).toEqual(['Documents sent', 'Documents signed', 'First appointment booked', 'Active client'])
})

test('a card the therapist moved further along is never dragged back by an automation', async () => {
  const s = await setup()
  const c = await s.addContact({ name: 'Luis Mora', email: 'luis@example.com', dateOfBirth: '1980-01-01' })
  const opp = (await s.db.query<{ id: string }>('SELECT id FROM opportunities WHERE contact_id=$1', [c.id]))[0]!
  await s.db.query('UPDATE opportunities SET stage_id=$2 WHERE id=$1', [opp.id, s.stages.active])
  await s.dispatch({ locationId: s.loc, triggerType: 'appointment_booked', contactId: c.id, payload: { appointmentId: 'ap1', calendarId: 'c' }, depth: 0 })
  expect(await s.stageOf(c.id)).toBe('Active client')
  const step = (await s.runs(c.id)).find((r) => r.name === 'Onboarding: first appointment')!.steps[0]!
  expect(step).toMatchObject({ status: 'skipped' })
  expect(step.detail).toContain('Already further along')
})

test('a client under 18, or with no date of birth, never receives the adult packet and a task asks for the right next step', async () => {
  const s = await setup()
  const teen = await s.addContact({ name: 'Sofía Díaz', email: 'rosa@example.com', dateOfBirth: '2010-06-01' })
  expect(await s.stageOf(teen.id)).toBe('New contact') // not "Documents sent"
  const run = (await s.runs(teen.id))[0]!
  expect(run.steps.map((x) => x.status)).toEqual(['done', 'skipped', 'skipped'])
  expect(run.steps[1]!.detail).toContain('under 18')
  expect((await s.tasks(teen.id)).map((t) => t.title)).toEqual(['Send adolescent onboarding packet (guardian required)'])
  expect(s.outbox).toHaveLength(0)

  // no date of birth (created some other way): the packet is never defaulted to adult
  const [nodob] = await s.db.query<{ id: string }>("INSERT INTO contacts (id, location_id, name, emails) VALUES ('c_nodob',$1,'Sin Fecha','{x@example.com}') RETURNING id", [s.loc])
  await s.dispatch({ locationId: s.loc, triggerType: 'contact_created', contactId: nodob!.id, payload: { source: 'manual' }, depth: 0 })
  expect((await s.tasks(nodob!.id)).map((t) => t.title)).toEqual(['Add date of birth to send the onboarding packet'])
  expect(await s.stageOf(nodob!.id)).toBe('New contact')
  expect(s.outbox).toHaveLength(0)
})

test('"Send onboarding packet now" unticked starts no automation', async () => {
  const s = await setup()
  const c = await s.addContact({ name: 'Pedro Vega', email: 'pedro@example.com', dateOfBirth: '1975-05-05', skipOnboarding: true })
  expect(await s.runs(c.id)).toEqual([])
  expect(await s.stageOf(c.id)).toBeNull()
  expect(s.outbox).toHaveLength(0)
})

test('with no email provider the packet step FAILS (the run stops and the card does not claim "Documents sent")', async () => {
  const s = await setup({ email: false })
  const c = await s.addContact({ name: 'Ana Rivera', email: 'ana@example.com', dateOfBirth: '1990-04-12' })
  const run = (await s.runs(c.id))[0]!
  expect(run.status).toBe('failed')
  expect(run.steps.map((x) => x.status)).toEqual(['done', 'failed'])
  expect(run.steps[1]!.detail).toContain('email was not sent')
  expect(await s.stageOf(c.id)).toBe('New contact')
  // the request exists, so it can be re-sent by hand; the automation will not send a second one
  expect(await s.db.query('SELECT 1 FROM document_requests')).toHaveLength(1)
  await s.dispatch({ locationId: s.loc, triggerType: 'contact_created', contactId: c.id, payload: { source: 'manual' }, depth: 0 })
  expect((await s.runs(c.id)).at(-1)!.steps[1]).toMatchObject({ status: 'skipped', detail: 'This packet was already sent' })
  expect(await s.db.query('SELECT 1 FROM document_requests')).toHaveLength(1)
})

test('a retried queue job resumes its run: no second packet, no second task, no second run', async () => {
  const s = await setup()
  const c = await s.addContact({ name: 'Ana Rivera', email: 'ana@example.com', dateOfBirth: '1990-04-12' })
  await completePacket(s, 'ana@example.com', '1990-04-12')
  const e: WorkflowEvent = { locationId: s.loc, triggerType: 'documents_completed', contactId: c.id, payload: { requestId: 'r', packetId: 'p' }, depth: 0, eventId: 'evt_1' }
  const tasksBefore = (await s.tasks(c.id)).length
  const runs1 = await dispatchWorkflowEvent(s.deps, e)
  const runs2 = await dispatchWorkflowEvent(s.deps, e) // the queue delivers the same job again
  expect(runs2[0]!.id).toBe(runs1[0]!.id)
  expect(await s.db.query("SELECT 1 FROM workflow_runs WHERE id LIKE 'run_evt_1_%'")).toHaveLength(1)
  expect((await s.tasks(c.id)).length).toBe(tasksBefore) // the task the real completion made already exists
  expect(runs2[0]!.steps).toHaveLength(runs1[0]!.steps.length) // nothing repeated

  // an interrupted run (first step recorded, then the process died) continues from the second step
  const wf = await s.workflowId('Onboarding: documents signed')
  await s.db.query("INSERT INTO workflow_runs (id, location_id, workflow_id, contact_id, trigger_type, status, steps) VALUES ('run_evt_2_'||$1,$2,$1,$3,'documents_completed','running',$4::jsonb)", [wf, s.loc, c.id, JSON.stringify([{ position: 0, type: 'move_to_stage', status: 'done', detail: 'Moved' }])])
  const resumed = await dispatchWorkflowEvent(s.deps, { ...e, eventId: 'evt_2' })
  expect(resumed[0]!.status).toBe('completed')
  expect(resumed[0]!.steps.map((x) => x.position)).toEqual([0, 1])
})

test('a trigger filter picks the packet, the stage or the calendar the workflow is about', async () => {
  const s = await setup()
  const c = await s.addContact({ name: 'Ana Rivera', email: 'ana@example.com', dateOfBirth: '1990-04-12' })
  const wf = await s.db.query<{ id: string }>("INSERT INTO workflows (id, location_id, name, trigger_type, trigger_config, status) VALUES ('wf_cal',$1,'Only calendar A','appointment_booked','{\"calendarId\":\"calA\"}','live') RETURNING id", [s.loc])
  await s.db.query("INSERT INTO workflow_actions (id, location_id, workflow_id, position, type, config) VALUES ('wa1',$1,$2,0,'add_tag','{\"tag\":\"cal-a\"}')", [s.loc, wf[0]!.id])
  await s.dispatch({ locationId: s.loc, triggerType: 'appointment_booked', contactId: c.id, payload: { appointmentId: 'a', calendarId: 'calB' }, depth: 0 })
  expect((await s.db.query<{ tags: string[] }>('SELECT tags FROM contacts WHERE id=$1', [c.id]))[0]!.tags).not.toContain('cal-a')
  await s.dispatch({ locationId: s.loc, triggerType: 'appointment_booked', contactId: c.id, payload: { appointmentId: 'a', calendarId: 'calA' }, depth: 0 })
  expect((await s.db.query<{ tags: string[] }>('SELECT tags FROM contacts WHERE id=$1', [c.id]))[0]!.tags).toContain('cal-a')
})

test('automations that trigger each other stop at depth 3 with a "loop prevented" audit entry', async () => {
  const s = await setup()
  const c = await s.addContact({ name: 'Ana Rivera', email: 'ana@example.com', dateOfBirth: '1990-04-12', skipOnboarding: true })
  const pipelineId = s.seeded.onboarding.pipelineId
  // two workflows that answer each other: a move to "booked" makes a move back to "signed", and so on
  const mk = async (id: string, toStageId: string, thenStageId: string) => {
    await s.db.query("INSERT INTO workflows (id, location_id, name, trigger_type, trigger_config, status) VALUES ($1,$2,$1,'pipeline_stage_changed',$3::jsonb,'live')", [id, s.loc, JSON.stringify({ toStageId })])
    await s.db.query("INSERT INTO workflow_actions (id, location_id, workflow_id, position, type, config) VALUES ($1,$2,$3,0,'move_to_stage',$4::jsonb)", [`${id}_a`, s.loc, id, JSON.stringify({ pipelineId, stageId: thenStageId, onlyForward: false, createIfMissing: false })])
  }
  await mk('ping', s.stages.signed!, s.stages.booked!)
  await mk('pong', s.stages.booked!, s.stages.signed!)
  const opp = (await s.db.query<{ id: string }>("INSERT INTO opportunities (id, location_id, pipeline_id, stage_id, contact_id, name) VALUES ('o_loop',$1,$2,$3,$4,'Ana') RETURNING id", [s.loc, pipelineId, s.stages.new, c.id]))[0]!
  // a person drags the card to "signed": that starts the chain
  const { moveOpportunityToStage } = await import('../lib/pipeline-moves')
  await moveOpportunityToStage(s.db as Database, s.loc, { opportunityId: opp.id, stageId: s.stages.signed!, origin: 'operator', audit: { actor: { type: 'operator', id: 'op' } }, dispatch: s.dispatch })

  const prevented = await s.audits('workflow.loop_prevented')
  expect(prevented).toHaveLength(1)
  expect(prevented[0]!.details).toMatchObject({ trigger: 'pipeline_stage_changed', depth: 4 })
  expect((await s.audits('pipeline.stage_changed')).filter((a) => a.contact_id === c.id)).toHaveLength(5) // the drag, plus one automatic move for each event of depth 0..3; the depth-4 event is the one that is dropped
  expect(s.events.filter((e) => e.triggerType === 'pipeline_stage_changed').map((e) => e.depth)).toEqual([0, 1, 2, 3, 4])
})

test('the starter workflows are drafts until the documents are in force, then live; seeding again never touches an edited one', async () => {
  const s = await setup({ activateDocuments: false })
  const state = () => s.db.query<{ name: string; status: string }>('SELECT name, status FROM workflows WHERE location_id=$1 ORDER BY name', [s.loc])
  expect((await state()).map((w) => [w.name, w.status])).toEqual([
    ['Onboarding: active client', 'draft'], ['Onboarding: documents signed', 'draft'], ['Onboarding: first appointment', 'draft'], ['Onboarding: new client', 'draft'],
  ])
  // a draft does nothing
  const c = await s.addContact({ name: 'Ana Rivera', email: 'ana@example.com', dateOfBirth: '1990-04-12' })
  expect(await s.runs(c.id)).toEqual([])

  expect(await seedOnboardingWorkflows(s.db, s.loc, s.seeded.onboarding)).toEqual({ created: 0, live: false })
  await s.db.query("DELETE FROM workflows WHERE location_id=$1", [s.loc])
  await s.pg.exec("UPDATE document_templates SET status='active' WHERE family_id LIKE 'seed_%'")
  expect(await seedOnboardingWorkflows(s.db, s.loc, s.seeded.onboarding)).toEqual({ created: 4, live: true })
  expect((await state()).every((w) => w.status === 'live')).toBe(true)

  await s.db.query("UPDATE workflows SET name='Mi flujo', status='draft' WHERE name='Onboarding: new client'")
  await seedOnboardingWorkflows(s.db, s.loc, s.seeded.onboarding)
  expect((await state()).find((w) => w.name === 'Mi flujo')!.status).toBe('draft') // her edit survives
})

test('the seeded workflows only reference stages and the packet of their own practice', async () => {
  const s = await setup()
  const acts = await s.db.query<{ type: string; config: any }>('SELECT a.type, a.config FROM workflow_actions a JOIN workflows w ON w.id=a.workflow_id WHERE w.location_id=$1', [s.loc])
  const stageIds = new Set(Object.values(s.stages))
  for (const a of acts.filter((x) => x.type === 'move_to_stage')) {
    expect(stageIds.has(a.config.stageId), a.config.stageId).toBe(true)
    expect(a.config.pipelineId).toBe(s.seeded.onboarding.pipelineId)
  }
  const packet = acts.find((x) => x.type === 'send_document_packet')!
  expect((await s.db.query('SELECT 1 FROM document_packets WHERE id=$1 AND location_id=$2', [packet.config.packetId, s.loc])).length).toBe(1)
})

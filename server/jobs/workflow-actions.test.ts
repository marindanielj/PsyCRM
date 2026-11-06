import { addLocation, freshDb } from '../test-utils/pglite'
import { WorkflowActionsRepo } from '../repos/workflow-actions-repo'
import type { EmailMessage } from '../lib/sending/provider'
import { type WorkflowActionInput, WorkflowsRepo } from '../repos/workflows-repo'
import { runWorkflow } from './workflow-runner'

async function harness(steps: WorkflowActionInput[], contact: { emails?: string[]; first?: string } = { emails: ['ana@example.com'], first: 'Ana' }) {
  const { db } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  await db.query("INSERT INTO contacts (id, location_id, name, first_name, emails) VALUES ('c1',$1,$2,$3,$4)", [loc, `${contact.first ?? ''} Rivera`, contact.first ?? null, contact.emails ?? []])
  await db.query("INSERT INTO pipelines (id, location_id, name) VALUES ('p1',$1,'Onboarding')", [loc])
  for (const [i, n] of ['New', 'Sent', 'Signed'].entries()) await db.query('INSERT INTO pipeline_stages (id, location_id, pipeline_id, name, position) VALUES ($1,$2,\'p1\',$3,$4)', [`s${i}`, loc, n, i])
  const wf = await new WorkflowsRepo(db, loc).create({ name: 'Test', triggerType: 'contact_created' })
  await new WorkflowActionsRepo(db, loc).replaceAll(wf.id, steps)
  const sent: EmailMessage[] = []
  const ok = async () => ({ ok: true, sender: { name: 't', sendEmail: async (m: EmailMessage) => (sent.push(m), { externalId: 'ext-1', provider: 't' }) } }) as const
  const run = (deps: Record<string, unknown> = {}, event?: { payload: Record<string, unknown>; depth: number }) =>
    runWorkflow({ db, resolveEmail: ok, ...deps }, { locationId: loc, workflowId: wf.id, contactId: 'c1', triggerType: 'contact_created', event })
  return { db, loc, sent, run }
}

test('send_email really sends through the practice\'s provider and records the message id, not the address', async () => {
  const h = await harness([{ type: 'send_email', config: { subject: 'Hola {{contact.first_name}}', body: 'Cita el {{event.day}}' } }])
  const r = await h.run({}, { payload: { day: 'lunes' }, depth: 0 })
  expect(r.steps[0]).toMatchObject({ status: 'done' })
  expect(r.steps[0]!.detail).toBe('Email sent to a***@example.com')
  expect(h.sent).toEqual([{ to: 'ana@example.com', toName: 'Ana Rivera', subject: 'Hola Ana', text: 'Cita el lunes' }])
  const t = (await h.db.query<{ payload: any }>("SELECT payload FROM timeline_events WHERE type='automation_action'"))[0]!.payload
  expect(t).toMatchObject({ channel: 'email', status: 'sent', externalId: 'ext-1' })
})

test('send_email with no provider FAILS instead of pretending, and the run stops there', async () => {
  const h = await harness([{ type: 'send_email', config: { subject: 's', body: 'b' } }, { type: 'add_tag', config: { tag: 'after' } }])
  const r = await h.run({ resolveEmail: async () => ({ ok: false, reason: 'no email provider connected' }) })
  expect(r.status).toBe('failed')
  expect(r.steps).toEqual([{ position: 0, type: 'send_email', status: 'failed', detail: 'Email provider not configured' }]) // the tag step never ran
  expect((await h.db.query<{ tags: string[] }>("SELECT tags FROM contacts WHERE id='c1'"))[0]!.tags ?? []).not.toContain('after')
  expect((await h.db.query<{ payload: any }>("SELECT payload FROM timeline_events WHERE type='automation_action'"))[0]!.payload.status).toBe('failed')
})

test('send_email: a contact with no email is skipped; a provider error is a failure that does not leak the error text', async () => {
  const none = await harness([{ type: 'send_email', config: { subject: 's', body: 'b' } }], { emails: [], first: 'Ana' })
  expect((await none.run()).steps[0]).toMatchObject({ status: 'skipped', detail: 'The contact has no email' })
  const boom = await harness([{ type: 'send_email', config: { subject: 's', body: 'b' } }])
  const r = await boom.run({ resolveEmail: async () => ({ ok: true, sender: { name: 't', sendEmail: async () => { throw new Error('550 ana@example.com rejected') } } }) })
  expect(r.steps[0]).toMatchObject({ status: 'failed', detail: 'The email provider rejected the message' })
  expect(JSON.stringify(r)).not.toContain('550')
})

test('create_task fills in the name, sets a due date, and does not repeat an open task', async () => {
  const h = await harness([{ type: 'create_task', config: { title: 'Call {{contact.first_name}}', dueInDays: 2 } }])
  const now = new Date('2026-11-05T15:00:00Z')
  expect((await h.run({ now: () => now })).steps[0]).toMatchObject({ status: 'done', detail: 'Created task "Call Ana"' })
  const [t] = await h.db.query<{ title: string; due_at: Date }>('SELECT title, due_at FROM contact_tasks')
  expect(t!.title).toBe('Call Ana')
  expect(new Date(t!.due_at).toISOString()).toBe('2026-11-07T15:00:00.000Z')
  expect((await h.run({ now: () => now })).steps[0]).toMatchObject({ status: 'skipped', detail: 'That task is already open' })
  expect(await h.db.query('SELECT 1 FROM contact_tasks')).toHaveLength(1)
  await h.db.query('UPDATE contact_tasks SET completed_at = now()')
  expect((await h.run({ now: () => now })).steps[0]!.status).toBe('done') // done tasks do not block a new one
})

test('move_to_stage creates the card at the first stage when asked, moves it forward, and says why it did nothing', async () => {
  const h = await harness([{ type: 'move_to_stage', config: { pipelineId: 'p1', stageId: 's1' } }])
  const first = await h.run()
  expect(first.steps[0]).toMatchObject({ status: 'done', detail: 'Created the card and moved to "Sent"' })
  const card = (await h.db.query<{ stage_id: string; source: string; name: string }>("SELECT stage_id, source, name FROM opportunities"))[0]!
  expect(card).toEqual({ stage_id: 's1', source: 'workflow', name: 'Ana Rivera' })
  expect((await h.run()).steps[0]).toMatchObject({ status: 'skipped', detail: 'Already in "Sent"' })

  const back = await harness([{ type: 'move_to_stage', config: { pipelineId: 'p1', stageId: 's0' } }])
  await back.db.query("INSERT INTO opportunities (id, location_id, pipeline_id, stage_id, contact_id, name) VALUES ('o1','loc_a','p1','s2','c1','Ana')")
  expect((await back.run()).steps[0]).toMatchObject({ status: 'skipped', detail: 'Already further along ("Signed")' })
  expect((await back.db.query<{ stage_id: string }>("SELECT stage_id FROM opportunities"))[0]!.stage_id).toBe('s2')

  const loose = await harness([{ type: 'move_to_stage', config: { pipelineId: 'p1', stageId: 's0', onlyForward: false } }])
  await loose.db.query("INSERT INTO opportunities (id, location_id, pipeline_id, stage_id, contact_id, name) VALUES ('o1','loc_a','p1','s2','c1','Ana')")
  expect((await loose.run()).steps[0]!.status).toBe('done') // she asked for a move backwards explicitly

  const strict = await harness([{ type: 'move_to_stage', config: { pipelineId: 'p1', stageId: 's1', createIfMissing: false } }])
  expect((await strict.run()).steps[0]).toMatchObject({ status: 'skipped', detail: 'The client has no open card in this pipeline' })
  expect(await strict.db.query('SELECT 1 FROM opportunities')).toHaveLength(0)

  const gone = await harness([{ type: 'move_to_stage', config: { pipelineId: 'p1', stageId: 'nope' } }])
  expect((await gone.run()).steps[0]).toMatchObject({ status: 'failed' })
})

test('"only if the step before completed": a step after a skipped one is skipped', async () => {
  const h = await harness([
    { type: 'create_task', config: { title: '' } }, // nothing to create -> skipped
    { type: 'add_tag', config: { tag: 'after', requirePreviousDone: true } },
  ])
  const r = await h.run()
  expect(r.steps.map((s) => s.status)).toEqual(['skipped', 'skipped'])
  expect(r.steps[1]!.detail).toBe('The step before did not complete')
  expect(r.status).toBe('completed')
})

test('send_document_packet is skipped, with a reason, when there is nothing safe to send', async () => {
  const h = await harness([{ type: 'send_document_packet', config: {} }])
  expect((await h.run()).steps[0]).toMatchObject({ status: 'skipped', detail: 'No packet configured' })
  const noDob = await harness([{ type: 'send_document_packet', config: { packetId: 'nope' } }])
  expect((await noDob.run()).steps[0]).toMatchObject({ status: 'skipped', detail: 'No date of birth on the record' }) // nothing is sent before the age is known
  expect((await noDob.db.query<{ title: string }>('SELECT title FROM contact_tasks'))[0]!.title).toBe('Add date of birth to send the onboarding packet')
  const gone = await harness([{ type: 'send_document_packet', config: { packetId: 'nope' } }])
  await gone.db.query(`UPDATE contacts SET custom_fields = '{"date_of_birth":"1990-04-12"}' WHERE id='c1'`)
  expect((await gone.run()).steps[0]).toMatchObject({ status: 'failed', detail: 'The packet no longer exists' })
})

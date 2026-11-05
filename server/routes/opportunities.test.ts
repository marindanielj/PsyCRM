import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { opportunitiesRoute } from './opportunities'

function harness(db: FakeDatabase, locationId = 'locA') {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', locationId)
    await next()
  })
  app.route('/', opportunitiesRoute({ db }))
  return app
}

/** Like `harness`, but captures the workflow events the route dispatches. */
function harnessWithDispatch(db: FakeDatabase, locationId = 'locA') {
  const events: unknown[] = []
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', locationId)
    await next()
  })
  app.route('/', opportunitiesRoute({ db, dispatch: (e) => void events.push(e) }))
  return { app, events }
}

function patchJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GET /pipelines returns pipelines with nested stages, scoped to location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'p1', location_id: 'locA', name: 'Sales', position: 0 }]) // pipelines
  db.enqueue([{ id: 's1', location_id: 'locA', pipeline_id: 'p1', name: 'New', position: 0 }]) // stages
  const res = await harness(db).request('/pipelines')

  expect(res.status).toBe(200)
  const body = (await res.json()) as { pipelines: { id: string; stages: unknown[] }[] }
  expect(body.pipelines[0]?.id).toBe('p1')
  expect(body.pipelines[0]?.stages).toHaveLength(1)
  expect(db.calls.every((call) => call.params[0] === 'locA')).toBe(true)
})

test('GET / requires a pipelineId', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/')
  expect(res.status).toBe(400)
})

test('GET /?pipelineId lists opportunities for that pipeline, scoped to location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'o1', pipeline_id: 'p1' }])
  const res = await harness(db).request('/?pipelineId=p1')

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ opportunities: [{ id: 'o1', pipeline_id: 'p1' }] })
  expect(db.calls[0]?.params).toEqual(['locA', 'p1'])
})

test('POST / creates an opportunity (201) with location_id set', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'p1', location_id: 'locA', name: 'Sales' }]) // pipeline ownership get
  db.enqueue([{ id: 's1', location_id: 'locA', pipeline_id: 'p1' }]) // stage ownership get
  db.enqueue([{ id: 'o_new', location_id: 'locA', name: 'Deal' }]) // insert RETURNING
  const res = await harness(db).request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId: 'p1', stageId: 's1', name: 'Deal', valueCents: 50000 }),
  })

  expect(res.status).toBe(201)
  expect(await res.json()).toMatchObject({ ok: true, opportunity: { id: 'o_new' } })
  expect(db.calls[2]?.params[0]).toBe('locA') // insert scoped to location
})

test('POST / dispatches an opportunity_created event carrying the contact', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'p1', location_id: 'locA', name: 'Sales' }]) // pipeline ownership get
  db.enqueue([{ id: 's1', location_id: 'locA', pipeline_id: 'p1' }]) // stage ownership get
  db.enqueue([{ id: 'o_new', location_id: 'locA', name: 'Deal', contact_id: 'c7' }])
  const { app, events } = harnessWithDispatch(db)

  const res = await app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId: 'p1', stageId: 's1', name: 'Deal', contactId: 'c7' }),
  })

  expect(res.status).toBe(201)
  expect(events).toEqual([
    { locationId: 'locA', triggerType: 'opportunity_created', contactId: 'c7' },
  ])
})

test('POST / rejects a stage that does not belong to the pipeline (400)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'p1', location_id: 'locA', name: 'Sales' }]) // pipeline get
  db.enqueue([{ id: 's9', location_id: 'locA', pipeline_id: 'pOTHER' }]) // stage from another pipeline
  const res = await harness(db).request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId: 'p1', stageId: 's9', name: 'Deal' }),
  })
  expect(res.status).toBe(400)
})

test('POST / rejects a foreign pipeline id (400, no insert)', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // pipeline get -> none (foreign/unknown)
  db.enqueue([]) // stage get -> none
  const res = await harness(db).request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId: 'pX', stageId: 'sX', name: 'Deal' }),
  })
  expect(res.status).toBe(400)
  // only the two ownership lookups ran — no INSERT was attempted
  expect(db.calls.every((call) => /SELECT/i.test(call.sql))).toBe(true)
})

test('POST / rejects an empty name (400)', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId: 'p1', stageId: 's1', name: '' }),
  })
  expect(res.status).toBe(400)
})

test('PATCH /:id with stageId moves the card', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'o1', pipeline_id: 'p1', stage_id: 's1' }]) // existing opp get
  db.enqueue([{ id: 's2', location_id: 'locA', pipeline_id: 'p1' }]) // target stage get (same pipeline)
  db.enqueue([{ id: 'o1', stage_id: 's2' }]) // move RETURNING
  const res = await patchJson(harness(db), '/o1', { stageId: 's2' })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, opportunity: { stage_id: 's2' } })
  expect(db.calls[2]?.params).toEqual(['locA', 's2', 'o1']) // move scoped to location + id
})

test('PATCH /:id rejects moving a card into another pipeline stage (400)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'o1', pipeline_id: 'p1', stage_id: 's1' }]) // existing opp in pipeline p1
  db.enqueue([{ id: 's9', location_id: 'locA', pipeline_id: 'pOTHER' }]) // stage from another pipeline
  const res = await patchJson(harness(db), '/o1', { stageId: 's9' })
  expect(res.status).toBe(400)
})

test('PATCH /:id with status sets won/lost', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'o1', status: 'won' }])
  const res = await patchJson(harness(db), '/o1', { status: 'won' })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, opportunity: { status: 'won' } })
  expect(db.calls[0]?.params).toEqual(['locA', 'won', 'o1'])
})

test('PATCH /:id is 404 when the opportunity is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // existing opp get -> none (not in this location)
  const res = await patchJson(harness(db), '/missing', { stageId: 's2' })
  expect(res.status).toBe(404)
})

test('PATCH /:id rejects an invalid status (400)', async () => {
  const db = new FakeDatabase()
  const res = await patchJson(harness(db), '/o1', { status: 'banana' })
  expect(res.status).toBe(400)
})

// --- audit, timeline and the stage-change trigger ------------------------------

import { addLocation, freshDb } from '../test-utils/pglite'

const card = { id: 'o1', pipeline_id: 'p1', stage_id: 's1', contact_id: 'c1', name: 'Ana' }

test('moving a card to another stage audits it, writes the client timeline, then fires pipeline_stage_changed', async () => {
  const db = new FakeDatabase()
  db.enqueue([card]) // repo.get
  db.enqueue([{ id: 's2', pipeline_id: 'p1', name: 'Documents signed' }]) // getStage
  db.enqueue([{ ...card, stage_id: 's2' }]) // move
  const { app, events } = harnessWithDispatch(db)
  const res = await patchJson(app, '/o1', { stageId: 's2' })
  expect(res.status).toBe(200)
  expect(db.auditEntries()).toEqual([
    {
      locationId: 'locA', actorType: 'operator', actorId: 'op1', action: 'pipeline.stage_changed',
      entityType: 'opportunity', entityId: 'o1', contactId: 'c1',
      details: { pipelineId: 'p1', fromStageId: 's1', toStageId: 's2', toStage: 'Documents signed', origin: 'operator' },
    },
  ])
  const timeline = db.calls.find((c) => /INSERT INTO timeline_events/.test(c.sql))
  expect(timeline?.params).toContain('stage_changed')
  expect(timeline?.params).toContain('c1')
  expect(events).toEqual([{ locationId: 'locA', triggerType: 'pipeline_stage_changed', contactId: 'c1' }])
})

test('a card with no client still audits the move but writes no timeline event', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ ...card, contact_id: null }])
  db.enqueue([{ id: 's2', pipeline_id: 'p1', name: 'B' }])
  db.enqueue([{ ...card, contact_id: null, stage_id: 's2' }])
  const { app, events } = harnessWithDispatch(db)
  expect((await patchJson(app, '/o1', { stageId: 's2' })).status).toBe(200)
  expect(db.auditEntries()).toHaveLength(1)
  expect(db.calls.some((c) => /timeline_events/.test(c.sql))).toBe(false)
  expect(events).toEqual([{ locationId: 'locA', triggerType: 'pipeline_stage_changed', contactId: null }])
})

test('moving to the stage it is already in is a no-op: nothing audited, no trigger (so automations cannot loop)', async () => {
  const db = new FakeDatabase()
  db.enqueue([card])
  db.enqueue([{ id: 's1', pipeline_id: 'p1', name: 'Same' }])
  const { app, events } = harnessWithDispatch(db)
  const res = await patchJson(app, '/o1', { stageId: 's1' })
  expect(res.status).toBe(200)
  expect(db.audits).toHaveLength(0)
  expect(events).toHaveLength(0)
  expect(db.calls.some((c) => /UPDATE opportunities/.test(c.sql))).toBe(false)
})

test('rejected moves (unknown card, foreign or other-pipeline stage) leave no audit and no trigger', async () => {
  const missing = new FakeDatabase()
  missing.enqueue([])
  const a = harnessWithDispatch(missing)
  expect((await patchJson(a.app, '/nope', { stageId: 's2' })).status).toBe(404)

  const foreign = new FakeDatabase()
  foreign.enqueue([card])
  foreign.enqueue([{ id: 's9', pipeline_id: 'OTHER', name: 'x' }])
  const b = harnessWithDispatch(foreign)
  expect((await patchJson(b.app, '/o1', { stageId: 's9' })).status).toBe(400)

  const unknown = new FakeDatabase()
  unknown.enqueue([card])
  unknown.enqueue([])
  const c = harnessWithDispatch(unknown)
  expect((await patchJson(c.app, '/o1', { stageId: 'zz' })).status).toBe(400)

  for (const x of [missing, foreign, unknown]) expect(x.audits).toHaveLength(0)
  expect(a.events.length + b.events.length + c.events.length).toBe(0)
})

test('creating, changing the status of, and editing a card are audited', async () => {
  const db = new FakeDatabase()
  const app = harness(db)
  db.enqueue([{ id: 'p1' }])
  db.enqueue([{ id: 's1', pipeline_id: 'p1' }])
  db.enqueue([{ id: 'o9', contact_id: 'c1' }])
  await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pipelineId: 'p1', stageId: 's1', name: 'Ana', contactId: 'c1' }) })
  db.enqueue([{ id: 'o9', contact_id: 'c1', status: 'lost' }])
  await patchJson(app, '/o9', { status: 'lost' })
  db.enqueue([{ id: 'o9', contact_id: 'c1' }])
  await patchJson(app, '/o9', { name: 'Ana R.', valueCents: 100 })
  expect(db.auditEntries().map((e) => [e.action, e.details])).toEqual([
    ['opportunity.created', { pipelineId: 'p1', stageId: 's1' }],
    ['opportunity.status_changed', { to: 'lost' }],
    ['opportunity.updated', { fields: ['name', 'valueCents'] }],
  ])
})

test('against a real database a stage move is atomic: if the audit cannot be written, the card stays put and no trigger fires', async () => {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db)
  await db.query("INSERT INTO pipelines (id, location_id, name) VALUES ('p1',$1,'Onboarding')", [loc])
  await db.query("INSERT INTO pipeline_stages (id, location_id, pipeline_id, name, position) VALUES ('s1',$1,'p1','New',0),('s2',$1,'p1','Signed',1)", [loc])
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana')", [loc])
  await db.query("INSERT INTO opportunities (id, location_id, pipeline_id, stage_id, contact_id, name) VALUES ('o1',$1,'p1','s1','c1','Ana')", [loc])

  const events: unknown[] = []
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', loc)
    await next()
  })
  app.route('/', opportunitiesRoute({ db, dispatch: (e) => void events.push(e) }))

  expect((await patchJson(app, '/o1', { stageId: 's2' })).status).toBe(200)
  expect((await db.query<{ stage_id: string }>("SELECT stage_id FROM opportunities WHERE id='o1'"))[0]!.stage_id).toBe('s2')
  expect(await db.query("SELECT 1 FROM timeline_events WHERE type='stage_changed' AND contact_id='c1'")).toHaveLength(1)
  expect(await db.query("SELECT 1 FROM audit_log WHERE action='pipeline.stage_changed'")).toHaveLength(1)
  expect(events).toHaveLength(1)

  await pg.exec('ALTER TABLE audit_log RENAME TO audit_log_gone')
  const failed = await patchJson(app, '/o1', { stageId: 's1' })
  expect(failed.status).toBe(500)
  expect((await db.query<{ stage_id: string }>("SELECT stage_id FROM opportunities WHERE id='o1'"))[0]!.stage_id).toBe('s2') // rolled back
  expect(await db.query("SELECT 1 FROM timeline_events WHERE type='stage_changed'")).toHaveLength(1) // no orphan timeline row
  expect(events).toHaveLength(1) // and no second trigger
})

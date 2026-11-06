import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { calendarsRoute } from './calendars'

function harness(db: FakeDatabase, locationId = 'locA') {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', locationId)
    await next()
  })
  app.route('/', calendarsRoute({ db }))
  return app
}

function patchJson(app: Hono<AppEnv>, path: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GET / lists calendars scoped to the location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cal1', location_id: 'locA', name: 'Inspections' }])
  const res = await harness(db).request('/')

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ calendars: [{ id: 'cal1', location_id: 'locA', name: 'Inspections' }] })
  expect(db.calls[0]?.params).toEqual(['locA'])
})

test('POST / creates a calendar (201) with location_id set', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cal_new', location_id: 'locA', name: 'Consults' }])
  const res = await harness(db).request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Consults' }),
  })

  expect(res.status).toBe(201)
  expect(await res.json()).toMatchObject({ ok: true, calendar: { id: 'cal_new' } })
  expect(db.calls[0]?.params[0]).toBe('locA') // $1 = location_id
})

test('POST / rejects an empty name (400)', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '' }),
  })
  expect(res.status).toBe(400)
})

test('PATCH /:id updates booking config and runs the slug-uniqueness guard first', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // getByBookingSlug → slug is free
  db.enqueue([{ id: 'cal1', booking_enabled: true, booking_slug: 'cash-offer' }]) // update RETURNING
  const res = await patchJson(harness(db), '/cal1', {
    bookingEnabled: true,
    bookingSlug: 'cash-offer',
    timezone: 'America/New_York',
    availability: [{ weekday: 1, start: '09:00', end: '12:00' }],
  })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, calendar: { id: 'cal1' } })
  // the slug lookup ran first, location-scoped
  expect(db.calls[0]?.sql).toMatch(/booking_slug=\$2/i)
  expect(db.calls[0]?.params).toEqual(['locA', 'cash-offer'])
  // then the dynamic update with the booking columns + json availability
  expect(db.calls[1]?.sql).toMatch(/booking_enabled=\$2/i)
  expect(db.calls[1]?.params).toContain('America/New_York')
})

test('PATCH /:id is 409 when the booking slug is taken by another calendar', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'other', booking_slug: 'cash-offer' }]) // slug owned by a different cal
  const res = await patchJson(harness(db), '/cal1', { bookingSlug: 'cash-offer' })

  expect(res.status).toBe(409)
  expect((await res.json()).error).toBe('slug taken')
  expect(db.calls).toHaveLength(1) // never reached the update
})

test('PATCH /:id allows re-saving a calendar with its own existing slug', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cal1', booking_slug: 'cash-offer' }]) // slug owner IS this calendar
  db.enqueue([{ id: 'cal1', booking_blurb: 'Updated' }]) // update RETURNING
  const res = await patchJson(harness(db), '/cal1', {
    bookingSlug: 'cash-offer',
    bookingBlurb: 'Updated',
  })
  expect(res.status).toBe(200)
})

test('PATCH /:id rejects an invalid (non-url-safe) slug (400)', async () => {
  const db = new FakeDatabase()
  const res = await patchJson(harness(db), '/cal1', { bookingSlug: 'Cash Offer!' })
  expect(res.status).toBe(400)
})

test('PATCH /:id with an empty patch is 400', async () => {
  const db = new FakeDatabase()
  const res = await patchJson(harness(db), '/cal1', {})
  expect(res.status).toBe(400)
})

test('PATCH /:id is 404 when the calendar is not in this location', async () => {
  const db = new FakeDatabase()
  // No slug in the patch → no slug guard query; the update is the only call.
  db.enqueue([]) // update RETURNING → none
  const res = await patchJson(harness(db), '/missing', { bookingHeadline: 'Hi' })
  expect(res.status).toBe(404)
})

test('GET /appointments defaults to a now..+30d range when no query', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'a1' }])
  const res = await harness(db).request('/appointments')

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ appointments: [{ id: 'a1' }] })
  // $1 = location, $2 = from, $3 = to; both timestamps present and ordered.
  const params = db.calls[0]?.params as string[]
  expect(params[0]).toBe('locA')
  expect(Date.parse(params[1]!)).not.toBeNaN()
  expect(Date.parse(params[2]!)).toBeGreaterThan(Date.parse(params[1]!))
})

test('GET /appointments passes explicit from/to through', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'a1' }])
  await harness(db).request('/appointments?from=2026-06-01T00:00:00Z&to=2026-06-08T00:00:00Z')

  expect(db.calls[0]?.params).toEqual([
    'locA',
    '2026-06-01T00:00:00Z',
    '2026-06-08T00:00:00Z',
  ])
})

test('POST /appointments books an appointment (201) with location_id set', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cal1', location_id: 'locA', name: 'Inspections' }]) // calendar ownership get
  db.enqueue([{ id: 'a_new', location_id: 'locA', title: 'Inspection' }]) // insert RETURNING
  const res = await harness(db).request('/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId: 'cal1',
      title: 'Inspection',
      startsAt: '2026-06-04T15:00:00Z',
      endsAt: '2026-06-04T15:30:00Z',
    }),
  })

  expect(res.status).toBe(201)
  expect(await res.json()).toMatchObject({ ok: true, appointment: { id: 'a_new' } })
  expect(db.calls[0]?.params).toEqual(['locA', 'cal1']) // calendar get scoped to location
  expect(db.calls[1]?.params[0]).toBe('locA') // then the insert, also scoped
})

test('POST /appointments rejects an unknown or foreign calendar (400, no insert)', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // calendar ownership get → none (foreign or missing)
  const res = await harness(db).request('/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId: 'calX',
      title: 'Inspection',
      startsAt: '2026-06-04T15:00:00Z',
      endsAt: '2026-06-04T15:30:00Z',
    }),
  })

  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('unknown calendar')
  expect(db.calls.length).toBe(1) // only the ownership lookup — no insert attempted
})

test('POST /appointments is 409 when the calendar+instant is already taken', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cal1', location_id: 'locA' }]) // calendar ownership get succeeds
  db.enqueueError({ code: '23505' }) // the no-double-book unique index rejects the insert
  const res = await harness(db).request('/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId: 'cal1',
      title: 'Inspection',
      startsAt: '2026-06-04T15:00:00Z',
      endsAt: '2026-06-04T15:30:00Z',
    }),
  })

  expect(res.status).toBe(409)
  expect((await res.json()).error).toBe('time already booked')
})

test('POST /appointments still surfaces a non-conflict DB error (not a false 409)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cal1', location_id: 'locA' }]) // calendar ownership get succeeds
  db.enqueueError({ code: '23503' }) // a foreign-key violation must NOT be masked as a conflict
  await expect(
    harness(db).request('/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'cal1',
        title: 'Inspection',
        startsAt: '2026-06-04T15:00:00Z',
        endsAt: '2026-06-04T15:30:00Z',
      }),
    }),
  ).rejects.toBeTruthy()
})

test('POST /appointments rejects an empty title (400)', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId: 'cal1',
      title: '',
      startsAt: '2026-06-04T15:00:00Z',
      endsAt: '2026-06-04T15:30:00Z',
    }),
  })
  expect(res.status).toBe(400)
})

test('POST /appointments rejects a non-datetime startsAt (400, no DB call)', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId: 'cal1',
      title: 'Inspection',
      startsAt: 'soon',
      endsAt: '2026-06-04T15:30:00Z',
    }),
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0) // rejected at validation, never reached the DB
})

test('POST /appointments rejects an end at or before the start (400)', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      calendarId: 'cal1',
      title: 'Inspection',
      startsAt: '2026-06-04T15:30:00Z',
      endsAt: '2026-06-04T15:00:00Z', // backwards — must not store a negative-length slot
    }),
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('PATCH /appointments/:id rejects a reschedule whose end precedes the start (400)', async () => {
  const db = new FakeDatabase()
  const res = await patchJson(harness(db), '/appointments/a1', {
    startsAt: '2026-06-05T10:30:00Z',
    endsAt: '2026-06-05T10:00:00Z',
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('PATCH /appointments/:id reschedules when both timestamps given', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'a1', starts_at: '2026-06-05T10:00:00Z' }])
  const res = await patchJson(harness(db), '/appointments/a1', {
    startsAt: '2026-06-05T10:00:00Z',
    endsAt: '2026-06-05T10:30:00Z',
  })

  expect(res.status).toBe(200)
  expect(db.calls[0]?.params).toEqual([
    'locA',
    '2026-06-05T10:00:00Z',
    '2026-06-05T10:30:00Z',
    'a1',
  ])
})

test('PATCH /appointments/:id sets status', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'a1', status: 'completed' }])
  const res = await patchJson(harness(db), '/appointments/a1', { status: 'completed' })

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, appointment: { status: 'completed' } })
  expect(db.calls[0]?.params).toEqual(['locA', 'completed', 'a1'])
})

test('PATCH /appointments/:id with neither reschedule nor status is 400', async () => {
  const db = new FakeDatabase()
  const res = await patchJson(harness(db), '/appointments/a1', {})
  expect(res.status).toBe(400)
})

test('PATCH /appointments/:id is 404 when not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // setStatus RETURNING -> none
  const res = await patchJson(harness(db), '/appointments/missing', { status: 'confirmed' })
  expect(res.status).toBe(404)
})

test('PATCH /appointments/:id rejects an invalid status (400)', async () => {
  const db = new FakeDatabase()
  const res = await patchJson(harness(db), '/appointments/a1', { status: 'banana' })
  expect(res.status).toBe(400)
})

// --- audit ---------------------------------------------------------------------

import { addLocation, freshDb } from '../test-utils/pglite'

const putJson = (app: Hono<AppEnv>, path: string, method: string, body: unknown) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('creating an appointment is audited with its calendar and time, not its title or notes', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cal1', location_id: 'locA', name: 'Sessions' }]) // calendar lookup
  db.enqueue([{ id: 'ap1', contact_id: 'c1', starts_at: '2026-11-10T14:00:00.000Z' }]) // insert
  const res = await putJson(harness(db), '/appointments', 'POST', {
    calendarId: 'cal1', title: 'Ana Rivera – anxiety', startsAt: '2026-11-10T14:00:00.000Z', endsAt: '2026-11-10T14:50:00.000Z', contactId: 'c1', notes: 'private note',
  })
  expect(res.status).toBe(201)
  expect(db.auditEntries()).toEqual([
    { locationId: 'locA', actorType: 'operator', actorId: 'op1', action: 'appointment.created', entityType: 'appointment', entityId: 'ap1', contactId: 'c1', details: { calendarId: 'cal1', startsAt: '2026-11-10T14:00:00.000Z' } },
  ])
  const logged = JSON.stringify(db.audits)
  expect(logged).not.toContain('anxiety')
  expect(logged).not.toContain('private note')
})

test('a double-booked create is a 409 with nothing audited', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'cal1' }])
  db.enqueueError(Object.assign(new Error('dup'), { code: '23505' }))
  const res = await putJson(harness(db), '/appointments', 'POST', { calendarId: 'cal1', title: 't', startsAt: '2026-11-10T14:00:00.000Z', endsAt: '2026-11-10T14:50:00.000Z' })
  expect(res.status).toBe(409)
  expect(db.audits).toHaveLength(0)
})

test('rescheduling and changing status are audited with from/to, and the API body stays free of the bookkeeping columns', async () => {
  const db = new FakeDatabase()
  const app = harness(db)
  db.enqueue([{ id: 'ap1', contact_id: 'c1', starts_at: '2026-11-11T14:00:00.000Z', prev_starts_at: '2026-11-10T14:00:00.000Z' }])
  const r1 = await patchJson(app, '/appointments/ap1', { startsAt: '2026-11-11T14:00:00.000Z', endsAt: '2026-11-11T14:50:00.000Z' })
  db.enqueue([{ id: 'ap1', contact_id: 'c1', status: 'no_show', prev_status: 'scheduled' }])
  const r2 = await patchJson(app, '/appointments/ap1', { status: 'no_show' })
  expect(r1.status).toBe(200)
  expect(JSON.stringify(await r1.json())).not.toContain('prev_')
  expect(JSON.stringify(await r2.json())).not.toContain('prev_')
  expect(db.auditEntries().map((e) => [e.action, e.contactId, e.details])).toEqual([
    ['appointment.rescheduled', 'c1', { from: '2026-11-10T14:00:00.000Z', to: '2026-11-11T14:00:00.000Z' }],
    ['appointment.status_changed', 'c1', { from: 'scheduled', to: 'no_show' }],
  ])
})

test('an unknown appointment is a 404 and is not audited', async () => {
  const db = new FakeDatabase()
  db.enqueue([])
  expect((await patchJson(harness(db), '/appointments/nope', { status: 'cancelled' })).status).toBe(404)
  expect(db.audits).toHaveLength(0)
})

test('against a real database the from/to come from the row itself and the audit is atomic with the change', async () => {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db)
  await db.query("INSERT INTO calendars (id, location_id, name) VALUES ('cal1',$1,'Sessions')", [loc])
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana')", [loc])
  await db.query(
    "INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at) VALUES ('ap1',$1,'cal1','c1','t','2026-11-10T14:00:00Z','2026-11-10T14:50:00Z')",
    [loc],
  )
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', loc)
    await next()
  })
  app.route('/', calendarsRoute({ db }))

  expect((await patchJson(app, '/appointments/ap1', { status: 'confirmed' })).status).toBe(200)
  expect((await patchJson(app, '/appointments/ap1', { startsAt: '2026-11-12T15:00:00.000Z', endsAt: '2026-11-12T15:50:00.000Z' })).status).toBe(200)
  const rows = await db.query<{ action: string; contact_id: string; details: Record<string, string> }>('SELECT action, contact_id, details FROM audit_log ORDER BY chain_seq')
  expect(rows.map((r) => r.action)).toEqual(['appointment.status_changed', 'appointment.rescheduled'])
  expect(rows[0]!.details).toEqual({ from: 'scheduled', to: 'confirmed' })
  expect(new Date(rows[1]!.details.from!).toISOString()).toBe('2026-11-10T14:00:00.000Z')
  expect(new Date(rows[1]!.details.to!).toISOString()).toBe('2026-11-12T15:00:00.000Z')
  expect(rows.every((r) => r.contact_id === 'c1')).toBe(true)

  await pg.exec('ALTER TABLE audit_log RENAME TO audit_log_gone')
  expect((await patchJson(app, '/appointments/ap1', { status: 'cancelled' })).status).toBe(500)
  expect((await db.query<{ status: string }>("SELECT status FROM appointments WHERE id='ap1'"))[0]!.status).toBe('confirmed') // rolled back
})

// --- check-in ------------------------------------------------------------------------

function harnessWithDispatch(db: FakeDatabase | import('../db/database').Database, locationId = 'locA') {
  const events: unknown[] = []
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', locationId)
    await next()
  })
  app.route('/', calendarsRoute({ db, dispatch: (e) => void events.push(e) }))
  return { app, events }
}
const checkIn = (app: Hono<AppEnv>, id = 'ap1') => app.request(`/appointments/${id}/check-in`, { method: 'POST' })

test('check-in moves a scheduled appointment to checked_in, audits it, writes the client timeline, then fires the trigger', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'ap1', contact_id: 'c1', status: 'scheduled', starts_at: '2026-11-10T14:00:00.000Z' }]) // read
  db.enqueue([{ id: 'ap1', contact_id: 'c1', status: 'checked_in', checked_in_at: '2026-11-10T13:55:00.000Z', starts_at: '2026-11-10T14:00:00.000Z' }]) // update
  const { app, events } = harnessWithDispatch(db)
  const res = await checkIn(app)
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, changed: true, appointment: { status: 'checked_in' } })
  expect(db.auditEntries()).toEqual([
    { locationId: 'locA', actorType: 'operator', actorId: 'op1', action: 'appointment.checked_in', entityType: 'appointment', entityId: 'ap1', contactId: 'c1', details: { from: 'scheduled' } },
  ])
  expect(db.calls.find((c) => /INSERT INTO timeline_events/.test(c.sql))?.params).toContain('appointment_checked_in')
  expect(events).toEqual([{ locationId: 'locA', triggerType: 'appointment_checked_in', contactId: 'c1' }])
})

test('checking in twice is a harmless no-op; a cancelled, no-show or completed appointment cannot be checked in; unknown is 404', async () => {
  const again = new FakeDatabase()
  again.enqueue([{ id: 'ap1', contact_id: 'c1', status: 'checked_in' }])
  const a = harnessWithDispatch(again)
  const r1 = await checkIn(a.app)
  expect(r1.status).toBe(200)
  expect(await r1.json()).toMatchObject({ changed: false })
  expect(again.audits).toHaveLength(0)
  expect(a.events).toHaveLength(0)

  for (const status of ['cancelled', 'no_show', 'completed']) {
    const db = new FakeDatabase()
    db.enqueue([{ id: 'ap1', contact_id: 'c1', status }])
    const { app, events } = harnessWithDispatch(db)
    const res = await checkIn(app)
    expect(res.status, status).toBe(409)
    expect(await res.json()).toEqual({ error: 'cannot_check_in', status })
    expect(db.audits).toHaveLength(0)
    expect(events).toHaveLength(0)
  }
  const none = new FakeDatabase()
  none.enqueue([])
  expect((await checkIn(harnessWithDispatch(none).app, 'zzz')).status).toBe(404)
})

test('against a real database check-in stamps the time, and the change, audit row and timeline entry are one unit', async () => {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db)
  await db.query("INSERT INTO calendars (id, location_id, name) VALUES ('cal1',$1,'Sessions')", [loc])
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana')", [loc])
  await db.query("INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at, status) VALUES ('ap1',$1,'cal1','c1','t','2026-11-10T14:00:00Z','2026-11-10T14:50:00Z','confirmed')", [loc])
  const { app, events } = harnessWithDispatch(db, loc)

  expect((await checkIn(app)).status).toBe(200)
  const [row] = await db.query<{ status: string; checked_in_at: Date | null }>("SELECT status, checked_in_at FROM appointments WHERE id='ap1'")
  expect(row!.status).toBe('checked_in')
  expect(row!.checked_in_at).toBeInstanceOf(Date)
  expect(await db.query("SELECT 1 FROM timeline_events WHERE type='appointment_checked_in' AND contact_id='c1'")).toHaveLength(1)
  expect((await db.query<{ details: { from: string } }>("SELECT details FROM audit_log WHERE action='appointment.checked_in'"))[0]!.details).toEqual({ from: 'confirmed' })
  expect(events).toHaveLength(1)
  // a second tap changes nothing
  await checkIn(app)
  expect(await db.query("SELECT 1 FROM audit_log WHERE action='appointment.checked_in'")).toHaveLength(1)
  expect(events).toHaveLength(1)

  // with the audit table down, a fresh check-in fails AND leaves the appointment untouched
  await db.query("INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at) VALUES ('ap2',$1,'cal1','c1','t','2026-11-11T14:00:00Z','2026-11-11T14:50:00Z')", [loc])
  await pg.exec('ALTER TABLE audit_log RENAME TO audit_log_gone')
  expect((await checkIn(app, 'ap2')).status).toBe(500)
  expect((await db.query<{ status: string }>("SELECT status FROM appointments WHERE id='ap2'"))[0]!.status).toBe('scheduled')
  expect(events).toHaveLength(1)
})

test('checked_in is a valid appointment status for the status endpoint too', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'ap1', contact_id: 'c1', status: 'checked_in', prev_status: 'scheduled' }])
  expect((await patchJson(harness(db), '/appointments/ap1', { status: 'checked_in' })).status).toBe(200)
})

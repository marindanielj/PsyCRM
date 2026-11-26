import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { addLocation, freshDb } from '../test-utils/pglite'
import { SessionNotesRepo } from '../repos/session-notes-repo'
import { calendarsRoute } from './calendars'

/** Edit and delete an appointment, against real SQL: the guards live in constraints and transactions. */
async function setup() {
  const { db } = await freshDb()
  await addLocation(db, 'loc_a')
  await addLocation(db, 'loc_b')
  await db.query("INSERT INTO calendars (id, location_id, name) VALUES ('cal1','loc_a','S')")
  await db.query("INSERT INTO contacts (id, location_id, name, emails) VALUES ('c1','loc_a','Ana','{}'),('c2','loc_a','Luis','{}'),('cx','loc_b','Foreign','{}')")
  await db.query(
    `INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at, modality, notes)
     VALUES ('a1','loc_a','cal1','c1','Sesión Ana','2026-06-04T15:00:00Z','2026-06-04T15:50:00Z','in_person','PRIVATE-NOTE')`,
  )
  const mk = (loc: string) => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => { c.set('operatorId', 'op1'); c.set('locationId', loc); await next() })
    app.route('/', calendarsRoute({ db }))
    return app
  }
  const app = mk('loc_a')
  const patch = (body: unknown, id = 'a1', a = app) => a.request(`/appointments/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const del = (id = 'a1', a = app) => a.request(`/appointments/${id}`, { method: 'DELETE' })
  const row = async (): Promise<any> => (await db.query<Record<string, any>>("SELECT * FROM appointments WHERE id='a1'"))[0]
  const audits = async () => (await db.query<{ action: string; details: Record<string, unknown> }>("SELECT action, details FROM audit_log WHERE entity_id='a1' ORDER BY id")).map((a) => ({ action: a.action, details: a.details }))
  return { db, app, mk, patch, del, row, audits }
}

test('details can be edited: title, client, place, notes and how it is held; the log keeps field names, never the text', async () => {
  const s = await setup()
  const res = await s.patch({ title: 'Sesión de seguimiento', contactId: 'c2', locationText: 'Oficina 2', notes: 'SECRET-EDIT', modality: 'phone' })
  expect(res.status).toBe(200)
  expect(await s.row()).toMatchObject({ title: 'Sesión de seguimiento', contact_id: 'c2', location_text: 'Oficina 2', notes: 'SECRET-EDIT', modality: 'phone' })
  const a = await s.audits()
  expect(a.map((x) => x.action)).toEqual(['appointment.updated'])
  expect(a[0]!.details).toMatchObject({ fields: ['title', 'contactId', 'locationText', 'notes', 'modality'], modality: { from: 'in_person', to: 'phone' } })
  expect(JSON.stringify(a)).not.toMatch(/SECRET-EDIT|seguimiento|Oficina/)
})

test('notes and place can be cleared with null; an unchanged save writes nothing and logs nothing', async () => {
  const s = await setup()
  expect((await s.patch({ notes: null })).status).toBe(200)
  expect((await s.row()).notes).toBeNull()
  const before = (await s.audits()).length
  expect((await s.patch({ title: 'Sesión Ana', modality: 'in_person' })).status).toBe(200)
  expect((await s.audits()).length).toBe(before)
})

test('one save can edit details, move the appointment and change its status together', async () => {
  const s = await setup()
  const res = await s.patch({ title: 'Nueva', startsAt: '2026-06-05T16:00:00Z', endsAt: '2026-06-05T16:50:00Z', status: 'confirmed' })
  expect(res.status).toBe(200)
  expect(await s.row()).toMatchObject({ title: 'Nueva', status: 'confirmed' })
  expect(new Date((await s.row()).starts_at).toISOString()).toBe('2026-06-05T16:00:00.000Z')
  expect((await s.audits()).map((x) => x.action)).toEqual(['appointment.updated', 'appointment.rescheduled', 'appointment.status_changed'])
})

test('a failed part rolls the whole save back (moving onto a booked time keeps the new title out too)', async () => {
  const s = await setup()
  await s.db.query("INSERT INTO appointments (id, location_id, calendar_id, title, starts_at, ends_at) VALUES ('a2','loc_a','cal1','Otra','2026-06-06T10:00:00Z','2026-06-06T10:50:00Z')")
  const res = await s.patch({ title: 'No debe quedar', startsAt: '2026-06-06T10:00:00Z', endsAt: '2026-06-06T10:50:00Z' })
  expect(res.status).toBe(409)
  expect((await s.row()).title).toBe('Sesión Ana')
})

test('the client must be one of this practice\'s, when editing and when booking', async () => {
  const s = await setup()
  expect((await s.patch({ contactId: 'cx' })).status).toBe(400)
  expect((await s.row()).contact_id).toBe('c1')
  const book = await s.app.request('/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calendarId: 'cal1', title: 'X', startsAt: '2026-06-07T10:00:00Z', endsAt: '2026-06-07T10:50:00Z', contactId: 'cx' }) })
  expect(book.status).toBe(400)
})

test('another practice cannot edit or delete it', async () => {
  const s = await setup()
  const other = s.mk('loc_b')
  expect((await s.patch({ title: 'x' }, 'a1', other)).status).toBe(404)
  expect((await s.del('a1', other)).status).toBe(404)
  expect((await s.row()).title).toBe('Sesión Ana')
})

test('an empty save, half a time range and an unknown modality are refused', async () => {
  const s = await setup()
  expect((await s.patch({})).status).toBe(400)
  expect((await s.patch({ startsAt: '2026-06-05T16:00:00Z' })).status).toBe(400)
  expect((await s.patch({ modality: 'smoke' })).status).toBe(400)
  expect((await s.patch({ title: '' })).status).toBe(400)
})

test('how it is held cannot change once the session is completed (billing follows it), but other details can', async () => {
  const s = await setup()
  await s.patch({ status: 'completed' })
  expect((await s.patch({ modality: 'telehealth_video' })).status).toBe(409)
  expect((await s.row()).modality).toBe('in_person')
  expect((await s.patch({ notes: 'ok' })).status).toBe(200)
})

test('switching to video for a client with no consent warns; switching away from a live video room is refused', async () => {
  const s = await setup()
  const on = await (await s.patch({ modality: 'telehealth_video' })).json()
  expect(on.warnings).toContain('telepsychology_consent_missing')

  await s.db.query("INSERT INTO video_meetings (id, location_id, appointment_id, token_hash, chime_meeting) VALUES ('vm1','loc_a','a1','h','{\"MeetingId\":\"m\"}')")
  const blocked = await s.patch({ modality: 'phone' })
  expect(blocked.status).toBe(409)
  expect((await blocked.json()).error).toBe('video session in progress')
  expect((await s.row()).modality).toBe('telehealth_video')

  await s.db.query("UPDATE video_meetings SET ended_at = now() WHERE id='vm1'")
  expect((await s.patch({ modality: 'phone' })).status).toBe(200)
})

test('delete removes the appointment and logs it without its text; a second delete is 404', async () => {
  const s = await setup()
  expect((await s.del()).status).toBe(200)
  expect(await s.row()).toBeUndefined()
  const a = await s.audits()
  expect(a.map((x) => x.action)).toEqual(['appointment.deleted'])
  expect(JSON.stringify(a)).not.toMatch(/PRIVATE-NOTE|Sesión Ana/)
  expect((await s.del()).status).toBe(404)
})

test('delete is refused while a session note is written for it', async () => {
  const s = await setup()
  await s.db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra','h')")
  const made = await new SessionNotesRepo(s.db, 'loc_a').create({ contactId: 'c1', appointmentId: 'a1', sessionDate: '2026-06-04' } as never, { operatorId: 'op1', ip: null, userAgent: null })
  if (!made.ok) throw new Error('note not created')
  expect((await s.db.query("SELECT 1 FROM session_notes WHERE appointment_id='a1'")).length).toBe(1) // really linked

  const blocked = await s.del()
  expect(blocked.status).toBe(409)
  expect((await blocked.json()).error).toBe('has a session note')
  expect(await s.row()).toBeDefined()
  expect((await s.audits()).map((a) => a.action)).not.toContain('appointment.deleted') // the refused delete left no trace behind
})

test('delete is refused while a video session is live; once it has ended the room goes with the appointment', async () => {
  const t = await setup()
  await t.db.query("INSERT INTO video_meetings (id, location_id, appointment_id, token_hash, chime_meeting) VALUES ('vm1','loc_a','a1','h','{\"MeetingId\":\"m\"}')")
  expect((await t.del()).status).toBe(409)
  expect(await t.row()).toBeDefined()
  await t.db.query("UPDATE video_meetings SET ended_at = now() WHERE id='vm1'")
  expect((await t.del()).status).toBe(200)
  expect((await t.db.query('SELECT 1 FROM video_meetings')).length).toBe(0)
})

test('a charge made from the appointment does not stop its deletion, and is left untouched', async () => {
  const u = await setup()
  await u.db.query(
    "INSERT INTO charges (id, location_id, contact_id, appointment_id, service_date, cpt_code, fee_cents, created_by) VALUES ('ch1','loc_a','c1','a1','2026-06-04','90834',10000,'op1')",
  )
  expect((await u.del()).status).toBe(200)
  expect((await u.db.query<{ appointment_id: string }>("SELECT appointment_id FROM charges WHERE id='ch1'"))[0]?.appointment_id).toBe('a1')
})

test('the default list starts at the beginning of today: an appointment earlier today stays, yesterday\'s does not, an explicit range overrides', async () => {
  const s = await setup()
  const now = new Date()
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const at = (ms: number) => new Date(ms).toISOString()
  const insert = (id: string, startMs: number) =>
    s.db.query("INSERT INTO appointments (id, location_id, calendar_id, title, starts_at, ends_at) VALUES ($1,'loc_a','cal1',$1,$2,$3)", [id, at(startMs), at(startMs + 50 * 60_000)])
  await insert('earlier-today', startOfToday + 60_000) // 00:01 UTC today: already past for most of the day
  await insert('yesterday', startOfToday - 3 * 3600_000)
  await insert('next-week', startOfToday + 7 * 86_400_000)

  const ids = async (qs = '') => (await (await s.app.request(`/appointments${qs}`)).json()).appointments.map((a: { id: string }) => a.id).sort()
  expect(await ids()).toEqual(expect.arrayContaining(['earlier-today', 'next-week']))
  expect(await ids()).not.toContain('yesterday')
  const yest = encodeURIComponent(at(startOfToday - 6 * 3600_000))
  const today = encodeURIComponent(at(startOfToday))
  expect(await ids(`?from=${yest}&to=${today}`)).toEqual(['yesterday']) // the month grid asks for its own days
})

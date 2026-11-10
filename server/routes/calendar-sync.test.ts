import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { calendarBusyFor, toConfig } from '../lib/booking-availability'
import { slotsForDate } from '../lib/availability'
import { syncDue } from '../lib/calendar-sync'
import type { FetchResult } from '../lib/ssrf'
import { CalendarsRepo } from '../repos/calendars-repo'
import { addLocation, freshDb } from '../test-utils/pglite'
import { calendarFeedRoute, calendarSyncRoute } from './calendar-sync'
import { calendarsRoute } from './calendars'

const SECRET = 'a-session-secret-that-is-long-enough-0123456789'
const BASE = 'https://app.example.org'
const DAY = 24 * 3600_000
const ics = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
/** An event tomorrow at 15:00-16:00 UTC (plus `days`), with a title that must never reach the database. */
const personal = (days = 0, title = 'Dentist - Maria Lopez') => {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + (1 + days) * DAY + 15 * 3600_000)
  const end = new Date(start.getTime() + 3600_000)
  return { start, end, text: `BEGIN:VEVENT\r\nUID:e${days}\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(end)}\r\nSUMMARY:${title}\r\nDESCRIPTION:private notes 787-555-0100\r\nEND:VEVENT` }
}

async function setup() {
  const { db, pg } = await freshDb()
  const locA = await addLocation(db, 'loc_a')
  const locB = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera','h')")
  let body: FetchResult = { ok: true, text: ics(personal().text) }
  const seen: string[] = []
  const fetchText = async (url: string) => {
    seen.push(url)
    return body
  }
  const mount = (loc: string, externalBusy = true) => {
    const a = new Hono<AppEnv>()
    a.use('/api/*', async (c, next) => {
      c.set('operatorId', 'op1')
      c.set('locationId', loc)
      await next()
    })
    a.route('/api/sync', calendarSyncRoute({ db, secret: SECRET, publicBaseUrl: BASE, fetchText }))
    a.route('/api/cal', calendarsRoute({ db, externalBusy }))
    a.route('/cal', calendarFeedRoute({ db }))
    return a
  }
  const A = mount(locA)
  const B = mount(locB)
  const call = (app: Hono<AppEnv>, method: string, path: string, json?: unknown) =>
    app.request(path, { method, ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } } : {}) })
  return {
    db, pg, locA, locB, A, B, call, seen,
    setBody: (b: FetchResult) => { body = b },
    /** A calendar and a few appointments for a practice. */
    async seedAppointments(loc: string, calId: string, rows: { id: string; title: string; start: Date; hours?: number; status?: string; notes?: string }[]) {
      await db.query("INSERT INTO calendars (id, location_id, name, timezone) VALUES ($1,$2,'Main','America/Puerto_Rico') ON CONFLICT DO NOTHING", [calId, loc])
      for (const r of rows) {
        await db.query('INSERT INTO appointments (id, location_id, calendar_id, title, starts_at, ends_at, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
          r.id, loc, calId, r.title, r.start.toISOString(), new Date(r.start.getTime() + (r.hours ?? 1) * 3600_000).toISOString(), r.status ?? 'scheduled', r.notes ?? null,
        ])
      }
    },
  }
}

const tokenOf = (url: string) => /\/cal\/([A-Za-z0-9_-]{43})\.ics$/.exec(url)![1]!

// --- the practice's own feed ------------------------------------------------------------------------------------

test('the feed address is shown once, is built on the public origin, and cannot be read back', async () => {
  const s = await setup()
  const made = await s.call(s.A, 'POST', '/api/sync/feed')
  expect(made.status).toBe(201)
  const { url } = (await made.json()) as { url: string }
  expect(url).toMatch(/^https:\/\/app\.example\.org\/cal\/[A-Za-z0-9_-]{43}\.ics$/)

  const state = (await (await s.call(s.A, 'GET', '/api/sync')).json()) as { feed: Record<string, unknown> }
  expect(state.feed).toMatchObject({ title: 'Cita', fetch_count: 0 })
  expect(JSON.stringify(state)).not.toContain(tokenOf(url))

  // only a hash is stored
  const stored = await s.db.query<{ token_hash: string }>('SELECT token_hash FROM calendar_feeds')
  expect(stored[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(stored[0]!.token_hash).not.toContain(tokenOf(url))
})

test('the feed lists generic blocks only: no client name, no notes, no place', async () => {
  const s = await setup()
  const soon = new Date(Date.now() + 2 * DAY)
  await s.seedAppointments(s.locA, 'cal_a', [
    { id: 'ap1', title: 'Session - Maria Lopez (panic attacks)', start: soon, notes: 'discussed medication, call 787-555-0100' },
    { id: 'ap2', title: 'Session - Juan Perez', start: new Date(soon.getTime() + DAY), status: 'confirmed' },
    { id: 'ap3', title: 'Cancelled - Ana Ruiz', start: new Date(soon.getTime() + 2 * DAY), status: 'cancelled' },
  ])
  const { url } = (await (await s.call(s.A, 'POST', '/api/sync/feed')).json()) as { url: string }
  const res = await s.call(s.A, 'GET', `/cal/${tokenOf(url)}.ics`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/calendar')
  expect(res.headers.get('cache-control')).toContain('no-store')
  expect(res.headers.get('x-robots-tag')).toContain('noindex')
  const text = await res.text()
  expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2) // the cancelled one is not published
  expect(text.match(/SUMMARY:Cita/g)).toHaveLength(2)
  expect(text).not.toMatch(/Maria|Lopez|Juan|Perez|Ana|Ruiz|panic|medication|787|Session|Cancelled/)
})

test('the title can be switched to "Ocupado"; the choice is audited', async () => {
  const s = await setup()
  const { url } = (await (await s.call(s.A, 'POST', '/api/sync/feed')).json()) as { url: string }
  await s.seedAppointments(s.locA, 'cal_a', [{ id: 'ap1', title: 'x', start: new Date(Date.now() + DAY) }])
  expect((await s.call(s.A, 'PUT', '/api/sync/feed', { title: 'Ocupado' })).status).toBe(200)
  expect((await s.call(s.A, 'PUT', '/api/sync/feed', { title: 'Anything else' })).status).toBe(400)
  expect(await (await s.call(s.A, 'GET', `/cal/${tokenOf(url)}.ics`)).text()).toContain('SUMMARY:Ocupado')
  const rows = await s.db.query("SELECT action FROM audit_log WHERE action = 'calendar.feed_title_changed'")
  expect(rows).toHaveLength(1)
})

test('one practice never sees another practice\'s appointments in its feed', async () => {
  const s = await setup()
  await s.seedAppointments(s.locA, 'cal_a', [{ id: 'apA', title: 'a', start: new Date(Date.now() + DAY) }])
  await s.seedAppointments(s.locB, 'cal_b', [{ id: 'apB1', title: 'b', start: new Date(Date.now() + DAY) }, { id: 'apB2', title: 'b', start: new Date(Date.now() + 2 * DAY) }])
  const a = (await (await s.call(s.A, 'POST', '/api/sync/feed')).json()) as { url: string }
  const text = await (await s.call(s.A, 'GET', `/cal/${tokenOf(a.url)}.ics`)).text()
  expect(text).toContain('appt-apA@psycrm')
  expect(text).not.toContain('apB')
})

test('replacing the address kills the old one at once; turning the feed off kills them all', async () => {
  const s = await setup()
  const first = (await (await s.call(s.A, 'POST', '/api/sync/feed')).json()) as { url: string }
  // a second "create" without asking to replace is refused, so a stray click cannot break her phone subscription
  expect((await s.call(s.A, 'POST', '/api/sync/feed')).status).toBe(409)
  const second = (await (await s.call(s.A, 'POST', '/api/sync/feed?replace=1')).json()) as { url: string; rotated: boolean }
  expect(second.rotated).toBe(true)
  expect(tokenOf(second.url)).not.toBe(tokenOf(first.url))
  expect((await s.call(s.A, 'GET', `/cal/${tokenOf(first.url)}.ics`)).status).toBe(404)
  expect((await s.call(s.A, 'GET', `/cal/${tokenOf(second.url)}.ics`)).status).toBe(200)
  expect((await s.call(s.A, 'DELETE', '/api/sync/feed')).status).toBe(200)
  expect((await s.call(s.A, 'GET', `/cal/${tokenOf(second.url)}.ics`)).status).toBe(404)
  expect((await s.call(s.A, 'DELETE', '/api/sync/feed')).status).toBe(404)
  const actions = (await s.db.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'calendar.feed_%' ORDER BY id")).map((r) => r.action)
  expect(actions).toEqual(['calendar.feed_created', 'calendar.feed_regenerated', 'calendar.feed_fetched', 'calendar.feed_revoked'])
})

test('every wrong address gets the same plain 404: malformed, unknown, wrong extension', async () => {
  const s = await setup()
  await s.call(s.A, 'POST', '/api/sync/feed')
  const bodies = new Set<string>()
  for (const path of ['/cal/nope.ics', `/cal/${'A'.repeat(43)}.ics`, `/cal/${'A'.repeat(43)}`, '/cal/.ics', `/cal/${'A'.repeat(200)}.ics`]) {
    const r = await s.call(s.A, 'GET', path)
    expect(r.status, path).toBe(404)
    bodies.add(await r.text())
  }
  expect(bodies.size).toBe(1)
})

test('reads are counted, but the audit log gets one line per day, not one per poll', async () => {
  const s = await setup()
  const { url } = (await (await s.call(s.A, 'POST', '/api/sync/feed')).json()) as { url: string }
  for (let i = 0; i < 4; i++) await s.call(s.A, 'GET', `/cal/${tokenOf(url)}.ics`)
  expect(((await s.db.query<{ n: number }>('SELECT fetch_count::int AS n FROM calendar_feeds'))[0]!.n)).toBe(4)
  expect(await s.db.query("SELECT 1 FROM audit_log WHERE action = 'calendar.feed_fetched'")).toHaveLength(1)
  // a day later the next read is logged again
  await s.db.query("UPDATE calendar_feeds SET last_fetched_at = now() - interval '25 hours'")
  await s.call(s.A, 'GET', `/cal/${tokenOf(url)}.ics`)
  expect(await s.db.query("SELECT 1 FROM audit_log WHERE action = 'calendar.feed_fetched'")).toHaveLength(2)
})

// --- her personal calendars -------------------------------------------------------------------------------------

const GOOGLE = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123456789abcdef/basic.ics'

test('connecting a calendar reads it at once and keeps only start and end', async () => {
  const s = await setup()
  const res = await s.call(s.A, 'POST', '/api/sync/calendars', { label: 'Personal', url: GOOGLE })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { calendar: Record<string, unknown>; sync: { ok: boolean; blocks: number } }
  expect(body.sync).toMatchObject({ ok: true, blocks: 1 })
  expect(body.calendar).toMatchObject({ label: 'Personal', host: 'calendar.google.com', last_status: 'ok', block_count: 1 })
  // the address is never returned, in this response or later
  expect(JSON.stringify(body)).not.toMatch(/private-0123|me%40gmail/)
  expect(JSON.stringify(await (await s.call(s.A, 'GET', '/api/sync')).json())).not.toMatch(/private-0123|me%40gmail/)
  expect(s.seen).toEqual([GOOGLE])

  // what was stored is a start and an end: no title, no notes, anywhere in the database
  const busy = await s.db.query('SELECT * FROM external_busy')
  expect(busy).toHaveLength(1)
  expect(Object.keys(busy[0] as object).sort()).toEqual(['ends_at', 'external_calendar_id', 'id', 'location_id', 'starts_at'])
  const dump = JSON.stringify({ busy, cal: await s.db.query('SELECT * FROM external_calendars'), audit: await s.db.query('SELECT * FROM audit_log') })
  expect(dump).not.toMatch(/Dentist|Maria|Lopez|787-555|private notes/)
  // the address is sealed at rest and absent from the audit log
  expect(dump).not.toMatch(/private-0123|me%40gmail/)
})

test('addresses that point inward, are not https, or are her own feed are refused before any fetch', async () => {
  const s = await setup()
  for (const [url, error] of [
    ['http://calendar.google.com/x.ics', 'not_https'],
    ['https://169.254.169.254/latest/meta-data', 'blocked_address'],
    ['https://localhost/x.ics', 'blocked_address'],
    ['https://10.1.1.1/x.ics', 'blocked_address'],
    ['file:///etc/passwd', 'not_https'],
    ['not a url at all', 'invalid_url'],
    [`${BASE}/cal/${'A'.repeat(43)}.ics`, 'own_feed'],
  ] as const) {
    const r = await s.call(s.A, 'POST', '/api/sync/calendars', { url })
    expect(r.status, url).toBe(422)
    expect(((await r.json()) as { error: string }).error, url).toBe(error)
  }
  expect(s.seen).toEqual([])
  expect(await s.db.query('SELECT 1 FROM external_calendars')).toHaveLength(0)
})

test('a page that is not a calendar, or cannot be reached, is reported at once and nothing is stored', async () => {
  const s = await setup()
  s.setBody({ ok: true, text: '<html>Sign in to Google</html>' })
  const notCal = await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE })
  expect(notCal.status).toBe(422)
  expect(await notCal.json()).toEqual({ error: 'not_calendar' })
  s.setBody({ ok: false, error: 'unreachable' })
  const down = await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE })
  expect(down.status).toBe(422)
  expect(await down.json()).toEqual({ error: 'unreachable' })
  // a typo leaves nothing behind: no row, no blocks, no "connected" entry in the audit log
  expect(await s.db.query('SELECT 1 FROM external_calendars')).toHaveLength(0)
  expect(await s.db.query('SELECT 1 FROM external_busy')).toHaveLength(0)
  expect(await s.db.query("SELECT 1 FROM audit_log WHERE action LIKE 'calendar.external_%'")).toHaveLength(0)
})

test('a failed read keeps the blocks she already has, and only the first failure is audited', async () => {
  const s = await setup()
  await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE })
  expect(await s.db.query('SELECT 1 FROM external_busy')).toHaveLength(1)

  s.setBody({ ok: false, error: 'unreachable' })
  const deps = { db: s.db, secret: SECRET, fetchText: async () => ({ ok: false, error: 'unreachable' }) as FetchResult }
  for (let i = 0; i < 3; i++) {
    await s.db.query("UPDATE external_calendars SET last_attempt_at = now() - interval '1 hour'")
    await syncDue(deps)
  }
  expect(await s.db.query('SELECT 1 FROM external_busy')).toHaveLength(1) // not opened up by a flaky connection
  const cal = (await s.db.query<{ last_status: string; last_error: string }>('SELECT last_status, last_error FROM external_calendars'))[0]!
  expect(cal).toEqual({ last_status: 'error', last_error: 'unreachable' })
  expect(await s.db.query("SELECT 1 FROM audit_log WHERE action = 'calendar.external_sync_failed'")).toHaveLength(1)
})

test('a good read replaces the old blocks with the new ones', async () => {
  const s = await setup()
  await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE })
  s.setBody({ ok: true, text: ics(personal(3).text, personal(5).text) })
  await s.db.query("UPDATE external_calendars SET last_attempt_at = now() - interval '1 hour'")
  const out = await syncDue({ db: s.db, secret: SECRET, fetchText: async () => ({ ok: true, text: ics(personal(3).text, personal(5).text) }) })
  expect(out).toEqual({ attempted: 1, ok: 1 })
  expect(await s.db.query('SELECT 1 FROM external_busy')).toHaveLength(2)
  expect((await s.db.query<{ n: number }>('SELECT block_count AS n FROM external_calendars'))[0]!.n).toBe(2)
})

test('a calendar read recently is not read again; pausing removes its blocks; resuming brings them back', async () => {
  const s = await setup()
  const added = (await (await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE })).json()) as { calendar: { id: string } }
  const id = added.calendar.id
  expect(await syncDue({ db: s.db, secret: SECRET, fetchText: async () => ({ ok: true, text: ics() }) })).toEqual({ attempted: 0, ok: 0 })
  // "sync now" right after is refused politely
  expect((await s.call(s.A, 'POST', `/api/sync/calendars/${id}/sync`)).status).toBe(429)

  expect((await s.call(s.A, 'PATCH', `/api/sync/calendars/${id}`, { enabled: false })).status).toBe(200)
  expect(await s.db.query('SELECT 1 FROM external_busy')).toHaveLength(0)
  expect((await s.call(s.A, 'POST', `/api/sync/calendars/${id}/sync`)).status).toBe(409) // paused

  await s.call(s.A, 'PATCH', `/api/sync/calendars/${id}`, { enabled: true })
  await s.db.query("UPDATE external_calendars SET last_attempt_at = now() - interval '1 hour'")
  const synced = (await (await s.call(s.A, 'POST', `/api/sync/calendars/${id}/sync`)).json()) as { ok: boolean; blocks: number }
  expect(synced).toMatchObject({ ok: true, blocks: 1 })
})

test('at most five calendars per practice; removing one deletes its blocks', async () => {
  const s = await setup()
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const r = await s.call(s.A, 'POST', '/api/sync/calendars', { label: `c${i}`, url: `${GOOGLE}?n=${i}` })
    expect(r.status).toBe(201)
    ids.push(((await r.json()) as { calendar: { id: string } }).calendar.id)
  }
  expect((await s.call(s.A, 'POST', '/api/sync/calendars', { url: `${GOOGLE}?n=6` })).status).toBe(409)
  expect((await s.call(s.A, 'DELETE', `/api/sync/calendars/${ids[0]}`)).status).toBe(200)
  expect(await s.db.query('SELECT 1 FROM external_calendars')).toHaveLength(4)
  expect((await s.call(s.A, 'DELETE', `/api/sync/calendars/${ids[0]}`)).status).toBe(404)
})

test('a practice cannot see, pause, sync or remove another practice\'s calendars or blocks', async () => {
  const s = await setup()
  const added = (await (await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE })).json()) as { calendar: { id: string } }
  const id = added.calendar.id
  expect(((await (await s.call(s.B, 'GET', '/api/sync')).json()) as { calendars: unknown[] }).calendars).toEqual([])
  expect((await s.call(s.B, 'PATCH', `/api/sync/calendars/${id}`, { enabled: false })).status).toBe(404)
  expect((await s.call(s.B, 'PATCH', `/api/sync/calendars/${id}`, { label: 'hijacked' })).status).toBe(404)
  expect((await s.call(s.B, 'POST', `/api/sync/calendars/${id}/sync`)).status).toBe(404)
  expect((await s.call(s.B, 'DELETE', `/api/sync/calendars/${id}`)).status).toBe(404)
  const from = new Date().toISOString()
  const to = new Date(Date.now() + 30 * DAY).toISOString()
  const seenByB = (await (await s.call(s.B, 'GET', `/api/sync/busy?from=${from}&to=${to}`)).json()) as { blocks: unknown[] }
  expect(seenByB.blocks).toEqual([])
  const seenByA = (await (await s.call(s.A, 'GET', `/api/sync/busy?from=${from}&to=${to}`)).json()) as { blocks: Record<string, string>[] }
  expect(seenByA.blocks).toHaveLength(1)
  expect(Object.keys(seenByA.blocks[0]!).sort()).toEqual(['end', 'start'])
  expect((await s.call(s.A, 'GET', `/api/sync/busy?from=${from}&to=${new Date(Date.now() + 90 * DAY).toISOString()}`)).status).toBe(400)
})

test('if the secret changes, the stored addresses can no longer be opened; that is reported, not crashed on', async () => {
  const s = await setup()
  await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE })
  await s.db.query("UPDATE external_calendars SET last_attempt_at = now() - interval '1 hour'")
  let called = false
  await syncDue({ db: s.db, secret: 'a-rotated-session-secret-0123456789abcdef', fetchText: async () => { called = true; return { ok: true, text: ics() } } })
  expect(called).toBe(false)
  expect((await s.db.query<{ last_error: string }>('SELECT last_error FROM external_calendars'))[0]!.last_error).toBe('secret_unreadable')
})

// --- what it does to the agenda ---------------------------------------------------------------------------------

test('time blocked in her personal calendar removes that slot from every booking calendar, and only hers', async () => {
  const s = await setup()
  await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE }) // blocks tomorrow 15:00–16:00 UTC (11:00 in Puerto Rico)
  const repo = new CalendarsRepo(s.db, s.locA)
  await s.db.query("INSERT INTO calendars (id, location_id, name, timezone, duration_min, availability, notice_min, rolling_days) VALUES ('c1',$1,'Main','America/Puerto_Rico',60,$2::jsonb,0,14)", [
    s.locA,
    JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }))),
  ])
  const cal = (await repo.get('c1'))!
  const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10)
  const slots = async (db = s.db, loc = s.locA) =>
    slotsForDate(toConfig(cal), tomorrow, await calendarBusyFor(db, loc, cal, tomorrow), new Date(Date.now() - 30 * DAY)).map((x) => x.start)
  const blockedStart = new Date(Date.UTC(+tomorrow.slice(0, 4), +tomorrow.slice(5, 7) - 1, +tomorrow.slice(8, 10), 15)).toISOString()
  expect(await slots()).not.toContain(blockedStart)
  // without the personal calendar, the slot is open again
  await s.db.query('DELETE FROM external_busy')
  expect(await slots()).toContain(blockedStart)
  // and another practice's personal calendar never affects this one
  await s.call(s.B, 'POST', '/api/sync/calendars', { url: `${GOOGLE}?b` })
  expect(await slots()).toContain(blockedStart)
})

test('booking on top of her personal calendar is allowed but comes with a warning; elsewhere there is none', async () => {
  const s = await setup()
  await s.call(s.A, 'POST', '/api/sync/calendars', { url: GOOGLE })
  const block = (await s.db.query<{ starts_at: string; ends_at: string }>('SELECT starts_at, ends_at FROM external_busy'))[0]!
  await s.db.query("INSERT INTO calendars (id, location_id, name) VALUES ('c1',$1,'Main')", [s.locA])
  const overlap = await s.call(s.A, 'POST', '/api/cal/appointments', { calendarId: 'c1', title: 'Session', startsAt: new Date(block.starts_at).toISOString(), endsAt: new Date(new Date(block.starts_at).getTime() + 3000_000).toISOString() })
  expect(overlap.status).toBe(201)
  expect(((await overlap.json()) as { warnings: string[] }).warnings).toEqual(['overlaps_personal_calendar'])
  const free = await s.call(s.A, 'POST', '/api/cal/appointments', { calendarId: 'c1', title: 'Session', startsAt: new Date(new Date(block.starts_at).getTime() + 5 * 3600_000).toISOString(), endsAt: new Date(new Date(block.starts_at).getTime() + 6 * 3600_000).toISOString() })
  expect(((await free.json()) as { warnings: string[] }).warnings).toEqual([])
  // moving one onto the block warns too
  const id = ((await (await s.call(s.A, 'GET', '/api/cal/appointments?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z')).json()) as { appointments: { id: string; starts_at: string }[] }).appointments.find((a) => new Date(a.starts_at) > new Date(new Date(block.starts_at).getTime() + 4 * 3600_000))!.id
  const moved = await s.call(s.A, 'PATCH', `/api/cal/appointments/${id}`, { startsAt: new Date(new Date(block.starts_at).getTime() + 600_000).toISOString(), endsAt: new Date(new Date(block.starts_at).getTime() + 1200_000).toISOString() })
  expect(((await moved.json()) as { warnings: string[] }).warnings).toEqual(['overlaps_personal_calendar'])
})

test('without calendar sync turned on there is no warning and no extra lookup', async () => {
  const s = await setup()
  await s.db.query("INSERT INTO calendars (id, location_id, name) VALUES ('c1',$1,'Main')", [s.locA])
  const off = new Hono<AppEnv>()
  off.use('*', async (c, next) => { c.set('operatorId', 'op1'); c.set('locationId', s.locA); await next() })
  off.route('/cal', calendarsRoute({ db: s.db, externalBusy: false }))
  const r = await off.request('/cal/appointments', { method: 'POST', body: JSON.stringify({ calendarId: 'c1', title: 'S', startsAt: new Date(Date.now() + DAY).toISOString(), endsAt: new Date(Date.now() + DAY + 3000_000).toISOString() }), headers: { 'Content-Type': 'application/json' } })
  expect(((await r.json()) as { warnings: string[] }).warnings).toEqual([])
})

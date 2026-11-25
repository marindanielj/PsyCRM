import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { fakeVideoProvider } from '../lib/video/provider'
import { addLocation, freshDb } from '../test-utils/pglite'
import { publicVideoRoute } from './public-video'
import { videoRoute } from './video'

const START = new Date('2026-06-04T15:00:00Z')
const SECRET = 'test-secret'

async function setup(opts: { modality?: string; status?: string } = {}) {
  const { db } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  await addLocation(db, 'loc_b')
  await db.query("INSERT INTO calendars (id, location_id, name) VALUES ('cal1',$1,'Sesiones')", [loc])
  await db.query("INSERT INTO contacts (id, location_id, name, emails) VALUES ('c1',$1,'Ana Rivera','{}')", [loc])
  await db.query(
    `INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at, modality, status)
     VALUES ('a1',$1,'cal1','c1','Sesión','2026-06-04T15:00:00Z','2026-06-04T15:50:00Z',$2,$3)`,
    [loc, opts.modality ?? 'telehealth_video', opts.status ?? 'scheduled'],
  )
  const provider = fakeVideoProvider()
  let now = START
  const clock = () => now
  const therapist = new Hono<AppEnv>()
  therapist.use('*', async (c, next) => { c.set('operatorId', 'op1'); c.set('locationId', 'loc_a'); await next() })
  therapist.route('/', videoRoute({ db, secret: SECRET, provider, publicBaseUrl: 'https://crm.test', now: clock }))
  const visitor = new Hono<AppEnv>()
  visitor.route('/v', publicVideoRoute({ db, provider, now: clock }))

  const t = (method: string, path: string) => therapist.request(path, { method })
  const v = (method: string, path: string, body?: unknown) =>
    visitor.request(`/v${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const tokenOf = async () => ((await (await t('GET', '/appointments/a1/video')).json()).video.link as string).split('/v/')[1]!
  return { db, provider, t, v, tokenOf, setNow: (d: Date) => { now = d } }
}

const CONFIRM = { location: 'Ponce', inPuertoRico: true, privatePlace: true }

test('the whole session: client waits, therapist admits, both get credentials, and the log holds times only', async () => {
  const s = await setup()
  const token = await s.tokenOf()

  const page = await s.v('GET', `/${token}`)
  const html = await page.text()
  expect(page.status).toBe(200)
  expect(html).toContain('Antes de entrar')
  expect(page.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-[^']+' blob:/)
  expect(page.headers.get('cache-control')).toBe('no-store')
  expect(html).not.toContain('Ana') // nothing about the client is on the page

  // she cannot get in before anyone let her
  expect((await s.v('POST', `/${token}/join`)).status).toBe(409)
  expect((await s.v('POST', `/${token}/wait`, CONFIRM)).status).toBe(200)

  const waiting = (await (await s.t('GET', '/appointments/a1/video')).json()).video
  expect(waiting).toMatchObject({ waiting: true, admitted: false, clientConfirmation: { location: 'Ponce', inPuertoRico: true, privatePlace: true } })

  // admitted but the therapist has not opened the room yet: still no credentials
  expect((await s.t('POST', '/appointments/a1/video/join')).status).toBe(200)
  expect((await (await s.v('GET', `/${token}/status`)).json())).toMatchObject({ admitted: false })
  expect((await s.t('POST', '/appointments/a1/video/admit')).status).toBe(200)
  expect((await (await s.v('GET', `/${token}/status`)).json())).toMatchObject({ state: 'open', admitted: true, ended: false })

  const join = await s.v('POST', `/${token}/join`)
  expect(join.status).toBe(200)
  expect((await join.json()).attendee.JoinToken).toBeTruthy()
  expect(s.provider.attendees.map((a) => a.externalUserId)).toEqual(['therapist', 'client'])
  expect(s.provider.meetings).toHaveLength(1)

  await s.v('POST', `/${token}/left`)
  const events = await s.db.query<{ role: string; event: string }>('SELECT role, event FROM video_meeting_events ORDER BY at, id')
  expect(events.map((e) => `${e.role}:${e.event}`).sort()).toEqual(['client:joined', 'client:left', 'client:waiting', 'therapist:admitted', 'therapist:joined'].sort())
})

test('an unknown or malformed link gets the same page, and never reveals a room', async () => {
  const s = await setup()
  const a = await s.v('GET', `/${'A'.repeat(43)}`)
  const b = await s.v('GET', '/short')
  expect(a.status).toBe(404)
  expect((await a.text()).replace(/nonce="[^"]+"/g, '')).toBe((await b.text()).replace(/nonce="[^"]+"/g, ''))
  expect((await s.v('POST', `/${'A'.repeat(43)}/wait`, CONFIRM)).status).toBe(404)
})

test('the link opens 15 minutes before the start and closes 60 minutes after the scheduled end', async () => {
  const s = await setup()
  const token = await s.tokenOf()

  s.setNow(new Date('2026-06-04T14:30:00Z'))
  const early = await s.v('GET', `/${token}`)
  expect(await early.text()).toContain('aún no está abierta')
  expect((await s.v('POST', `/${token}/wait`, CONFIRM)).status).toBe(409)

  s.setNow(new Date('2026-06-04T14:45:00Z'))
  expect((await (await s.v('GET', `/${token}`)).text())).toContain('Antes de entrar')

  s.setNow(new Date('2026-06-04T16:50:00Z'))
  expect(await (await s.v('GET', `/${token}`)).text()).toContain('ya terminó')
  expect((await s.v('POST', `/${token}/wait`, CONFIRM)).status).toBe(409)
})

test('a cancelled appointment closes the room, and an in-person one never had one', async () => {
  const s = await setup()
  const token = await s.tokenOf()
  await s.db.query("UPDATE appointments SET status='cancelled' WHERE id='a1'")
  expect(await (await s.v('GET', `/${token}`)).text()).toContain('no está activa')
  expect((await s.v('POST', `/${token}/wait`, CONFIRM)).status).toBe(409)

  const inPerson = await setup({ modality: 'in_person' })
  expect((await inPerson.t('GET', '/appointments/a1/video')).status).toBe(409)
})

test('once the therapist ends the session the client cannot rejoin', async () => {
  const s = await setup()
  const token = await s.tokenOf()
  await s.v('POST', `/${token}/wait`, CONFIRM)
  await s.t('POST', '/appointments/a1/video/join')
  await s.t('POST', '/appointments/a1/video/admit')
  expect((await s.t('POST', '/appointments/a1/video/end')).status).toBe(200)
  expect(s.provider.ended).toEqual(['chime_' + (await s.db.query<{ id: string }>('SELECT id FROM video_meetings'))[0]!.id])
  expect((await s.v('POST', `/${token}/join`)).status).toBe(409)
  expect(await (await s.v('GET', `/${token}`)).text()).toContain('ya terminó')
})

test('the client must say where she is, and a location that is too short is refused', async () => {
  const s = await setup()
  const token = await s.tokenOf()
  expect((await s.v('POST', `/${token}/wait`, { ...CONFIRM, location: '' })).status).toBe(400)
  expect((await s.v('POST', `/${token}/wait`, { location: 'Ponce' })).status).toBe(400)
})

test('another practice\'s operator cannot open this appointment\'s room', async () => {
  const s = await setup()
  const other = new Hono<AppEnv>()
  other.use('*', async (c, next) => { c.set('operatorId', 'op2'); c.set('locationId', 'loc_b'); await next() })
  other.route('/', videoRoute({ db: s.db, secret: SECRET, provider: s.provider, now: () => START }))
  expect((await other.request('/appointments/a1/video')).status).toBe(404)
  expect((await other.request('/appointments/a1/video/join', { method: 'POST' })).status).toBe(404)
})

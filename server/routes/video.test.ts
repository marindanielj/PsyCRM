import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { fakeVideoProvider } from '../lib/video/provider'
import { videoRoute } from './video'

const NOW = new Date('2026-06-04T15:00:00Z')
const appt = (over: Record<string, unknown> = {}) => ({
  id: 'a1', location_id: 'locA', contact_id: 'ct1', modality: 'telehealth_video', status: 'scheduled',
  starts_at: '2026-06-04T15:00:00Z', ends_at: '2026-06-04T15:50:00Z', ...over,
})
const room = (over: Record<string, unknown> = {}) => ({
  id: 'vm1', location_id: 'locA', appointment_id: 'a1', chime_meeting: null, waiting_since: null, admitted_at: null, ended_at: null, ...over,
})

function setup(now = NOW) {
  const db = new FakeDatabase()
  const provider = fakeVideoProvider()
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => { c.set('operatorId', 'op1'); c.set('locationId', 'locA'); await next() })
  app.route('/', videoRoute({ db, secret: 'sekret', provider, publicBaseUrl: 'https://crm.test', now: () => now }))
  return { db, provider, app }
}
const post = (app: Hono<AppEnv>, path: string) => app.request(path, { method: 'POST' })

test('GET gives the client link and the window; the link is on /v/ and never shows the stored hash', async () => {
  const { db, app } = setup()
  db.enqueue([appt()])
  db.enqueue([room()])
  const body = await (await app.request('/appointments/a1/video')).json()
  expect(body.video.link).toMatch(/^https:\/\/crm\.test\/v\/[A-Za-z0-9_-]{43}$/)
  expect(body.video).toMatchObject({ waiting: false, admitted: false, ended: false, window: { state: 'open' } })
})

test('an appointment held in person has no video room (409), and an unknown one is 404', async () => {
  const a = setup()
  a.db.enqueue([appt({ modality: 'in_person' })])
  expect((await a.app.request('/appointments/a1/video')).status).toBe(409)
  const b = setup()
  b.db.enqueue([])
  expect((await b.app.request('/appointments/zzz/video')).status).toBe(404)
})

test('a cancelled appointment has no room', async () => {
  const { db, app } = setup()
  db.enqueue([appt({ status: 'cancelled' })])
  expect((await post(app, '/appointments/a1/video/join')).status).toBe(409)
})

test('join is refused before the window opens and after it closes', async () => {
  const early = setup(new Date('2026-06-04T14:00:00Z'))
  early.db.enqueue([appt()])
  const e = await post(early.app, '/appointments/a1/video/join')
  expect(e.status).toBe(409)
  expect((await e.json()).error).toBe('not open yet')

  const late = setup(new Date('2026-06-04T16:50:00Z'))
  late.db.enqueue([appt()])
  expect((await post(late.app, '/appointments/a1/video/join')).status).toBe(409)
  expect(late.provider.meetings).toEqual([])
})

test('join opens the Chime room once, hands the therapist credentials, and logs it without content', async () => {
  const { db, provider, app } = setup()
  db.enqueue([appt()])
  db.enqueue([room()]) // ensure -> insert returning
  db.enqueue([]) // setChimeMeeting
  db.enqueue([]) // addEvent
  db.enqueue([room({ chime_meeting: { MeetingId: 'chime_vm1' } })])
  const res = await post(app, '/appointments/a1/video/join')
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(provider.meetings).toEqual(['vm1'])
  expect(provider.attendees).toEqual([{ meetingId: 'chime_vm1', externalUserId: 'therapist' }])
  expect(body.attendee.JoinToken).toBeTruthy()
  expect(db.auditEntries().map((a) => a.action)).toEqual(['appointment.video_started'])
  expect(db.auditEntries()[0]?.details).toEqual({})
})

test('join into a room that already exists does not create a second one', async () => {
  const { db, provider, app } = setup()
  db.enqueue([appt()])
  db.enqueue([room({ chime_meeting: { MeetingId: 'chime_vm1' } })])
  db.enqueue([]) // addEvent
  db.enqueue([room({ chime_meeting: { MeetingId: 'chime_vm1' } })])
  await post(app, '/appointments/a1/video/join')
  expect(provider.meetings).toEqual([])
  expect(provider.attendees).toHaveLength(1)
})

test('admit lets a waiting client in and is audited; with nobody waiting it is a 409', async () => {
  const ok = setup()
  ok.db.enqueue([appt()])
  ok.db.enqueue([room({ waiting_since: '2026-06-04T14:58:00Z', chime_meeting: { MeetingId: 'chime_vm1' } })]) // the room is already open
  ok.db.enqueue([{ id: 'vm1' }]) // admit RETURNING
  ok.db.enqueue([]) // event
  expect((await post(ok.app, '/appointments/a1/video/admit')).status).toBe(200)
  expect(ok.db.auditEntries().map((a) => a.action)).toEqual(['appointment.video_admitted'])

  const none = setup()
  none.db.enqueue([appt()])
  none.db.enqueue([room()])
  none.db.enqueue([]) // admit matched nothing
  expect((await post(none.app, '/appointments/a1/video/admit')).status).toBe(409)
  expect(none.db.auditEntries()).toEqual([])
})

test('end closes the Chime room for everyone and is audited', async () => {
  const { db, provider, app } = setup()
  db.enqueue([appt()])
  db.enqueue([room({ chime_meeting: { MeetingId: 'chime_vm1' } })])
  expect((await post(app, '/appointments/a1/video/end')).status).toBe(200)
  expect(provider.ended).toEqual(['chime_vm1'])
  expect(db.auditEntries().map((a) => a.action)).toEqual(['appointment.video_ended'])
})

import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { fakeVideoProvider, type VideoProvider } from '../lib/video/provider'
import { addLocation, freshDb } from '../test-utils/pglite'
import { publicVideoRoute } from './public-video'
import { videoRoute } from './video'

const START = new Date('2026-06-04T15:00:00Z')
const SECRET = 'test-secret'

async function setup(opts: { modality?: string; status?: string; provider?: VideoProvider } = {}) {
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
  const provider = (opts.provider ?? fakeVideoProvider()) as ReturnType<typeof fakeVideoProvider>
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

test('the therapist\'s room page: signed in, one appointment, its own call-ready CSP', async () => {
  const s = await setup()
  const res = await s.t('GET', '/appointments/a1/room')
  const html = await res.text()
  expect(res.status).toBe(200)
  expect(html).toContain('/api/loc/loc_a/video/appointments/a1')
  expect(html).toContain('Admit to the session')
  expect(res.headers.get('content-security-policy')).toMatch(/connect-src 'self' https:\/\/\*\.chime\.aws wss:\/\/\*\.chime\.aws/)
  expect(res.headers.get('cache-control')).toBe('no-store')

  const inPerson = await setup({ modality: 'in_person' })
  expect((await inPerson.t('GET', '/appointments/a1/room')).status).toBe(409)
  expect((await s.t('GET', '/appointments/nope/room')).status).toBe(404)
})

test('in the assembled app the room keeps its own CSP, needs a sign-in, and the video routes exist only when video is on', async () => {
  const { createApp } = await import('../index')
  const { createSession } = await import('../lib/session')
  const secret = 's'.repeat(32)
  const { db } = await freshDb()
  await addLocation(db, 'loc_a')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra','h')")
  await db.query("INSERT INTO operator_locations (operator_id, location_id) VALUES ('op1','loc_a')")
  await db.query("INSERT INTO calendars (id, location_id, name) VALUES ('cal1','loc_a','S')")
  await db.query("INSERT INTO appointments (id, location_id, calendar_id, title, starts_at, ends_at, modality) VALUES ('a1','loc_a','cal1','S',now(),now() + interval '50 minutes','telehealth_video')")
  const cookie = `ol_session=${createSession({ operatorId: 'op1' }, secret)}`
  const on = createApp({ db, sessionSecret: secret, webhookSecret: 'w', video: fakeVideoProvider(), revokedBefore: async () => null })
  const off = createApp({ db, sessionSecret: secret, webhookSecret: 'w', revokedBefore: async () => null })
  const path = '/api/loc/loc_a/video/appointments/a1/room'

  const room = await on.request(path, { headers: { cookie } })
  expect(room.status).toBe(200)
  expect(room.headers.get('content-security-policy')).toContain('wss://*.chime.aws')
  expect(room.headers.get('x-frame-options')).toBe('DENY')

  expect((await on.request(path)).status).toBe(401) // no sign-in, no room
  expect(await (await on.request('/api/loc/loc_a/features', { headers: { cookie } })).json()).toEqual({ video: true })
  expect(await (await off.request('/api/loc/loc_a/features', { headers: { cookie } })).json()).toEqual({ video: false })
  expect((await on.request('/api/loc/loc_a/features')).status).toBe(401) // behind the sign-in too
  expect((await off.request('/api/loc/loc_a/video/appointments/a1/video', { headers: { cookie } })).status).toBe(404) // no video routes when off
  expect((await off.request(`/v/${'A'.repeat(43)}`)).status).not.toBe(200) // no public page either
  // every other app page still gets the strict policy
  expect((await on.request('/api/loc/loc_a/calendars', { headers: { cookie } })).headers.get('content-security-policy')).toContain("script-src 'self'")
})

/** A signed telepsychology consent for contact c1 (foreign keys off for the insert: only the family and contact matter here). */
async function signConsent(db: Awaited<ReturnType<typeof setup>>['db'], family = 'seed_telepsychology') {
  await db.query('SET session_replication_role = replica')
  await db.query(
    `INSERT INTO document_templates (id, location_id, family_id, translation_group_id, version, status, kind, title, body_md)
     VALUES ('t1','loc_a',$1,$1,1,'active','agreement','Consentimiento','x')`,
    [family],
  )
  await db.query(
    `INSERT INTO signed_documents (id, location_id, contact_id, request_id, signer_id, signer_role, template_id, template_title, template_version, locale, field_values, rendered_html, content_sha256, signer_name, esign_consent, signer_ip, signer_user_agent, verified_via)
     VALUES ('sd1','loc_a','c1','r1','s1','client','t1','Consentimiento',1,'es','{}','x','h','Ana',true,'1.1.1.1','ua','email_otp')`,
  )
  await db.query('SET session_replication_role = DEFAULT')
}

test('the room is told when the client has no signed telepsychology consent, and stops saying so once it is signed', async () => {
  const s = await setup()
  const before = (await (await s.t('GET', '/appointments/a1/video')).json()).video
  expect(before.consentSigned).toBe(false)
  await signConsent(s.db)
  expect((await (await s.t('GET', '/appointments/a1/video')).json()).video.consentSigned).toBe(true)
})

test('a different signed document is not a telepsychology consent', async () => {
  const s = await setup()
  await signConsent(s.db, 'seed_privacy')
  expect((await (await s.t('GET', '/appointments/a1/video')).json()).video.consentSigned).toBe(false)
})

test('booking a video appointment warns, never blocks, when the consent is missing; in person and no-client bookings do not', async () => {
  const { db } = await freshDb()
  await addLocation(db, 'loc_a')
  await db.query("INSERT INTO calendars (id, location_id, name) VALUES ('cal1','loc_a','S')")
  await db.query("INSERT INTO contacts (id, location_id, name, emails) VALUES ('c1','loc_a','Ana','{}')")
  const { calendarsRoute } = await import('./calendars')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => { c.set('operatorId', 'op1'); c.set('locationId', 'loc_a'); await next() })
  app.route('/', calendarsRoute({ db }))
  const book = async (hour: number, extra: Record<string, unknown>) =>
    (await app.request('/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calendarId: 'cal1', title: 'S', startsAt: `2026-06-04T${hour}:00:00Z`, endsAt: `2026-06-04T${hour}:50:00Z`, ...extra }) })).json()

  expect(await book(10, { contactId: 'c1', modality: 'telehealth_video' })).toMatchObject({ ok: true, warnings: ['telepsychology_consent_missing'] })
  expect((await book(11, { contactId: 'c1', modality: 'in_person' })).warnings).toEqual([])
  expect((await book(12, { modality: 'telehealth_video' })).warnings).toEqual([])
  await signConsent(db as never)
  expect((await book(13, { contactId: 'c1', modality: 'telehealth_video' })).warnings).toEqual([])
})


test('admitting a waiting client opens the room, so they can enter straight away without the therapist pressing Open first', async () => {
  const s = await setup()
  const token = await s.tokenOf()
  await s.v('POST', `/${token}/wait`, CONFIRM)
  expect((await s.t('POST', '/appointments/a1/video/admit')).status).toBe(200) // no join before it
  expect(s.provider.meetings).toHaveLength(1)
  const join = await s.v('POST', `/${token}/join`)
  expect(join.status).toBe(200)
  expect((await join.json()).attendee.JoinToken).toBeTruthy()
  const a = (await s.db.query<{ action: string }>("SELECT action FROM audit_log WHERE entity_id='a1' ORDER BY id")).map((x) => x.action)
  expect(a).toEqual(['appointment.video_started', 'appointment.video_admitted'])
})

const refusing = (over: Partial<VideoProvider>): VideoProvider => ({
  ...fakeVideoProvider(),
  ...over,
})
const denied = () => Object.assign(new Error('User: arn:aws:sts::450549238631:assumed-role/psycrm-task/abc is not authorized (Ana Rivera)'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } })

test('when Chime refuses to open the room nobody is admitted, the therapist gets a clear 502, and the log names the call and the error but nothing else', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const s = await setup({ provider: refusing({ createMeeting: async () => { throw denied() } }) })
    const token = await s.tokenOf()
    await s.v('POST', `/${token}/wait`, CONFIRM)

    const admit = await s.t('POST', '/appointments/a1/video/admit')
    expect(admit.status).toBe(502)
    expect(await admit.json()).toEqual({ error: 'video_unavailable' })
    expect((await s.db.query<{ admitted_at: string | null }>('SELECT admitted_at FROM video_meetings'))[0]!.admitted_at).toBeNull()
    expect((await s.t('POST', '/appointments/a1/video/join')).status).toBe(502)
    expect((await s.v('POST', `/${token}/join`)).status).toBe(409) // not admitted, no room: still a clean answer

    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).toContain('video provider failed')
    expect(logged).toContain('createMeeting')
    expect(logged).toContain('AccessDeniedException')
    expect(logged).not.toMatch(/Ana Rivera|450549238631|assumed-role|a1|vm/) // no message text, account, role or ids
  } finally {
    spy.mockRestore()
  }
})

test('when Chime refuses an attendee the client and the therapist get a 502 they can be told about, not a 500', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const s = await setup({ provider: refusing({ createAttendee: async () => { throw denied() } }) })
    const token = await s.tokenOf()
    await s.v('POST', `/${token}/wait`, CONFIRM)
    expect((await s.t('POST', '/appointments/a1/video/admit')).status).toBe(200)
    const client = await s.v('POST', `/${token}/join`)
    expect(client.status).toBe(502)
    expect(await client.json()).toEqual({ error: 'video_unavailable' })
    expect((await s.t('POST', '/appointments/a1/video/join')).status).toBe(502)
    expect(JSON.stringify(spy.mock.calls)).toContain('createAttendee')
  } finally {
    spy.mockRestore()
  }
})

test('the inline scripts of both pages are valid JavaScript (a typo there fails silently in the browser)', async () => {
  const s = await setup()
  const token = await s.tokenOf()
  const scripts = (html: string) => [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  for (const html of [await (await s.v('GET', `/${token}`)).text(), await (await s.t('GET', '/appointments/a1/room')).text()]) {
    const found = scripts(html)
    expect(found.length).toBeGreaterThan(0)
    for (const code of found) expect(() => new Function(code)).not.toThrow()
  }
})

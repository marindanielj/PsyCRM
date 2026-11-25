import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { audit, auditContext } from '../lib/audit'
import { videoWindow } from '../lib/video-window'
import { videoToken } from '../lib/video-token'
import type { VideoProvider } from '../lib/video/provider'
import { AppointmentsRepo } from '../repos/appointments-repo'
import { VideoMeetingsRepo } from '../repos/video-meetings-repo'

/**
 * The therapist's side of a video session, mounted behind operatorAuth + locationAccess.
 *
 *   GET  /appointments/:id/video         -> link, waiting/admitted state, window
 *   POST /appointments/:id/video/join    -> open the room (if needed) and get credentials to enter it
 *   POST /appointments/:id/video/admit   -> let the waiting client in
 *   POST /appointments/:id/video/end     -> close the room for everyone
 *
 * Only appointments held by video, and not cancelled, have a room. No recording, no content: the
 * log keeps who joined or left and when.
 */
export function videoRoute(deps: { db: Database; secret: string; provider: VideoProvider; publicBaseUrl?: string; now?: () => Date }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const clock = () => deps.now?.() ?? new Date()
  const linkFor = (meetingId: string) => `${deps.publicBaseUrl ?? ''}/v/${videoToken(meetingId, deps.secret)}`

  async function load(loc: string, id: string) {
    const appt = await new AppointmentsRepo(deps.db, loc).get(id)
    if (!appt) return { error: 'not found' as const, status: 404 as const }
    if (appt.modality !== 'telehealth_video') return { error: 'not a video appointment' as const, status: 409 as const }
    if (appt.status === 'cancelled' || appt.status === 'no_show') return { error: 'appointment is not active' as const, status: 409 as const }
    return { appt }
  }

  const shape = (m: { id: string; waiting_since: string | null; admitted_at: string | null; ended_at: string | null; client_location?: string | null; client_in_pr?: boolean | null; client_private?: boolean | null }, appt: { starts_at: string; ends_at: string }) => {
    const w = videoWindow(appt.starts_at, appt.ends_at, clock())
    return {
      link: linkFor(m.id),
      waiting: Boolean(m.waiting_since) && !m.admitted_at && !m.ended_at,
      admitted: Boolean(m.admitted_at),
      ended: Boolean(m.ended_at),
      // What the client said when she came in: where she is, in Puerto Rico, somewhere private.
      clientConfirmation: m.waiting_since ? { location: m.client_location ?? null, inPuertoRico: m.client_in_pr ?? null, privatePlace: m.client_private ?? null } : null,
      window: { state: w.state, opensAt: w.opensAt.toISOString(), closesAt: w.closesAt.toISOString() },
    }
  }

  app.get('/appointments/:id/video', async (c) => {
    const loc = c.get('locationId')
    const r = await load(loc, c.req.param('id'))
    if ('error' in r) return c.json({ error: r.error }, r.status)
    const meeting = await new VideoMeetingsRepo(deps.db, loc).ensure(r.appt.id, deps.secret)
    return c.json({ ok: true, video: shape(meeting, r.appt) })
  })

  app.post('/appointments/:id/video/join', async (c) => {
    const loc = c.get('locationId')
    const r = await load(loc, c.req.param('id'))
    if ('error' in r) return c.json({ error: r.error }, r.status)
    const w = videoWindow(r.appt.starts_at, r.appt.ends_at, clock())
    if (w.state !== 'open') return c.json({ error: w.state === 'not_yet' ? 'not open yet' : 'session window has ended' }, 409)

    const repo = new VideoMeetingsRepo(deps.db, loc)
    let meeting = await repo.ensure(r.appt.id, deps.secret)
    if (meeting.ended_at) return c.json({ error: 'session has ended' }, 409)
    let chime = meeting.chime_meeting
    if (!chime) {
      // The request token is our meeting id, so a second caller racing this one gets the same room back.
      chime = (await deps.provider.createMeeting(meeting.id)) as unknown as Record<string, unknown>
      await deps.db.transaction(async (tx) => {
        await new VideoMeetingsRepo(tx, loc).setChimeMeeting(meeting.id, chime!)
        await audit(tx, loc, { action: 'appointment.video_started', entityType: 'appointment', entityId: r.appt.id, contactId: r.appt.contact_id ?? null, details: {}, ...auditContext(c) })
      })
    }
    const attendee = await deps.provider.createAttendee(String((chime as { MeetingId?: string }).MeetingId), 'therapist')
    await repo.addEvent(meeting.id, 'therapist', 'joined')
    meeting = (await repo.getByAppointment(r.appt.id)) ?? meeting
    return c.json({ ok: true, meeting: chime, attendee, video: shape(meeting, r.appt) })
  })

  app.post('/appointments/:id/video/admit', async (c) => {
    const loc = c.get('locationId')
    const r = await load(loc, c.req.param('id'))
    if ('error' in r) return c.json({ error: r.error }, r.status)
    const repo = new VideoMeetingsRepo(deps.db, loc)
    const meeting = await repo.getByAppointment(r.appt.id)
    if (!meeting) return c.json({ error: 'nobody is waiting' }, 409)
    const ok = await deps.db.transaction(async (tx) => {
      const txRepo = new VideoMeetingsRepo(tx, loc)
      if (!(await txRepo.admit(meeting.id))) return false
      await txRepo.addEvent(meeting.id, 'therapist', 'admitted')
      await audit(tx, loc, { action: 'appointment.video_admitted', entityType: 'appointment', entityId: r.appt.id, contactId: r.appt.contact_id ?? null, details: {}, ...auditContext(c) })
      return true
    })
    if (!ok) return c.json({ error: 'nobody is waiting' }, 409)
    return c.json({ ok: true })
  })

  app.post('/appointments/:id/video/end', async (c) => {
    const loc = c.get('locationId')
    const r = await load(loc, c.req.param('id'))
    if ('error' in r) return c.json({ error: r.error }, r.status)
    const repo = new VideoMeetingsRepo(deps.db, loc)
    const meeting = await repo.getByAppointment(r.appt.id)
    if (!meeting) return c.json({ error: 'no video room' }, 404)
    const chimeId = (meeting.chime_meeting as { MeetingId?: string } | null)?.MeetingId
    if (chimeId) await deps.provider.endMeeting(chimeId)
    await deps.db.transaction(async (tx) => {
      await new VideoMeetingsRepo(tx, loc).end(meeting.id)
      await audit(tx, loc, { action: 'appointment.video_ended', entityType: 'appointment', entityId: r.appt.id, contactId: r.appt.contact_id ?? null, details: {}, ...auditContext(c) })
    })
    return c.json({ ok: true })
  })

  return app
}

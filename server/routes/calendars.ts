import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import { isForeignKeyViolation, isUniqueViolation } from '../lib/db-errors'
import { AppointmentsRepo } from '../repos/appointments-repo'
import { CalendarsRepo } from '../repos/calendars-repo'
import { ContactsRepo } from '../repos/contacts-repo'
import { VideoMeetingsRepo } from '../repos/video-meetings-repo'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { audit, auditContext } from '../lib/audit'
import { MODALITIES } from '../lib/clinical-vocab'
import { hasTelepsychologyConsent } from '../lib/telepsychology-consent'
import { CalendarSyncRepo } from '../repos/calendar-sync-repo'
import { TimelineRepo } from '../repos/timeline-repo'

const APPOINTMENT_STATUS = ['scheduled', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'] as const

// starts_at/ends_at are timestamptz NOT NULL columns. Validating them as real
// ISO datetimes (not just any non-empty string) keeps a typo like "soon" from
// reaching the DB as a 500, and the refine rejects a backwards appointment
// (end at or before start) that the plain unique double-book index wouldn't catch.
const createApptSchema = z
  .object({
    calendarId: z.string().min(1),
    title: z.string().min(1),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    contactId: z.string().nullable().optional(),
    locationText: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    // Omitted: the calendar's default applies.
    modality: z.enum(MODALITIES).optional(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })

const patchApptSchema = z
  .object({
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    status: z.enum(APPOINTMENT_STATUS).optional(),
    // Details. Any subset; a reschedule and a status change may ride along in the same call.
    title: z.string().trim().min(1).max(200).optional(),
    contactId: z.string().min(1).nullable().optional(),
    locationText: z.string().max(300).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    modality: z.enum(MODALITIES).optional(),
  })
  // Only enforce ordering when a reschedule supplies both ends; a status-only
  // patch leaves both undefined and passes untouched.
  .refine(
    (v) => v.startsAt === undefined || v.endsAt === undefined || new Date(v.endsAt) > new Date(v.startsAt),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
  )

const createCalSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1).optional(),
  durationMin: z.number().int().positive().optional(),
  position: z.number().int().optional(),
})

// A weekly open window in the calendar's timezone (weekday 0=Sun, 'HH:MM' wall
// clock). Matches AvailabilityWindow in lib/availability.
const availabilityWindowSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  start: z.string().regex(/^\d{1,2}:\d{2}$/),
  end: z.string().regex(/^\d{1,2}:\d{2}$/),
})

// Booking slugs live in a public URL, so keep them lowercase + URL-safe; the UI
// slugifies before sending. A null clears the slug (and so the public page).
const bookingSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, numbers, or dashes')

const patchCalSchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
  durationMin: z.number().int().positive().optional(),
  position: z.number().int().optional(),
  bookingEnabled: z.boolean().optional(),
  bookingSlug: bookingSlugSchema.nullable().optional(),
  timezone: z.string().min(1).optional(),
  slotIntervalMin: z.number().int().min(0).optional(),
  bufferMin: z.number().int().min(0).optional(),
  noticeMin: z.number().int().min(0).optional(),
  rollingDays: z.number().int().min(1).max(60).optional(),
  availability: z.array(availabilityWindowSchema).optional(),
  bookingHeadline: z.string().nullable().optional(),
  bookingBlurb: z.string().nullable().optional(),
  defaultModality: z.enum(MODALITIES).optional(),
})

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Calendars + appointments for the current location. Mounted behind
 * operatorAuth + locationAccess. The agenda UI reads GET / (calendars) and
 * GET /appointments?from&to (defaults: now .. +30d); POST /appointments books;
 * PATCH /appointments/:id reschedules ({startsAt,endsAt}) or sets {status}.
 */
export function calendarsRoute(deps: {
  db: Database
  /** Fired after a check-in so live workflows can react (day 7). */
  dispatch?: WorkflowDispatch
  /** Calendar sync is on: warn when something is scheduled over time blocked in her personal calendar. */
  externalBusy?: boolean
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** Advice, never a refusal: she may knowingly book over her own personal calendar. */
  const warningsFor = async (loc: string, startsAt: string, endsAt: string): Promise<string[]> =>
    deps.externalBusy && (await new CalendarSyncRepo(deps.db, loc).overlaps(new Date(startsAt), new Date(endsAt)))
      ? ['overlaps_personal_calendar']
      : []

  app.get('/', async (c) => {
    const loc = c.get('locationId')
    const calendars = await new CalendarsRepo(deps.db, loc).list()
    return c.json({ calendars })
  })

  app.post('/', zValidator('json', createCalSchema), async (c) => {
    const loc = c.get('locationId')
    const calendar = await new CalendarsRepo(deps.db, loc).create(c.req.valid('json'))
    return c.json({ ok: true, calendar }, 201)
  })

  // Patch a calendar — its name/color/duration AND its public-booking config
  // (enable, slug, timezone, weekly availability, interval/buffer/notice/window,
  // headline/blurb). A booking slug must be unique within the location.
  app.patch('/:id', zValidator('json', patchCalSchema), async (c) => {
    const loc = c.get('locationId')
    const id = c.req.param('id')
    const patch = c.req.valid('json')
    if (Object.keys(patch).length === 0) return c.json({ error: 'empty patch' }, 400)

    const repo = new CalendarsRepo(deps.db, loc)
    // Slug-uniqueness guard: a non-null slug must be free, or already this one's.
    if (typeof patch.bookingSlug === 'string') {
      const owner = await repo.getByBookingSlug(patch.bookingSlug)
      if (owner && owner.id !== id) return c.json({ error: 'slug taken' }, 409)
    }
    const calendar = await repo.update(id, patch)
    if (!calendar) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true, calendar })
  })

  app.get('/appointments', async (c) => {
    const loc = c.get('locationId')
    const now = new Date()
    // From the start of today (not this moment): an appointment earlier today must not vanish when the page reloads.
    const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const from = c.req.query('from') ?? startOfToday.toISOString()
    const to = c.req.query('to') ?? new Date(now.getTime() + THIRTY_DAYS_MS).toISOString()
    const appointments = await new AppointmentsRepo(deps.db, loc).listByRange(from, to)
    return c.json({ appointments })
  })

  app.post('/appointments', zValidator('json', createApptSchema), async (c) => {
    const loc = c.get('locationId')
    const input = c.req.valid('json')
    // An appointment may only be booked on a calendar this location owns. The
    // lookup is scoped, so a foreign or missing calendarId is a 400 rather than
    // an appointment attached to another tenant's calendar.
    const calendar = await new CalendarsRepo(deps.db, loc).get(input.calendarId)
    if (!calendar) return c.json({ error: 'unknown calendar' }, 400)
    // Same for the client: a contact id from another practice must not be attachable.
    if (input.contactId && !(await new ContactsRepo(deps.db, loc).get(input.contactId))) return c.json({ error: 'unknown contact' }, 400)
    try {
      const appointment = await deps.db.transaction(async (tx) => {
        const created = await new AppointmentsRepo(tx, loc).create({ ...input, modality: input.modality ?? calendar.default_modality })
        await audit(tx, loc, {
          action: 'appointment.created',
          entityType: 'appointment',
          entityId: created.id,
          contactId: created.contact_id ?? null,
          details: { calendarId: input.calendarId, startsAt: created.starts_at, modality: created.modality },
          ...auditContext(c),
        })
        return created
      })
      // A session booked by the therapist counts exactly like one a client booked: the onboarding card
      // moves on to "First appointment booked" (a live appointment_booked workflow does it).
      if (appointment.contact_id) {
        await deps.dispatch?.({ locationId: loc, triggerType: 'appointment_booked', contactId: appointment.contact_id, payload: { appointmentId: appointment.id, calendarId: input.calendarId, source: 'operator' }, depth: 0 })
      }
      const warnings = await warningsFor(loc, appointment.starts_at, appointment.ends_at)
      // A video session with no signed telepsychology consent on file: tell her, never block her.
      if (appointment.modality === 'telehealth_video' && appointment.contact_id && !(await hasTelepsychologyConsent(deps.db, loc, appointment.contact_id))) {
        warnings.push('telepsychology_consent_missing')
      }
      return c.json({ ok: true, appointment, warnings }, 201)
    } catch (err) {
      // The no-double-book index refused this calendar+instant. An honest 409,
      // not a 500 — the operator must pick another time.
      if (isUniqueViolation(err)) return c.json({ error: 'time already booked' }, 409)
      throw err
    }
  })

  app.patch('/appointments/:id', zValidator('json', patchApptSchema), async (c) => {
    const loc = c.get('locationId')
    const id = c.req.param('id')
    const body = c.req.valid('json')

    const hasMove = body.startsAt !== undefined && body.endsAt !== undefined
    if ((body.startsAt === undefined) !== (body.endsAt === undefined)) return c.json({ error: 'startsAt and endsAt go together' }, 400)
    const details = {
      title: body.title, contactId: body.contactId, locationText: body.locationText, notes: body.notes, modality: body.modality,
    }
    const hasDetails = Object.values(details).some((v) => v !== undefined)
    if (!hasMove && !hasDetails && body.status === undefined) return c.json({ error: 'nothing to change' }, 400)

    type Outcome = { ok: true; appointment: Awaited<ReturnType<AppointmentsRepo['get']>> & object } | { ok: false; status: 400 | 404 | 409; error: string }
    let outcome: Outcome
    try {
      outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
        const repo = new AppointmentsRepo(tx, loc)
        let current: Awaited<ReturnType<AppointmentsRepo['get']>>

        // 1. details: title, client, place, notes, how it is held.
        if (hasDetails) {
          current = await repo.get(id)
          if (!current) return { ok: false, status: 404, error: 'not found' }
          if (typeof body.contactId === 'string' && !(await new ContactsRepo(tx, loc).get(body.contactId))) {
            return { ok: false, status: 400, error: 'unknown contact' }
          }
          if (body.modality !== undefined && body.modality !== current.modality) {
            // The session note's billing place of service follows the modality: not after it was held.
            if (current.status === 'completed') return { ok: false, status: 409, error: 'completed appointment' }
            // Someone may be inside the call: end it from the room first.
            if (current.modality === 'telehealth_video') {
              const room = await new VideoMeetingsRepo(tx, loc).getByAppointment(id)
              if (room?.chime_meeting && !room.ended_at) return { ok: false, status: 409, error: 'video session in progress' }
            }
          }
          const was: Record<string, unknown> = { title: current.title, contactId: current.contact_id, locationText: current.location_text, notes: current.notes, modality: current.modality }
          const changed = (Object.keys(details) as (keyof typeof details)[]).filter((k) => details[k] !== undefined && (details[k] ?? null) !== (was[k] ?? null))
          if (changed.length > 0) {
            const updated = await repo.updateDetails(id, details)
            if (!updated) return { ok: false, status: 404, error: 'not found' }
            await audit(tx, loc, {
              action: 'appointment.updated',
              entityType: 'appointment',
              entityId: id,
              contactId: updated.contact_id ?? null,
              // Field names only, never the text; the one closed value that matters (how it is held) with from/to.
              details: { fields: changed, ...(changed.includes('modality') ? { modality: { from: current.modality, to: updated.modality } } : {}) },
              ...auditContext(c),
            })
            current = updated
          }
        }

        // 2. a new time.
        if (hasMove) {
          const r = await repo.rescheduleWithPrev(id, body.startsAt!, body.endsAt!)
          if (!r) return { ok: false, status: 404, error: 'not found' }
          await audit(tx, loc, {
            action: 'appointment.rescheduled',
            entityType: 'appointment',
            entityId: r.appointment.id,
            contactId: r.appointment.contact_id ?? null,
            details: { from: r.prevStartsAt, to: r.appointment.starts_at },
            ...auditContext(c),
          })
          current = r.appointment
        }

        // 3. a new status.
        if (body.status !== undefined) {
          const r = await repo.setStatusWithPrev(id, body.status)
          if (!r) return { ok: false, status: 404, error: 'not found' }
          await audit(tx, loc, {
            action: 'appointment.status_changed',
            entityType: 'appointment',
            entityId: r.appointment.id,
            contactId: r.appointment.contact_id ?? null,
            details: { from: r.prevStatus, to: body.status },
            ...auditContext(c),
          })
          current = r.appointment
        }
        return current ? { ok: true, appointment: current } : { ok: false, status: 404, error: 'not found' }
      })
    } catch (err) {
      // Moving onto a slot another live appointment already holds → 409.
      if (isUniqueViolation(err)) return c.json({ error: 'time already booked' }, 409)
      throw err
    }
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status)
    const appointment = outcome.appointment
    // A move is the only change that can land on top of her own calendar.
    const warnings = hasMove ? await warningsFor(loc, appointment.starts_at, appointment.ends_at) : []
    // Switching to video for a client with no consent on file: tell her, never block her.
    if (body.modality === 'telehealth_video' && appointment.contact_id && !(await hasTelepsychologyConsent(deps.db, loc, appointment.contact_id))) {
      warnings.push('telepsychology_consent_missing')
    }
    return c.json({ ok: true, appointment, warnings })
  })

  // Delete an appointment. Never while a session note is written for it (the database refuses) or while a video
  // session is live. A charge made from it is untouched: it carries the appointment id as plain information.
  app.delete('/appointments/:id', async (c) => {
    const loc = c.get('locationId')
    const id = c.req.param('id')
    try {
      const result = await deps.db.transaction(async (tx) => {
        const repo = new AppointmentsRepo(tx, loc)
        const cur = await repo.get(id)
        if (!cur) return 'not_found' as const
        const room = await new VideoMeetingsRepo(tx, loc).getByAppointment(id)
        if (room?.chime_meeting && !room.ended_at) return 'video_live' as const
        await repo.delete(id)
        await audit(tx, loc, {
          action: 'appointment.deleted',
          entityType: 'appointment',
          entityId: id,
          contactId: cur.contact_id ?? null,
          details: { startsAt: cur.starts_at, status: cur.status, modality: cur.modality },
          ...auditContext(c),
        })
        return 'deleted' as const
      })
      if (result === 'not_found') return c.json({ error: 'not found' }, 404)
      if (result === 'video_live') return c.json({ error: 'video session in progress' }, 409)
      return c.json({ ok: true })
    } catch (err) {
      if (isForeignKeyViolation(err)) return c.json({ error: 'has a session note' }, 409)
      throw err
    }
  })

  // Front-desk check-in. One tap: scheduled/confirmed -> checked_in, with the time. The
  // change, its audit row and the client's timeline entry commit together; the trigger
  // fires only afterwards. Checking in again is a harmless 200 that writes nothing.
  app.post('/appointments/:id/check-in', async (c) => {
    const loc = c.get('locationId')
    const result = await deps.db.transaction(async (tx) => {
      const r = await new AppointmentsRepo(tx, loc).checkIn(c.req.param('id'))
      if (r.ok && r.changed) {
        await audit(tx, loc, {
          action: 'appointment.checked_in',
          entityType: 'appointment',
          entityId: r.appointment.id,
          contactId: r.appointment.contact_id ?? null,
          details: { from: r.prevStatus },
          ...auditContext(c),
        })
        if (r.appointment.contact_id) {
          await new TimelineRepo(tx, loc).add({
            contactId: r.appointment.contact_id,
            type: 'appointment_checked_in',
            refTable: 'appointments',
            refId: r.appointment.id,
            payload: { startsAt: r.appointment.starts_at },
          })
        }
      }
      return r
    })
    if (!result.ok) {
      return result.reason === 'not_found'
        ? c.json({ error: 'not found' }, 404)
        : c.json({ error: 'cannot_check_in', status: result.status }, 409)
    }
    if (result.changed) {
      await deps.dispatch?.({ locationId: loc, triggerType: 'appointment_checked_in', contactId: result.appointment.contact_id ?? null, payload: { appointmentId: result.appointment.id, calendarId: result.appointment.calendar_id }, depth: 0 })
    }
    return c.json({ ok: true, appointment: result.appointment, changed: result.changed })
  })

  return app
}

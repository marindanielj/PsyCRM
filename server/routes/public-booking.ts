import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { isValidIsoDate, todayIn } from '../lib/age'
import { audit, clientAuditContext } from '../lib/audit'
import { bookableDates, parseYmd, slotsForDate, zonedYmd } from '../lib/availability'
import { calendarBusyFor, toConfig } from '../lib/booking-availability'
import { renderBookingNotFound, renderBookingPage } from '../lib/booking-page'
import { isUniqueViolation } from '../lib/db-errors'
import { AppointmentsRepo } from '../repos/appointments-repo'
import { type Calendar, CalendarsRepo } from '../repos/calendars-repo'
import { ContactsRepo } from '../repos/contacts-repo'
import { LocationsRepo } from '../repos/locations-repo'
import { TimelineRepo } from '../repos/timeline-repo'

const bookSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  phone: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  // YYYY-MM-DD; required when the deployment asks for it (PsyCRM).
  dateOfBirth: z.string().trim().optional().nullable(),
})

/**
 * Public, UNAUTHENTICATED booking pages — mounted at `/api/public/booking`
 * BEFORE the operatorAuth boundary, so the location comes from the URL (`:loc`).
 * A calendar is reachable here only while it is `booking_enabled`:
 *
 *   GET  /:loc/:slug              → the hosted booking page (visitor render)
 *   GET  /:loc/:slug/slots?date=  → open times for one local date (JSON)
 *   POST /:loc/:slug/book         → reserve a slot (creates contact + appointment)
 *
 * The slot math lives in lib/availability and is recomputed on every request, so
 * the page can never offer — or accept — a time that the calendar's own
 * appointments, notice window, or buffer have since closed. Booking dispatches
 * `appointment_booked`, closing the capture → automation loop.
 */
export function publicBookingRoute(deps: {
  db: Database
  /** Fired after a booking so live `appointment_booked` workflows enroll the lead. */
  dispatch?: WorkflowDispatch
  /** Injectable clock — defaults to wall-clock; tests pin it for determinism. */
  now?: () => Date
  /** PsyCRM: a booking must carry a valid date of birth (the page asks for it). */
  requireDateOfBirth?: boolean
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const clock = () => deps.now?.() ?? new Date()

  /** Load a booking-enabled calendar by slug, or undefined. */
  async function enabledCalendar(loc: string, slug: string): Promise<Calendar | undefined> {
    const cal = await new CalendarsRepo(deps.db, loc).getByBookingSlug(slug)
    return cal && cal.booking_enabled ? cal : undefined
  }

  /** The location's branding color, or undefined. */
  async function brandColor(loc: string): Promise<string | undefined> {
    const location = await new LocationsRepo(deps.db).getById(loc)
    const color = location?.branding.color
    return typeof color === 'string' ? color : undefined
  }

  // The hosted booking page. Unknown or not-enabled → a styled 404.
  app.get('/:loc/:slug', async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const cal = await enabledCalendar(loc, slug)
    if (!cal) return c.html(renderBookingNotFound(), 404)
    const dates = bookableDates(toConfig(cal), clock())
    return c.html(
      renderBookingPage(cal, {
        actionBase: `/api/public/booking/${loc}/${slug}`,
        dates,
        brandColor: await brandColor(loc),
        requireDateOfBirth: deps.requireDateOfBirth,
      }),
    )
  })

  // Open times for one local date — the source of truth (busy + notice + buffer).
  app.get('/:loc/:slug/slots', async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const date = c.req.query('date') ?? ''
    const cal = await enabledCalendar(loc, slug)
    if (!cal) return c.json({ error: 'not found' }, 404)
    try {
      parseYmd(date)
    } catch {
      return c.json({ slots: [] })
    }
    const config = toConfig(cal)
    const busy = await calendarBusyFor(deps.db, loc, cal, date)
    return c.json({ slots: slotsForDate(config, date, busy, clock()) })
  })

  // Reserve a slot. Recomputes the offered slots RIGHT NOW and rejects a start
  // that is no longer free (someone booked it, or notice has passed) — the
  // double-book guard. Then upserts the contact and creates the appointment.
  app.post('/:loc/:slug/book', zValidator('json', bookSchema), async (c) => {
    const loc = c.req.param('loc')
    const slug = c.req.param('slug')
    const input = c.req.valid('json')
    const cal = await enabledCalendar(loc, slug)
    if (!cal) return c.json({ error: 'not found' }, 404)

    const config = toConfig(cal)
    const ymd = zonedYmd(new Date(input.start), config.timezone)
    const busy = await calendarBusyFor(deps.db, loc, cal, ymd)
    const match = slotsForDate(config, ymd, busy, clock()).find((s) => s.start === input.start)
    if (!match) return c.json({ error: 'slot taken' }, 409)

    const dob = input.dateOfBirth?.trim() || undefined
    if (dob !== undefined && (!isValidIsoDate(dob) || dob > todayIn(undefined, clock()))) {
      return c.json({ error: 'invalid date of birth' }, 400)
    }
    if (deps.requireDateOfBirth && dob === undefined) return c.json({ error: 'date of birth required' }, 400)

    const phone = input.phone?.trim() || undefined
    // One unit: the client, the appointment, the timeline entry and the audit rows
    // commit together. Losing the double-book race (a 23505 on the appointment)
    // now also undoes the client row, instead of leaving a booking-less contact.
    let booked: { appointment: Awaited<ReturnType<AppointmentsRepo['create']>>; contactId: string }
    try {
      booked = await deps.db.transaction(async (tx) => {
        const contacts = new ContactsRepo(tx, loc)
        const upserted = await contacts.upsertByMatchFlagged(
          { name: input.name, email: input.email, phone },
          `booking:${slug}`,
        )
        let contact = upserted.contact
        if (dob !== undefined && !contact.custom_fields?.date_of_birth) {
          contact = (await contacts.setCustomField(contact.id, 'date_of_birth', dob)) ?? contact
        }
        const appointment = await new AppointmentsRepo(tx, loc).create({
          calendarId: cal.id,
          title: `${cal.name} — ${input.name}`,
          startsAt: match.start,
          endsAt: match.end,
          contactId: contact.id,
          notes: input.notes?.trim() || null,
        })
        await new TimelineRepo(tx, loc).add({
          contactId: contact.id,
          type: 'appointment_booked',
          refTable: 'appointments',
          refId: appointment.id,
          payload: { calendar: cal.name, start: match.start },
        })
        const who = clientAuditContext(c, 'Client (public booking page)')
        if (upserted.created) {
          await audit(tx, loc, {
            action: 'contact.created',
            entityType: 'contact',
            entityId: contact.id,
            contactId: contact.id,
            details: { source: `booking:${slug}`, fields: ['name', 'email', phone && 'phone', dob && 'date_of_birth'].filter(Boolean) },
            ...who,
          })
        }
        await audit(tx, loc, {
          action: 'appointment.booked',
          entityType: 'appointment',
          entityId: appointment.id,
          contactId: contact.id,
          details: { calendarId: cal.id, startsAt: match.start },
          ...who,
        })
        return { appointment, contactId: contact.id }
      })
    } catch (err) {
      // We lost the write race: between our slot snapshot above and this INSERT,
      // another visitor claimed the same calendar+instant. The partial unique
      // index turns that into a 23505, which is an honest "slot taken" — never a
      // 500, and never a silent double-book. Any other error is a real fault.
      if (isUniqueViolation(err)) return c.json({ error: 'slot taken' }, 409)
      throw err
    }
    const { appointment } = booked
    const contact = { id: booked.contactId }

    // Drive the capture → automation loop: a live appointment_booked workflow runs.
    await deps.dispatch?.({ locationId: loc, triggerType: 'appointment_booked', contactId: contact.id })

    return c.json({ ok: true, appointmentId: appointment.id, contactId: contact.id })
  })

  return app
}

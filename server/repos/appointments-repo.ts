import { nanoid } from 'nanoid'
import { LocationScopedRepo } from './base-repo'

export interface Appointment {
  id: string
  location_id: string
  calendar_id: string
  contact_id: string | null
  title: string
  starts_at: string
  ends_at: string
  status: string
  location_text: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface AppointmentInput {
  calendarId: string
  title: string
  startsAt: string
  endsAt: string
  contactId?: string | null
  locationText?: string | null
  notes?: string | null
}

export class AppointmentsRepo extends LocationScopedRepo {
  /** Appointments whose start falls in [from, to). Ordered chronologically. */
  listByRange(fromISO: string, toISO: string): Promise<Appointment[]> {
    return this.scopedSelect<Appointment>(
      'SELECT * FROM appointments WHERE starts_at >= $2 AND starts_at < $3 ORDER BY starts_at',
      [fromISO, toISO],
    )
  }

  /** The busy set for ONE calendar in [from, to), excluding cancelled
   *  appointments — what a public booking page must keep its slots clear of. */
  listByCalendarRange(calendarId: string, fromISO: string, toISO: string): Promise<Appointment[]> {
    return this.scopedSelect<Appointment>(
      `SELECT * FROM appointments
        WHERE calendar_id=$2 AND starts_at >= $3 AND starts_at < $4 AND status <> 'cancelled'
        ORDER BY starts_at`,
      [calendarId, fromISO, toISO],
    )
  }

  async get(id: string): Promise<Appointment | undefined> {
    const rows = await this.scopedSelect<Appointment>('SELECT * FROM appointments WHERE id=$2', [id])
    return rows[0]
  }

  async create(input: AppointmentInput): Promise<Appointment> {
    const id = nanoid()
    const rows = await this.scopedWrite<Appointment>(
      `INSERT INTO appointments
        (id, location_id, calendar_id, contact_id, title, starts_at, ends_at, location_text, notes)
       VALUES ($2,$1,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        id,
        input.calendarId,
        input.contactId ?? null,
        input.title,
        input.startsAt,
        input.endsAt,
        input.locationText ?? null,
        input.notes ?? null,
      ],
    )
    return rows[0]!
  }

  /** Move an appointment to a new time (drag or edit). */
  async reschedule(id: string, startsAt: string, endsAt: string): Promise<Appointment | undefined> {
    const rows = await this.scopedWrite<Appointment>(
      `UPDATE appointments SET starts_at=$2, ends_at=$3, updated_at=now()
       WHERE location_id=$1 AND id=$4 RETURNING *`,
      [startsAt, endsAt, id],
    )
    return rows[0]
  }

  async setStatus(id: string, status: string): Promise<Appointment | undefined> {
    const rows = await this.scopedWrite<Appointment>(
      `UPDATE appointments SET status=$2, updated_at=now()
       WHERE location_id=$1 AND id=$3 RETURNING *`,
      [status, id],
    )
    return rows[0]
  }

  /**
   * reschedule() that also reports the time it moved FROM, read in the same
   * statement (a CTE snapshots the row before the UPDATE), so the audit log can
   * say "from X to Y" without a second round trip or a race.
   */
  async rescheduleWithPrev(
    id: string,
    startsAt: string,
    endsAt: string,
  ): Promise<{ appointment: Appointment; prevStartsAt: string | null } | undefined> {
    const rows = await this.scopedWrite<Appointment & { prev_starts_at?: string | null }>(
      `WITH old AS (SELECT starts_at FROM appointments WHERE location_id=$1 AND id=$4)
       UPDATE appointments SET starts_at=$2, ends_at=$3, updated_at=now()
       WHERE location_id=$1 AND id=$4
       RETURNING *, (SELECT starts_at FROM old) AS prev_starts_at`,
      [startsAt, endsAt, id],
    )
    const r = splitPrev(rows[0], 'prev_starts_at')
    return r && { appointment: r.appointment, prevStartsAt: r.prev }
  }

  /** setStatus() that also reports the status it changed FROM (same CTE trick). */
  async setStatusWithPrev(
    id: string,
    status: string,
  ): Promise<{ appointment: Appointment; prevStatus: string | null } | undefined> {
    const rows = await this.scopedWrite<Appointment & { prev_status?: string | null }>(
      `WITH old AS (SELECT status FROM appointments WHERE location_id=$1 AND id=$3)
       UPDATE appointments SET status=$2, updated_at=now()
       WHERE location_id=$1 AND id=$3
       RETURNING *, (SELECT status FROM old) AS prev_status`,
      [status, id],
    )
    const r = splitPrev(rows[0], 'prev_status')
    return r && { appointment: r.appointment, prevStatus: r.prev }
  }
}

/** Peel a `prev_*` column off a RETURNING row so it never leaks into the API body. */
function splitPrev(
  row: object | undefined,
  column: string,
): { appointment: Appointment; prev: string | null } | undefined {
  if (!row) return undefined
  const { [column]: prev, ...appointment } = row as Record<string, unknown>
  return { appointment: appointment as unknown as Appointment, prev: (prev as string | null | undefined) ?? null }
}

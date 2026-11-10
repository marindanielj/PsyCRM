import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'
import type { Block } from '../lib/ics'
import { hashToken, newToken } from '../lib/document-tokens'
import { seal } from '../lib/secret-box'

type Ctx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

export const FEED_TITLES = ['Cita', 'Ocupado'] as const
export type FeedTitle = (typeof FEED_TITLES)[number]
export const MAX_EXTERNAL_CALENDARS = 5
export const SEAL_LABEL = 'calendar-sync-url'

/** The address of one's own feed is only ever shown when it is made; later reads say whether it exists. */
export interface FeedInfo {
  title: FeedTitle
  created_at: string
  rotated_at: string | null
  last_fetched_at: string | null
  fetch_count: number
}

export interface ExternalCalendar {
  id: string
  label: string
  host: string
  enabled: boolean
  last_synced_at: string | null
  last_attempt_at: string | null
  last_status: 'ok' | 'error' | null
  last_error: string | null
  block_count: number
  created_at: string
}

const EXTERNAL_COLUMNS =
  'id, label, host, enabled, last_synced_at, last_attempt_at, last_status, last_error, block_count, created_at'

/** A row the poller needs: the sealed address too, and the tenant. Never sent to a browser. */
export interface DueCalendar {
  id: string
  location_id: string
  url_sealed: string
  last_status: 'ok' | 'error' | null
}

/** Calendar sync for ONE practice. Everything but the poller and the public feed lookup goes through here. */
export class CalendarSyncRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  // --- outbound feed ---------------------------------------------------------------------------------------------

  async getFeed(): Promise<FeedInfo | undefined> {
    const rows = await this.db.query<FeedInfo>(
      'SELECT title, created_at, rotated_at, last_fetched_at, fetch_count::int AS fetch_count FROM calendar_feeds WHERE location_id = $1',
      [this.locationId],
    )
    return rows[0]
  }

  /**
   * Make the feed address, or replace it (the old one stops working at once). The plain token is returned ONCE here and
   * never stored; only its hash is.
   */
  async createOrRotateFeed(ctx: Ctx): Promise<{ token: string; rotated: boolean }> {
    const token = newToken()
    return this.db.transaction(async (tx) => {
      const existing = await tx.query('SELECT 1 FROM calendar_feeds WHERE location_id = $1', [this.locationId])
      if (existing.length > 0) {
        await tx.query('UPDATE calendar_feeds SET token_hash = $2, rotated_at = now(), last_fetched_at = NULL, fetch_count = 0 WHERE location_id = $1', [this.locationId, hashToken(token)])
      } else {
        await tx.query('INSERT INTO calendar_feeds (location_id, token_hash) VALUES ($1,$2)', [this.locationId, hashToken(token)])
      }
      const rotated = existing.length > 0
      await audit(tx, this.locationId, {
        action: rotated ? 'calendar.feed_regenerated' : 'calendar.feed_created',
        entityType: 'calendar_feed',
        entityId: this.locationId,
        ...ctx,
      })
      return { token, rotated }
    })
  }

  async setFeedTitle(title: FeedTitle, ctx: Ctx): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query('UPDATE calendar_feeds SET title = $2 WHERE location_id = $1 AND title <> $2 RETURNING 1', [this.locationId, title])
      if (rows.length === 0) return false
      await audit(tx, this.locationId, { action: 'calendar.feed_title_changed', entityType: 'calendar_feed', entityId: this.locationId, details: { title }, ...ctx })
      return true
    })
  }

  async revokeFeed(ctx: Ctx): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query('DELETE FROM calendar_feeds WHERE location_id = $1 RETURNING 1', [this.locationId])
      if (rows.length === 0) return false
      await audit(tx, this.locationId, { action: 'calendar.feed_revoked', entityType: 'calendar_feed', entityId: this.locationId, ...ctx })
      return true
    })
  }

  /** The appointments the feed publishes: id and times only. Cancelled ones are left out. */
  feedAppointments(from: Date, to: Date): Promise<{ id: string; starts_at: string; ends_at: string; updated_at: string }[]> {
    return this.db.query(
      `SELECT id, starts_at, ends_at, COALESCE(updated_at, created_at) AS updated_at
         FROM appointments
        WHERE location_id = $1 AND status <> 'cancelled' AND ends_at > $2 AND starts_at < $3
        ORDER BY starts_at`,
      [this.locationId, from.toISOString(), to.toISOString()],
    )
  }

  // --- inbound calendars -----------------------------------------------------------------------------------------

  listExternal(): Promise<ExternalCalendar[]> {
    return this.db.query<ExternalCalendar>(
      `SELECT ${EXTERNAL_COLUMNS} FROM external_calendars WHERE location_id = $1 ORDER BY created_at`,
      [this.locationId],
    )
  }

  async countExternal(): Promise<number> {
    const rows = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM external_calendars WHERE location_id = $1', [this.locationId])
    return rows[0]?.n ?? 0
  }

  /** Save a calendar address, sealed. `host` is shown to the person; the rest of the address is the secret. */
  async addExternal(input: { label: string; url: string; host: string }, secret: string, ctx: Ctx): Promise<ExternalCalendar> {
    const id = nanoid()
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<ExternalCalendar>(
        `INSERT INTO external_calendars (id, location_id, label, url_sealed, host) VALUES ($1,$2,$3,$4,$5) RETURNING ${EXTERNAL_COLUMNS}`,
        [id, this.locationId, input.label, seal(input.url, secret, SEAL_LABEL), input.host],
      )
      await audit(tx, this.locationId, { action: 'calendar.external_connected', entityType: 'external_calendar', entityId: id, details: { host: input.host }, ...ctx })
      return rows[0]!
    })
  }

  async removeExternal(id: string, ctx: Ctx): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ host: string }>('DELETE FROM external_calendars WHERE location_id = $1 AND id = $2 RETURNING host', [this.locationId, id])
      if (rows.length === 0) return false
      await audit(tx, this.locationId, { action: 'calendar.external_removed', entityType: 'external_calendar', entityId: id, details: { host: rows[0]!.host }, ...ctx })
      return true
    })
  }

  async setExternalEnabled(id: string, enabled: boolean, ctx: Ctx): Promise<ExternalCalendar | undefined> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<ExternalCalendar>(
        `UPDATE external_calendars SET enabled = $3 WHERE location_id = $1 AND id = $2 RETURNING ${EXTERNAL_COLUMNS}`,
        [this.locationId, id, enabled],
      )
      if (rows.length === 0) return undefined
      // A paused calendar must stop blocking time, so its blocks go too; they come back on the next sync.
      if (!enabled) await tx.query('DELETE FROM external_busy WHERE external_calendar_id = $1', [id])
      await audit(tx, this.locationId, { action: 'calendar.external_toggled', entityType: 'external_calendar', entityId: id, details: { enabled }, ...ctx })
      return rows[0]
    })
  }

  /** What the sync needs for one calendar of this practice (the sealed address included; never sent to a browser). */
  async syncRow(id: string): Promise<DueCalendar | undefined> {
    const rows = await this.db.query<DueCalendar>('SELECT id, location_id, url_sealed, last_status FROM external_calendars WHERE location_id = $1 AND id = $2', [this.locationId, id])
    return rows[0]
  }

  async renameExternal(id: string, label: string): Promise<boolean> {
    const rows = await this.db.query('UPDATE external_calendars SET label = $3 WHERE location_id = $1 AND id = $2 RETURNING 1', [this.locationId, id, label])
    return rows.length > 0
  }

  // --- the busy blocks -------------------------------------------------------------------------------------------

  /** Every enabled calendar's blocks that overlap [from, to). */
  async busyBetween(from: Date, to: Date): Promise<{ start: Date; end: Date }[]> {
    const rows = await this.db.query<{ starts_at: string; ends_at: string }>(
      'SELECT starts_at, ends_at FROM external_busy WHERE location_id = $1 AND ends_at > $2 AND starts_at < $3 ORDER BY starts_at',
      [this.locationId, from.toISOString(), to.toISOString()],
    )
    return rows.map((r) => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }))
  }

  /** Does [start, end) overlap any external block? (Used to warn when something is scheduled on top.) */
  async overlaps(start: Date, end: Date): Promise<boolean> {
    const rows = await this.db.query('SELECT 1 FROM external_busy WHERE location_id = $1 AND ends_at > $2 AND starts_at < $3 LIMIT 1', [this.locationId, start.toISOString(), end.toISOString()])
    return rows.length > 0
  }
}

// --- used by the poller and the public feed, which have no single practice in hand ----------------------------------

/** Calendars due for a refresh: enabled, and not attempted in the last `minAgeMs`. */
export function dueCalendars(db: Database, minAgeMs: number, limit = 50): Promise<DueCalendar[]> {
  return db.query<DueCalendar>(
    `SELECT id, location_id, url_sealed, last_status FROM external_calendars
      WHERE enabled AND (last_attempt_at IS NULL OR last_attempt_at < now() - ($1::int * interval '1 millisecond'))
      ORDER BY last_attempt_at NULLS FIRST LIMIT $2`,
    [Math.floor(minAgeMs), limit],
  )
}

/**
 * Store the result of one sync. On success the calendar's whole set of blocks is replaced in one transaction; on failure
 * the previous blocks are KEPT (a flaky connection must not suddenly open a therapist's busy afternoon).
 * Returns whether a failure is new (the previous attempt did not fail), so only that is audited.
 */
export async function recordSync(
  db: Database,
  cal: { id: string; location_id: string; last_status: 'ok' | 'error' | null },
  result: { ok: true; blocks: Block[] } | { ok: false; error: string },
): Promise<{ newFailure: boolean }> {
  return db.transaction(async (tx) => {
    // The row may have been removed while the fetch was in flight.
    const alive = await tx.query('SELECT 1 FROM external_calendars WHERE id = $1 AND location_id = $2 AND enabled', [cal.id, cal.location_id])
    if (alive.length === 0) return { newFailure: false }
    if (result.ok) {
      await tx.query('DELETE FROM external_busy WHERE external_calendar_id = $1', [cal.id])
      if (result.blocks.length > 0) {
        // One round trip: unnest the arrays.
        await tx.query(
          `INSERT INTO external_busy (location_id, external_calendar_id, starts_at, ends_at)
           SELECT $1, $2, s, e FROM unnest($3::timestamptz[], $4::timestamptz[]) AS t(s, e)`,
          [cal.location_id, cal.id, result.blocks.map((b) => b.start.toISOString()), result.blocks.map((b) => b.end.toISOString())],
        )
      }
      await tx.query(
        `UPDATE external_calendars SET last_synced_at = now(), last_attempt_at = now(), last_status = 'ok', last_error = NULL, block_count = $2 WHERE id = $1`,
        [cal.id, result.blocks.length],
      )
      return { newFailure: false }
    }
    await tx.query(`UPDATE external_calendars SET last_attempt_at = now(), last_status = 'error', last_error = $2 WHERE id = $1`, [cal.id, result.error])
    return { newFailure: cal.last_status !== 'error' }
  })
}

// --- the public feed ----------------------------------------------------------------------------------------------

const DAY_MS = 24 * 3600_000

/** Which practice owns this feed token? Looked up by hash, so the plain token is never compared in SQL text. */
export async function findFeedByToken(db: Database, token: string): Promise<{ location_id: string; title: FeedTitle; last_fetched_at: string | null } | undefined> {
  const rows = await db.query<{ location_id: string; title: FeedTitle; last_fetched_at: string | null }>(
    'SELECT location_id, title, last_fetched_at FROM calendar_feeds WHERE token_hash = $1',
    [hashToken(token)],
  )
  return rows[0]
}

/**
 * Count a read of the feed. Phones poll every few hours, so the audit log gets one line per day at most, not one per poll.
 */
export async function recordFeedFetch(db: Database, locationId: string, previous: string | null, ctx: Ctx): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('UPDATE calendar_feeds SET last_fetched_at = now(), fetch_count = fetch_count + 1 WHERE location_id = $1', [locationId])
    const first = previous === null || Date.now() - new Date(previous).getTime() > DAY_MS
    if (first) await audit(tx, locationId, { action: 'calendar.feed_fetched', entityType: 'calendar_feed', entityId: locationId, ...ctx })
  })
}

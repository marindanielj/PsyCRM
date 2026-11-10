/**
 * The inbound half of calendar sync: read the therapist's personal calendar, keep only its busy blocks.
 *
 * Failure is quiet and safe. If a calendar cannot be read, its previous blocks stay in place (a flaky connection must not
 * suddenly open an afternoon she has blocked) and the failure is recorded with a short code, never the response body or
 * the address.
 */
import type { Database } from '../db/database'
import { audit } from './audit'
import { SEAL_LABEL, type DueCalendar, dueCalendars, recordSync } from '../repos/calendar-sync-repo'
import { type Block, parseBusyBlocks } from './ics'
import { open } from './secret-box'
import { type FetchResult, fetchCalendarText } from './ssrf'

const DAY_MS = 24 * 3600_000
/** How far back and ahead blocks are kept. Booking pages offer at most 60 days; the margin covers a reschedule. */
export const SYNC_PAST_DAYS = 1
export const SYNC_AHEAD_DAYS = 90
/** A calendar is refreshed when its last attempt is older than this. */
export const SYNC_MIN_AGE_MS = 9 * 60_000
export const FALLBACK_TIMEZONE = 'America/Puerto_Rico'

export interface SyncDeps {
  db: Database
  /** SESSION_SECRET: the key the addresses were sealed under. */
  secret: string
  fetchText?: (url: string) => Promise<FetchResult>
  now?: () => Date
}

export type SyncOutcome = { ok: true; blocks: number; truncated: boolean; unsupportedRules: number } | { ok: false; error: string }

/** The practice's time zone for floating times and all-day events. */
export async function practiceTimezone(db: Database, locationId: string): Promise<string> {
  const rows = await db.query<{ tz: string | null }>(
    `SELECT COALESCE(settings->>'timezone', (SELECT timezone FROM calendars WHERE location_id = locations.id ORDER BY position LIMIT 1)) AS tz
       FROM locations WHERE id = $1`,
    [locationId],
  )
  const tz = rows[0]?.tz
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {
      /* fall through */
    }
  }
  return FALLBACK_TIMEZONE
}

/** What reading a calendar yields: its busy blocks (start and end only), or a short failure code. */
export type ReadOutcome =
  | { ok: true; blocks: Block[]; truncated: boolean; unsupportedRules: number }
  | { ok: false; error: string }

/** Fetch and parse one calendar address. Touches no database row, so it can also vet an address before it is stored. */
export async function readCalendar(
  deps: Pick<SyncDeps, 'db' | 'fetchText' | 'now'>,
  url: string,
  locationId: string,
): Promise<ReadOutcome> {
  const now = (deps.now ?? (() => new Date()))()
  const res = await (deps.fetchText ?? fetchCalendarText)(url)
  if (!res.ok) return { ok: false, error: res.error }
  const parsed = parseBusyBlocks(res.text, {
    from: new Date(now.getTime() - SYNC_PAST_DAYS * DAY_MS),
    to: new Date(now.getTime() + SYNC_AHEAD_DAYS * DAY_MS),
    defaultTimeZone: await practiceTimezone(deps.db, locationId),
  })
  if (!parsed.isCalendar) return { ok: false, error: 'not_calendar' }
  return { ok: true, blocks: parsed.blocks, truncated: parsed.truncated, unsupportedRules: parsed.unsupportedRules }
}

/** Read one stored calendar and store what it blocks. */
export async function syncOne(deps: SyncDeps, cal: Pick<DueCalendar, 'id' | 'location_id' | 'url_sealed' | 'last_status'>): Promise<SyncOutcome> {
  const fail = async (error: string): Promise<SyncOutcome> => {
    const { newFailure } = await recordSync(deps.db, cal, { ok: false, error })
    if (newFailure) {
      await audit(deps.db, cal.location_id, {
        action: 'calendar.external_sync_failed',
        entityType: 'external_calendar',
        entityId: cal.id,
        details: { error },
        actor: { type: 'system', label: 'Calendar sync' },
      })
    }
    return { ok: false, error }
  }

  const url = open(cal.url_sealed, deps.secret, SEAL_LABEL)
  if (!url) return fail('secret_unreadable')

  const read = await readCalendar(deps, url, cal.location_id)
  if (!read.ok) return fail(read.error)

  await recordSync(deps.db, cal, { ok: true, blocks: read.blocks })
  return { ok: true, blocks: read.blocks.length, truncated: read.truncated, unsupportedRules: read.unsupportedRules }
}

/** One pass of the poller: refresh every calendar that is due. A failure in one never stops the others. */
export async function syncDue(deps: SyncDeps): Promise<{ attempted: number; ok: number }> {
  const due = await dueCalendars(deps.db, SYNC_MIN_AGE_MS)
  let ok = 0
  for (const cal of due) {
    try {
      if ((await syncOne(deps, cal)).ok) ok++
    } catch {
      // A bug or a dropped connection in one calendar must not take down the pass; it is retried next time.
    }
  }
  return { attempted: due.length, ok }
}

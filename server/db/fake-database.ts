import type { Database } from './database'

/**
 * Test double: records every query and returns queued rows FIFO.
 * Used to assert the tenancy invariant (location_id always scoped) and to
 * drive repo/route tests without a live Postgres.
 */
export class FakeDatabase implements Database {
  calls: { sql: string; params: unknown[] }[] = []
  /** Audit-log inserts, captured SEPARATELY: they never consume a queued result
   *  and never appear in `calls`, so adding an audit write to a handler cannot
   *  shift the rows an existing test queued for its other queries. Assert on
   *  these with `auditEntries()`. */
  audits: { sql: string; params: unknown[] }[] = []
  /** How many times transaction() was entered. */
  transactions = 0
  private queued: ({ __error: unknown } | unknown[])[] = []

  /** Queue the rows the next query() call should return. */
  enqueue(rows: unknown[]): void {
    this.queued.push(rows)
  }

  /** Queue an error the next query() call should THROW instead of returning rows
   *  — lets a route test exercise its constraint/race path (e.g. a 23505 unique
   *  violation) without standing up a live Postgres. */
  enqueueError(error: unknown): void {
    this.queued.push({ __error: error })
  }

  /** The captured audit rows, decoded: [locationId, actor_type, actor_id, actor_label,
   *  action, entity_type, entity_id, contact_id, details, ip, user_agent]. */
  auditEntries(): {
    locationId: string
    actorType: string
    actorId: string | null
    action: string
    entityType: string
    entityId: string | null
    contactId: string | null
    details: Record<string, unknown>
  }[] {
    return this.audits.map(({ params: p }) => ({
      locationId: p[0] as string,
      actorType: p[1] as string,
      actorId: p[2] as string | null,
      action: p[4] as string,
      entityType: p[5] as string,
      entityId: p[6] as string | null,
      contactId: p[7] as string | null,
      details: JSON.parse(String(p[8] ?? '{}')) as Record<string, unknown>,
    }))
  }

  /** No rollback semantics (use PGlite for those): runs `fn` against itself. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    this.transactions++
    return fn(this)
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (/^\s*INSERT INTO audit_log\b/i.test(sql)) {
      this.audits.push({ sql, params })
      return [] as T[]
    }
    this.calls.push({ sql, params })
    const next = this.queued.shift()
    if (next && !Array.isArray(next) && '__error' in next) throw next.__error
    return (next ?? []) as T[]
  }
}

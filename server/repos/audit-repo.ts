import type { Database } from '../db/database'
import { categoryPrefixes } from '../lib/audit-vocab'

export interface AuditFilters {
  from?: string
  to?: string
  contactId?: string
  /** A category key (`notes`), expanded to its action prefixes. */
  category?: string
  /** An exact action (`note.signed`) or a prefix ending in a dot (`note.`). */
  action?: string
  actorType?: string
  entityType?: string
  entityId?: string
}

export interface AuditRow {
  seq: number
  occurredAt: string
  actorType: string
  actorId: string | null
  /** Operator display name resolved NOW from the operators table; falls back to
   *  the label snapshot stored with the row. */
  actorName: string | null
  action: string
  entityType: string
  entityId: string | null
  contactId: string | null
  /** The client's CURRENT name, if the client still exists. */
  contactName: string | null
  details: Record<string, unknown>
  ip: string | null
}

interface RawRow {
  chain_seq: string | number
  occurred_at: string | Date
  actor_type: string
  actor_id: string | null
  actor_label: string | null
  actor_name: string | null
  actor_email: string | null
  action: string
  entity_type: string
  entity_id: string | null
  contact_id: string | null
  contact_name: string | null
  details: Record<string, unknown>
  ip: string | null
}

const MAX_LIMIT = 200

/**
 * Read side of the audit log for ONE location. The log itself is written by
 * lib/audit.ts and is append-only; nothing here mutates it. The location filter is
 * always the first condition, so a page can never show another practice's history.
 */
export class AuditRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  /** Newest first. `before` is the `seq` of the last row already shown. */
  async list(filters: AuditFilters, opts: { before?: number; limit?: number } = {}): Promise<{ rows: AuditRow[]; nextBefore: number | null }> {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), MAX_LIMIT)
    const params: unknown[] = [this.locationId]
    const where = ['a.location_id = $1']
    const add = (sql: string, value: unknown) => {
      params.push(value)
      where.push(sql.replace('?', `$${params.length}`))
    }
    if (filters.from) add('a.occurred_at >= ?::timestamptz', filters.from)
    if (filters.to) add('a.occurred_at < ?::timestamptz', filters.to)
    if (filters.contactId) add('a.contact_id = ?', filters.contactId)
    if (filters.actorType) add('a.actor_type = ?', filters.actorType)
    if (filters.entityType) add('a.entity_type = ?', filters.entityType)
    if (filters.entityId) add('a.entity_id = ?', filters.entityId)
    if (filters.category) {
      const prefixes = categoryPrefixes(filters.category)
      // An unknown category matches nothing rather than everything.
      if (prefixes.length) add('a.action LIKE ANY(?::text[])', prefixes.map((p) => `${p}%`))
      else where.push('FALSE')
    }
    if (filters.action) {
      if (filters.action.endsWith('.')) add('a.action LIKE ?', `${filters.action}%`)
      else add('a.action = ?', filters.action)
    }
    if (opts.before !== undefined) add('a.chain_seq < ?', opts.before)
    params.push(limit + 1)

    const rows = await this.db.query<RawRow>(
      `SELECT a.chain_seq, a.occurred_at, a.actor_type, a.actor_id, a.actor_label,
              o.name AS actor_name, o.email AS actor_email,
              a.action, a.entity_type, a.entity_id, a.contact_id,
              COALESCE(c.name, NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '')) AS contact_name,
              a.details, a.ip
       FROM audit_log a
       LEFT JOIN operators o ON a.actor_type = 'operator' AND o.id = a.actor_id
       LEFT JOIN contacts c ON c.id = a.contact_id AND c.location_id = a.location_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.chain_seq DESC
       LIMIT $${params.length}`,
      params,
    )
    const page = rows.slice(0, limit).map(toRow)
    return { rows: page, nextBefore: rows.length > limit ? (page.at(-1)?.seq ?? null) : null }
  }

  /** The chain check (see audit_log_verify in schema.sql) plus the row count. */
  async verify(): Promise<{ ok: boolean; count: number; brokenAtSeq: number | null }> {
    const v = await this.db.query<{ broken: string | number | null }>('SELECT audit_log_verify($1) AS broken', [this.locationId])
    const n = await this.db.query<{ n: string | number }>('SELECT count(*) AS n FROM audit_log WHERE location_id = $1', [this.locationId])
    const broken = v[0]?.broken
    return { ok: broken === null || broken === undefined, count: Number(n[0]?.n ?? 0), brokenAtSeq: broken === null || broken === undefined ? null : Number(broken) }
  }
}

function toRow(r: RawRow): AuditRow {
  return {
    seq: Number(r.chain_seq),
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : new Date(r.occurred_at).toISOString(),
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name ?? r.actor_email ?? r.actor_label,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    contactId: r.contact_id,
    contactName: r.contact_name,
    details: r.details ?? {},
    ip: r.ip,
  }
}

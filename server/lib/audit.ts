import type { Context } from 'hono'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import type { ActorType, AuditAction } from './audit-vocab'
import { clientIp } from './client-ip'

export interface AuditActor {
  type: ActorType
  id?: string | null
  /** Human-readable snapshot ("Workflow: Onboarding"). Operators are resolved by
   *  id at read time instead, so renaming a user does not rewrite history. */
  label?: string | null
}

export interface AuditEntry {
  action: AuditAction
  entityType: string
  entityId?: string | null
  /** The client this concerns, so a client's full history is one query. */
  contactId?: string | null
  /** Field NAMES, ids, states, from/to values — never clinical text. */
  details?: Record<string, unknown>
  actor: AuditActor
  ip?: string | null
  userAgent?: string | null
}

/** Keys that must never be written to the log, whatever a caller passes. */
const FORBIDDEN_KEYS = new Set([
  'body',
  'password',
  'token',
  'otp',
  'code',
  'signature_png',
  'data_subjective',
  'data_objective',
  'assessment',
  'plan',
  'risk_notes',
  'mse',
])
const MAX_STRING = 200
const MAX_DEPTH = 4

/**
 * Last line of defense against clinical text or secrets reaching the log: drops
 * forbidden keys (at any depth), truncates long strings, caps nesting. Callers are
 * still expected to pass only field names / ids / states — this makes a mistake
 * non-fatal rather than a privacy incident.
 */
export function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  if (depth >= MAX_DEPTH) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeDetails(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase()) || v === undefined) continue
      out[k] = sanitizeDetails(v, depth + 1)
    }
    return out
  }
  return String(value)
}

/**
 * Append one row to the audit log. Pass the `tx` of the surrounding
 * `db.transaction(...)` so the row commits (or rolls back) together with the
 * change it describes. The chain columns and the timestamp are set by the
 * database trigger, never by the caller.
 */
export async function audit(db: Database, locationId: string, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log
       (location_id, actor_type, actor_id, actor_label, action, entity_type, entity_id,
        contact_id, details, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [
      locationId,
      e.actor.type,
      e.actor.id ?? null,
      e.actor.label ?? null,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.contactId ?? null,
      JSON.stringify(sanitizeDetails(e.details ?? {})),
      e.ip ?? null,
      e.userAgent?.slice(0, 300) ?? null,
    ],
  )
}

/** Who/where for an operator request: actor from the session, IP and user agent
 *  from the request. Spread into an AuditEntry. */
export function auditContext(c: Context<AppEnv>): Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'> {
  const ip = clientIp(c)
  return {
    actor: { type: 'operator', id: c.get('operatorId') },
    ip: ip === 'unknown' ? null : ip,
    userAgent: c.req.header('user-agent') ?? null,
  }
}

/** Context for an unauthenticated visitor acting on a public page (a client
 *  signing a document, booking a slot). */
export function clientAuditContext(
  c: Context,
  label?: string,
  id?: string,
): Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'> {
  const ip = clientIp(c)
  return {
    actor: { type: 'client', id: id ?? null, label: label ?? null },
    ip: ip === 'unknown' ? null : ip,
    userAgent: c.req.header('user-agent') ?? null,
  }
}

/** The fields of `after` whose value differs from `before`, as { field: [from, to] }.
 *  Only the listed fields are compared. Values are sanitized when logged. */
export function diff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields: readonly string[],
): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {}
  for (const f of fields) {
    const a = before?.[f] ?? null
    const b = after?.[f] ?? null
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = [a, b]
  }
  return out
}

import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'
import type { Day, InquiryInput, Mode, Slot, Who } from '../lib/public-page'

type Ctx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

export type InquiryStatus = 'new' | 'invited' | 'handled'

export interface Inquiry {
  id: string
  status: InquiryStatus
  name: string
  email: string
  phone: string | null
  who: Who
  mode: Mode
  days: Day[]
  slots: Slot[]
  insurance: string | null
  message: string | null
  /** What the person ticked before asking, word for word. */
  acknowledged: string[]
  inviteId: string | null
  createdAt: string
}

interface Row {
  id: string; status: InquiryStatus; name: string; email: string; phone: string | null; who: Who; mode: Mode; days: Day[]; slots: Slot[]
  insurance: string | null; message: string | null; acknowledged: string[]; invite_id: string | null; created_at: Date | string
}
const COLS = 'id, status, name, email, phone, who, mode, days, slots, insurance, message, acknowledged, invite_id, created_at'
const toInquiry = (r: Row): Inquiry => ({
  id: r.id, status: r.status, name: r.name, email: r.email, phone: r.phone, who: r.who, mode: r.mode, days: r.days, slots: r.slots,
  insurance: r.insurance, message: r.message, acknowledged: r.acknowledged ?? [], inviteId: r.invite_id, createdAt: new Date(r.created_at).toISOString(),
})

/** How long an open request from the same email counts as "already asked" (a second submit does not make a second row). */
const DUPLICATE_DAYS = 7

/**
 * Requests that arrive from the public page. They are NOT clients: no record, no date of birth. The therapist
 * reads them here and invites the ones she wants to see; nothing about them goes into a client's file.
 * Audit rows carry ids and the shape of the request, never a name, an email or what was written.
 */
export class InquiriesRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  async create(input: InquiryInput, ctx: Ctx): Promise<{ id: string; duplicate: boolean }> {
    return this.db.transaction(async (tx) => {
      const same = (await tx.query<{ id: string }>(
        `SELECT id FROM inquiries WHERE location_id = $1 AND status = 'new' AND lower(email) = $2 AND created_at > now() - ($3 || ' days')::interval ORDER BY created_at DESC LIMIT 1`,
        [this.locationId, input.email.toLowerCase(), String(DUPLICATE_DAYS)],
      ))[0]
      if (same) return { id: same.id, duplicate: true }
      const id = nanoid()
      await tx.query(
        `INSERT INTO inquiries (id, location_id, name, email, phone, who, mode, days, slots, insurance, message, acknowledged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::text[],$10,$11,$12::text[])`,
        [id, this.locationId, input.name, input.email.toLowerCase(), input.phone ?? null, input.who, input.mode, input.days, input.slots, input.insurance ?? null, input.message ?? null, input.acknowledged],
      )
      await audit(tx, this.locationId, { action: 'inquiry.received', entityType: 'inquiry', entityId: id, details: { who: input.who, mode: input.mode }, ...ctx })
      return { id, duplicate: false }
    })
  }

  async list(status?: InquiryStatus): Promise<Inquiry[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM inquiries WHERE location_id = $1 ${status ? 'AND status = $2' : ''} ORDER BY created_at DESC LIMIT 200`,
      status ? [this.locationId, status] : [this.locationId],
    )
    return rows.map(toInquiry)
  }

  async countNew(): Promise<number> {
    const r = (await this.db.query<{ n: string | number }>("SELECT count(*) AS n FROM inquiries WHERE location_id = $1 AND status = 'new'", [this.locationId]))[0]
    return Number(r?.n ?? 0)
  }

  async get(id: string): Promise<Inquiry | undefined> {
    const r = (await this.db.query<Row>(`SELECT ${COLS} FROM inquiries WHERE location_id = $1 AND id = $2`, [this.locationId, id]))[0]
    return r ? toInquiry(r) : undefined
  }

  /** Handled (answered some other way) or back to new. */
  async setHandled(id: string, handled: boolean, ctx: Ctx): Promise<Inquiry | undefined> {
    return this.db.transaction(async (tx) => {
      const r = (await tx.query<Row>(
        `UPDATE inquiries SET status = $3, updated_at = now() WHERE location_id = $1 AND id = $2 RETURNING ${COLS}`,
        [this.locationId, id, handled ? 'handled' : 'new'],
      ))[0]
      if (!r) return undefined
      await audit(tx, this.locationId, { action: 'inquiry.handled', entityType: 'inquiry', entityId: id, details: { handled }, ...ctx })
      return toInquiry(r)
    })
  }

  async markInvited(id: string, inviteId: string, ctx: Ctx): Promise<Inquiry | undefined> {
    return this.db.transaction(async (tx) => {
      const r = (await tx.query<Row>(
        `UPDATE inquiries SET status = 'invited', invite_id = $3, updated_at = now() WHERE location_id = $1 AND id = $2 RETURNING ${COLS}`,
        [this.locationId, id, inviteId],
      ))[0]
      if (!r) return undefined
      await audit(tx, this.locationId, { action: 'inquiry.invited', entityType: 'inquiry', entityId: id, details: { inviteId }, ...ctx })
      return toInquiry(r)
    })
  }

  async remove(id: string, ctx: Ctx): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const gone = await tx.query('DELETE FROM inquiries WHERE location_id = $1 AND id = $2 RETURNING id', [this.locationId, id])
      if (gone.length === 0) return false
      await audit(tx, this.locationId, { action: 'inquiry.deleted', entityType: 'inquiry', entityId: id, details: {}, ...ctx })
      return true
    })
  }
}

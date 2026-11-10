/**
 * Payments, receipts and invoices for a charge (A4, part 2). See docs/psycrm/specs/extra-billing-invoices-receipts.md.
 *
 * Three rules shape this file:
 *  - A payment is a fact. It is recorded (always together with its receipt) and never edited; the only correction is to
 *    void its receipt, which voids the payments it proves. `charges.paid_cents` is a DERIVED figure, recomputed from the
 *    live payments inside the same transaction.
 *  - An invoice or receipt is a frozen copy of what was issued. The database refuses to change one; voiding is the only
 *    allowed change, and it keeps the document.
 *  - These documents are shown to employers, family and banks, so they carry no diagnosis, CPT code, tax id or NPI.
 */
import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'
import { type PaymentMethod, formatInvoiceNumber, formatReceiptNumber, serviceDescription } from '../lib/billing-vocab'
import { type Charge, normalizeContactName } from './billing-repo'
import { normalizePractice } from './practice-repo'

type Ctx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

const CHARGE_FOR_DOC = `ch.id, ch.contact_id, ch.service_date::text AS service_date, ch.cpt_code, ch.fee_cents, ch.paid_cents, ch.invoice_id, ch.superbill_id, ch.voided_at`
type ChargeForDoc = Pick<Charge, 'id' | 'contact_id' | 'service_date' | 'cpt_code' | 'fee_cents' | 'paid_cents' | 'invoice_id' | 'superbill_id' | 'voided_at'>

/** The practice's side of a document the client receives: who, where, how to reach them. Nothing else. */
export interface IssuerBlock {
  name: string
  practiceName: string
  address: string
  phone: string
  email: string
}

function issuerFrom(settings: Record<string, unknown> | null | undefined): IssuerBlock {
  const p = normalizePractice(settings?.practice)
  return { name: p.therapist.trim(), practiceName: p.name.trim(), address: p.address.trim(), phone: p.phone.trim(), email: p.email.trim() }
}

/** Next number for this practice and year. The caller already holds the practice's row lock, so two issues cannot collide. */
async function nextNumber(tx: Database, locationId: string, table: 'billing_invoices' | 'billing_receipts', format: (year: number, n: number) => string): Promise<string> {
  const year = new Date().getUTCFullYear()
  const prefix = format(year, 0).replace(/0000$/, '')
  const rows = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE location_id = $1 AND number LIKE $2`, [locationId, `${prefix}%`])
  return format(year, (rows[0]?.n ?? 0) + 1)
}

/**
 * Recompute each charge's derived payment figures from its live payments: the total, the method and the time of the latest.
 * Always called inside the transaction that changed the payments.
 */
async function refreshChargeCaches(tx: Database, locationId: string, chargeIds: string[]): Promise<void> {
  await tx.query(
    `UPDATE charges ch SET paid_cents = p.total, payment_method = p.method, paid_at = p.at
       FROM (
         SELECT c.id,
                COALESCE((SELECT SUM(x.amount_cents) FROM payments x WHERE x.charge_id = c.id AND x.voided_at IS NULL), 0)::int AS total,
                (SELECT x.method FROM payments x WHERE x.charge_id = c.id AND x.voided_at IS NULL ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS method,
                (SELECT x.created_at FROM payments x WHERE x.charge_id = c.id AND x.voided_at IS NULL ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS at
           FROM charges c WHERE c.location_id = $1 AND c.id = ANY($2::text[])
       ) p
      WHERE ch.id = p.id AND ch.location_id = $1`,
    [locationId, chargeIds],
  )
}

// --- receipts and payments ---------------------------------------------------------------------------------------

export interface ReceiptLine {
  chargeId: string
  serviceDate: string
  description: string
  amountCents: number
  /** The charge's full fee, for reference. */
  feeCents: number
  /** What is still owed on this charge after this payment. */
  balanceAfterCents: number
}

export interface ReceiptSnapshot {
  number: string
  issuedAt: string
  paidOn: string
  method: PaymentMethod
  provider: IssuerBlock
  client: { name: string }
  lines: ReceiptLine[]
  /** Numbers of the live invoices these charges are on, so the receipt can say which invoice it pays. */
  invoices: string[]
  totals: { paidCents: number }
}

export interface ReceiptRow {
  id: string
  contact_id: string
  number: string
  method: PaymentMethod
  paid_on: string
  issued_at: string
  issued_by: string
  voided_at: string | null
  void_reason: string | null
  snapshot: ReceiptSnapshot
}

export type ReceiptSummary = Omit<ReceiptRow, 'snapshot'> & { contact_name: string | null; total_cents: number; line_count: number }

export type RecordPaymentError = 'unknown_contact' | 'charges_unavailable' | 'overpaid' | 'paid_mismatch'
export type RecordPaymentResult = { ok: true; receipt: ReceiptRow } | { ok: false; error: RecordPaymentError }

const RECEIPT_COLS = `id, contact_id, number, method, paid_on::text AS paid_on, issued_at, issued_by, voided_at, void_reason`

export class PaymentsRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  async listReceipts(contactId?: string): Promise<ReceiptSummary[]> {
    const rows = await this.db.query<Omit<ReceiptRow, 'snapshot'> & { contact_name: string | null; totals: ReceiptSnapshot['totals']; lines: unknown[] }>(
      `SELECT r.id, r.contact_id, r.number, r.method, r.paid_on::text AS paid_on, r.issued_at, r.issued_by, r.voided_at, r.void_reason,
              c.name AS contact_name, r.snapshot->'totals' AS totals, r.snapshot->'lines' AS lines
         FROM billing_receipts r LEFT JOIN contacts c ON c.id = r.contact_id AND c.location_id = r.location_id
        WHERE r.location_id = $1 ${contactId ? 'AND r.contact_id = $2' : ''}
        ORDER BY r.issued_at DESC LIMIT 500`,
      contactId ? [this.locationId, contactId] : [this.locationId],
    )
    return rows.map(({ totals, lines, ...r }) => ({ ...r, total_cents: totals?.paidCents ?? 0, line_count: Array.isArray(lines) ? lines.length : 0 }))
  }

  async getReceipt(id: string): Promise<ReceiptRow | undefined> {
    return (await this.db.query<ReceiptRow>(`SELECT ${RECEIPT_COLS}, snapshot FROM billing_receipts WHERE location_id = $1 AND id = $2`, [this.locationId, id]))[0]
  }

  /**
   * Record one payment, covering one or more charges of ONE client, and issue its receipt: a single act. Nothing is written
   * unless every line is valid: each charge must be live, this client's, and the amount must fit what is still owed on it.
   */
  async record(
    input: { contactId: string; method: PaymentMethod; paidOn: string; allocations: { chargeId: string; amountCents: number }[] },
    operatorId: string,
    ctx: Ctx,
  ): Promise<RecordPaymentResult> {
    return this.db.transaction(async (tx): Promise<RecordPaymentResult> => {
      const loc = await tx.query<{ settings: Record<string, unknown> | null }>('SELECT settings FROM locations WHERE id = $1 FOR UPDATE', [this.locationId])
      const contact = (await tx.query<{ name: string | null; first_name: string | null; last_name: string | null }>('SELECT name, first_name, last_name FROM contacts WHERE location_id = $1 AND id = $2', [this.locationId, input.contactId]))[0]
      if (!contact) return { ok: false, error: 'unknown_contact' }

      const ids = [...new Set(input.allocations.map((a) => a.chargeId))]
      const charges = await tx.query<ChargeForDoc>(
        `SELECT ${CHARGE_FOR_DOC} FROM charges ch
          WHERE ch.location_id = $1 AND ch.contact_id = $2 AND ch.id = ANY($3::text[]) AND ch.voided_at IS NULL
          ORDER BY ch.id FOR UPDATE`,
        [this.locationId, input.contactId, ids],
      )
      if (charges.length !== ids.length) return { ok: false, error: 'charges_unavailable' }
      const byId = new Map(charges.map((c) => [c.id, c]))

      // The cached total must agree with the payments it is derived from; if it does not (a payment written some other way),
      // refuse rather than overwrite it.
      const sums = await tx.query<{ charge_id: string; total: number }>(
        'SELECT charge_id, COALESCE(SUM(amount_cents), 0)::int AS total FROM payments WHERE charge_id = ANY($1::text[]) AND voided_at IS NULL GROUP BY charge_id',
        [ids],
      )
      const live = new Map(sums.map((r) => [r.charge_id, r.total]))
      for (const c of charges) if (c.paid_cents !== (live.get(c.id) ?? 0)) return { ok: false, error: 'paid_mismatch' }
      for (const a of input.allocations) {
        const c = byId.get(a.chargeId)!
        if (a.amountCents > c.fee_cents - c.paid_cents) return { ok: false, error: 'overpaid' }
      }

      const invoices = await tx.query<{ number: string }>(
        `SELECT DISTINCT i.number FROM billing_invoices i JOIN charges ch ON ch.invoice_id = i.id
          WHERE ch.id = ANY($1::text[]) AND i.voided_at IS NULL ORDER BY i.number`,
        [ids],
      )

      const issuedAt = new Date().toISOString()
      const number = await nextNumber(tx, this.locationId, 'billing_receipts', formatReceiptNumber)
      const lines: ReceiptLine[] = [...input.allocations]
        .sort((x, y) => byId.get(x.chargeId)!.service_date.localeCompare(byId.get(y.chargeId)!.service_date) || x.chargeId.localeCompare(y.chargeId))
        .map((a) => {
          const c = byId.get(a.chargeId)!
          return { chargeId: c.id, serviceDate: c.service_date, description: serviceDescription(c.cpt_code), amountCents: a.amountCents, feeCents: c.fee_cents, balanceAfterCents: c.fee_cents - c.paid_cents - a.amountCents }
        })
      const total = lines.reduce((s, l) => s + l.amountCents, 0)
      const snapshot: ReceiptSnapshot = {
        number, issuedAt, paidOn: input.paidOn, method: input.method,
        provider: issuerFrom(loc[0]?.settings),
        client: { name: normalizeContactName(contact) },
        lines, invoices: invoices.map((i) => i.number), totals: { paidCents: total },
      }

      const receiptId = nanoid()
      await tx.query(
        `INSERT INTO billing_receipts (id, location_id, contact_id, number, method, paid_on, snapshot, issued_at, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [receiptId, this.locationId, input.contactId, number, input.method, input.paidOn, JSON.stringify(snapshot), issuedAt, operatorId],
      )
      for (const a of input.allocations) {
        await tx.query(
          `INSERT INTO payments (id, location_id, contact_id, charge_id, receipt_id, amount_cents, method, paid_on, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [nanoid(), this.locationId, input.contactId, a.chargeId, receiptId, a.amountCents, input.method, input.paidOn, operatorId],
        )
      }
      await refreshChargeCaches(tx, this.locationId, ids)

      await audit(tx, this.locationId, { action: 'payment.recorded', entityType: 'receipt', entityId: receiptId, contactId: input.contactId, details: { number, method: input.method, lines: lines.length, totalCents: total }, ...ctx })
      await audit(tx, this.locationId, { action: 'receipt.issued', entityType: 'receipt', entityId: receiptId, contactId: input.contactId, details: { number }, ...ctx })
      return { ok: true, receipt: (await new PaymentsRepo(tx, this.locationId).getReceipt(receiptId))! }
    })
  }

  /** Void a receipt (with a reason): the payments it proves are voided with it and each charge's paid figure is recomputed. */
  async voidReceipt(id: string, reason: string, operatorId: string, ctx: Ctx): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'voided' }> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<{ contact_id: string; number: string; voided_at: string | null }>('SELECT contact_id, number, voided_at FROM billing_receipts WHERE location_id = $1 AND id = $2 FOR UPDATE', [this.locationId, id]))[0]
      if (!cur) return { ok: false as const, error: 'not_found' as const }
      if (cur.voided_at) return { ok: false as const, error: 'voided' as const }
      const paid = await tx.query<{ charge_id: string }>('SELECT DISTINCT charge_id FROM payments WHERE receipt_id = $1 AND voided_at IS NULL ORDER BY charge_id', [id])
      const chargeIds = paid.map((p) => p.charge_id)
      // Lock the charges first, in a fixed order, so a payment recorded at the same moment cannot interleave.
      if (chargeIds.length > 0) await tx.query('SELECT 1 FROM charges WHERE location_id = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE', [this.locationId, chargeIds])
      await tx.query('UPDATE billing_receipts SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE location_id = $1 AND id = $2', [this.locationId, id, operatorId, reason])
      await tx.query('UPDATE payments SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE location_id = $1 AND receipt_id = $2 AND voided_at IS NULL', [this.locationId, id, operatorId, reason])
      if (chargeIds.length > 0) await refreshChargeCaches(tx, this.locationId, chargeIds)
      await audit(tx, this.locationId, { action: 'receipt.voided', entityType: 'receipt', entityId: id, contactId: cur.contact_id, details: { number: cur.number }, ...ctx }) // the typed reason stays on the receipt, not in the log
      return { ok: true as const }
    })
  }

  async recordAccess(id: string, action: 'receipt.viewed' | 'receipt.printed', ctx: Ctx): Promise<boolean> {
    const row = await this.getReceipt(id)
    if (!row) return false
    await audit(this.db, this.locationId, { action, entityType: 'receipt', entityId: id, contactId: row.contact_id, details: { number: row.number }, ...ctx })
    return true
  }
}

// --- invoices ------------------------------------------------------------------------------------------------------

export interface InvoiceLine {
  chargeId: string
  serviceDate: string
  description: string
  feeCents: number
  /** Already paid when the invoice was issued. */
  paidAtIssueCents: number
  dueCents: number
}

export interface InvoiceSnapshot {
  number: string
  issuedAt: string
  dueOn: string | null
  /** Free text for the client, e.g. how to pay. */
  note: string
  provider: IssuerBlock
  client: { name: string; address: string }
  lines: InvoiceLine[]
  totals: { billedCents: number; paidCents: number; dueCents: number }
}

export interface InvoiceRow {
  id: string
  contact_id: string
  number: string
  due_on: string | null
  issued_at: string
  issued_by: string
  voided_at: string | null
  void_reason: string | null
  snapshot: InvoiceSnapshot
}

/** The state of an invoice is derived from its charges' live payments, never stored: a new payment shows at once. */
export type InvoiceStatus = 'open' | 'paid' | 'void'
export type InvoiceSummary = Omit<InvoiceRow, 'snapshot'> & { contact_name: string | null; status: InvoiceStatus; total_cents: number; paid_cents: number; balance_cents: number; line_count: number }
export type InvoiceDetail = InvoiceRow & { status: InvoiceStatus; paid_cents: number; balance_cents: number; paid_by_charge: Record<string, number> }

export type InvoiceMissing = { code: 'provider_name' | 'practice_address' | 'charge_zero_fee'; chargeId?: string }
export type IssueInvoiceResult =
  | { ok: true; invoice: InvoiceDetail }
  | { ok: false; error: 'unknown_contact' | 'no_charges' | 'charges_unavailable' }
  | { ok: false; error: 'incomplete'; missing: InvoiceMissing[] }

const INVOICE_COLS = `i.id, i.contact_id, i.number, i.due_on::text AS due_on, i.issued_at, i.issued_by, i.voided_at, i.void_reason`

function statusOf(voided: boolean, billed: number, paid: number): InvoiceStatus {
  if (voided) return 'void'
  return billed > 0 && paid >= billed ? 'paid' : 'open'
}

export class BillingInvoicesRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  async list(contactId?: string): Promise<InvoiceSummary[]> {
    const rows = await this.db.query<Omit<InvoiceRow, 'snapshot'> & { contact_name: string | null; totals: InvoiceSnapshot['totals']; lines: unknown[]; live_billed: number; live_paid: number }>(
      `SELECT ${INVOICE_COLS}, c.name AS contact_name, i.snapshot->'totals' AS totals, i.snapshot->'lines' AS lines,
              COALESCE(SUM(ch.fee_cents), 0)::int AS live_billed, COALESCE(SUM(ch.paid_cents), 0)::int AS live_paid
         FROM billing_invoices i
         LEFT JOIN contacts c ON c.id = i.contact_id AND c.location_id = i.location_id
         LEFT JOIN charges ch ON ch.invoice_id = i.id
        WHERE i.location_id = $1 ${contactId ? 'AND i.contact_id = $2' : ''}
        GROUP BY i.id, c.name
        ORDER BY i.issued_at DESC LIMIT 500`,
      contactId ? [this.locationId, contactId] : [this.locationId],
    )
    return rows.map(({ totals, lines, live_billed, live_paid, ...r }) => {
      const voided = Boolean(r.voided_at)
      return {
        ...r,
        status: statusOf(voided, live_billed, live_paid),
        total_cents: totals?.billedCents ?? 0,
        paid_cents: voided ? 0 : live_paid,
        balance_cents: voided ? 0 : live_billed - live_paid,
        line_count: Array.isArray(lines) ? lines.length : 0,
      }
    })
  }

  async get(id: string): Promise<InvoiceDetail | undefined> {
    const row = (await this.db.query<InvoiceRow>(`SELECT ${INVOICE_COLS}, i.snapshot FROM billing_invoices i WHERE i.location_id = $1 AND i.id = $2`, [this.locationId, id]))[0]
    if (!row) return undefined
    const live = await this.db.query<{ id: string; fee_cents: number; paid_cents: number }>('SELECT id, fee_cents, paid_cents FROM charges WHERE location_id = $1 AND invoice_id = $2', [this.locationId, id])
    const billed = live.reduce((s, c) => s + c.fee_cents, 0)
    const paid = live.reduce((s, c) => s + c.paid_cents, 0)
    const voided = Boolean(row.voided_at)
    return { ...row, status: statusOf(voided, billed, paid), paid_cents: voided ? 0 : paid, balance_cents: voided ? 0 : billed - paid, paid_by_charge: Object.fromEntries(live.map((c) => [c.id, c.paid_cents])) }
  }

  /**
   * Issue one invoice for one client from some of their charges that are not already on a live invoice. Read, checked and
   * written in one transaction that holds the practice's row, so two issues at once cannot take the same number or charge.
   */
  async issue(
    input: { contactId: string; chargeIds: string[]; dueOn?: string | null; note?: string; clientAddress?: string },
    operatorId: string,
    ctx: Ctx,
  ): Promise<IssueInvoiceResult> {
    const issued = await this.db.transaction(async (tx): Promise<IssueInvoiceResult | { id: string }> => {
      const loc = await tx.query<{ settings: Record<string, unknown> | null }>('SELECT settings FROM locations WHERE id = $1 FOR UPDATE', [this.locationId])
      const issuer = issuerFrom(loc[0]?.settings)
      const contact = (await tx.query<{ name: string | null; first_name: string | null; last_name: string | null }>('SELECT name, first_name, last_name FROM contacts WHERE location_id = $1 AND id = $2', [this.locationId, input.contactId]))[0]
      if (!contact) return { ok: false, error: 'unknown_contact' }
      const ids = [...new Set(input.chargeIds)]
      if (ids.length === 0) return { ok: false, error: 'no_charges' }

      const charges = await tx.query<ChargeForDoc>(
        `SELECT ${CHARGE_FOR_DOC} FROM charges ch
          WHERE ch.location_id = $1 AND ch.contact_id = $2 AND ch.id = ANY($3::text[]) AND ch.voided_at IS NULL AND ch.invoice_id IS NULL
          ORDER BY ch.service_date, ch.id FOR UPDATE`,
        [this.locationId, input.contactId, ids],
      )
      if (charges.length !== ids.length) return { ok: false, error: 'charges_unavailable' }

      const missing: InvoiceMissing[] = []
      if (!issuer.name) missing.push({ code: 'provider_name' })
      if (!issuer.address) missing.push({ code: 'practice_address' })
      for (const c of charges) if (c.fee_cents <= 0) missing.push({ code: 'charge_zero_fee', chargeId: c.id })
      if (missing.length > 0) return { ok: false, error: 'incomplete', missing }

      const issuedAt = new Date().toISOString()
      const number = await nextNumber(tx, this.locationId, 'billing_invoices', formatInvoiceNumber)
      const lines: InvoiceLine[] = charges.map((c) => ({ chargeId: c.id, serviceDate: c.service_date, description: serviceDescription(c.cpt_code), feeCents: c.fee_cents, paidAtIssueCents: c.paid_cents, dueCents: c.fee_cents - c.paid_cents }))
      const billed = lines.reduce((s, l) => s + l.feeCents, 0)
      const paid = lines.reduce((s, l) => s + l.paidAtIssueCents, 0)
      const snapshot: InvoiceSnapshot = {
        number, issuedAt, dueOn: input.dueOn ?? null, note: (input.note ?? '').trim(),
        provider: issuer,
        client: { name: normalizeContactName(contact), address: (input.clientAddress ?? '').trim() },
        lines, totals: { billedCents: billed, paidCents: paid, dueCents: billed - paid },
      }

      const id = nanoid()
      await tx.query(
        `INSERT INTO billing_invoices (id, location_id, contact_id, number, due_on, snapshot, issued_at, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [id, this.locationId, input.contactId, number, input.dueOn ?? null, JSON.stringify(snapshot), issuedAt, operatorId],
      )
      await tx.query('UPDATE charges SET invoice_id = $3 WHERE location_id = $1 AND id = ANY($2::text[])', [this.locationId, ids, id])
      await audit(tx, this.locationId, { action: 'invoice.issued', entityType: 'invoice', entityId: id, contactId: input.contactId, details: { number, lines: lines.length }, ...ctx })
      return { id }
    })
    if ('ok' in issued) return issued
    return { ok: true, invoice: (await this.get(issued.id))! }
  }

  /** Void an invoice (with a reason). Its charges are released so a corrected one can be issued. The invoice stays. */
  async void(id: string, reason: string, operatorId: string, ctx: Ctx): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'voided' }> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<{ contact_id: string; number: string; voided_at: string | null }>('SELECT contact_id, number, voided_at FROM billing_invoices WHERE location_id = $1 AND id = $2 FOR UPDATE', [this.locationId, id]))[0]
      if (!cur) return { ok: false as const, error: 'not_found' as const }
      if (cur.voided_at) return { ok: false as const, error: 'voided' as const }
      await tx.query('UPDATE billing_invoices SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE location_id = $1 AND id = $2', [this.locationId, id, operatorId, reason])
      await tx.query('UPDATE charges SET invoice_id = NULL WHERE location_id = $1 AND invoice_id = $2', [this.locationId, id])
      await audit(tx, this.locationId, { action: 'invoice.voided', entityType: 'invoice', entityId: id, contactId: cur.contact_id, details: { number: cur.number }, ...ctx }) // the typed reason stays on the invoice, not in the log
      return { ok: true as const }
    })
  }

  async recordAccess(id: string, action: 'invoice.viewed' | 'invoice.printed', ctx: Ctx): Promise<boolean> {
    const row = await this.get(id)
    if (!row) return false
    await audit(this.db, this.locationId, { action, entityType: 'invoice', entityId: id, contactId: row.contact_id, details: { number: row.number }, ...ctx })
    return true
  }
}

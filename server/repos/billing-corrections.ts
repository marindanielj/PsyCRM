/**
 * Correcting mistakes in billing (requested 17 Nov 2026): see who paid a charge, take a charge out of a payment, and
 * delete (void) a charge together with whatever stands in the way. Nothing is erased: every step is a void with a reason,
 * so the record and the audit log still show what happened. Each operation is one transaction: all of it or none.
 */
import type { Database } from '../db/database'
import type { AuditEntry } from '../lib/audit'
import { BillingInvoicesRepo, PaymentsRepo, type ReceiptRow } from './billing-documents-repo'
import { type Charge, type ChargeResult, ChargesRepo, SuperbillsRepo } from './billing-repo'

type Ctx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

/** A live payment on a charge, with the receipt that proves it. */
export interface ChargePayment {
  receipt_id: string
  receipt_number: string
  paid_on: string
  method: string
  amount_cents: number
  /** How many charges the whole receipt covers (1 = only this one). */
  receipt_charge_count: number
  receipt_total_cents: number
}

/** Rolls the transaction back while carrying a clean error code out of it. */
class Abort extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export class BillingCorrections {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  async paymentsForCharge(chargeId: string): Promise<ChargePayment[] | null> {
    const exists = await this.db.query('SELECT 1 FROM charges WHERE location_id = $1 AND id = $2', [this.locationId, chargeId])
    if (exists.length === 0) return null
    return this.db.query<ChargePayment>(
      `SELECT r.id AS receipt_id, r.number AS receipt_number, r.paid_on::text AS paid_on, r.method, p.amount_cents,
              (SELECT count(DISTINCT p2.charge_id)::int FROM payments p2 WHERE p2.receipt_id = r.id AND p2.voided_at IS NULL) AS receipt_charge_count,
              (SELECT coalesce(sum(p3.amount_cents), 0)::int FROM payments p3 WHERE p3.receipt_id = r.id AND p3.voided_at IS NULL) AS receipt_total_cents
         FROM payments p JOIN billing_receipts r ON r.id = p.receipt_id AND r.location_id = p.location_id
        WHERE p.location_id = $1 AND p.charge_id = $2 AND p.voided_at IS NULL AND r.voided_at IS NULL
        ORDER BY r.paid_on, r.number`,
      [this.locationId, chargeId],
    )
  }

  /**
   * Take one charge out of a payment ("desasignar"). A receipt is proof of a payment and cannot be rewritten, so the receipt
   * is voided and, if it also paid other charges, those are recorded again as a new receipt with the same date, method
   * and amounts. The charge taken out becomes unpaid by that amount.
   */
  async removeChargeFromReceipt(
    receiptId: string,
    chargeId: string,
    reason: string,
    operatorId: string,
    ctx: Ctx,
  ): Promise<{ ok: true; voided: string; newReceipt: ReceiptRow | null } | { ok: false; error: 'not_found' | 'voided' | 'not_on_receipt' }> {
    try {
      return await this.db.transaction(async (tx) => {
        const receipt = (await tx.query<{ number: string; contact_id: string; voided_at: string | null }>(
          'SELECT number, contact_id, voided_at FROM billing_receipts WHERE location_id = $1 AND id = $2 FOR UPDATE',
          [this.locationId, receiptId],
        ))[0]
        if (!receipt) throw new Abort('not_found')
        if (receipt.voided_at) throw new Abort('voided')
        const lines = await tx.query<{ charge_id: string; amount_cents: number; method: string; paid_on: string }>(
          'SELECT charge_id, amount_cents, method, paid_on::text AS paid_on FROM payments WHERE location_id = $1 AND receipt_id = $2 AND voided_at IS NULL ORDER BY created_at, id',
          [this.locationId, receiptId],
        )
        if (!lines.some((l) => l.charge_id === chargeId)) throw new Abort('not_on_receipt')

        const payments = new PaymentsRepo(tx, this.locationId)
        const voided = await payments.voidReceipt(receiptId, reason, operatorId, ctx)
        if (!voided.ok) throw new Abort(voided.error)

        const rest = lines.filter((l) => l.charge_id !== chargeId)
        let newReceipt: ReceiptRow | null = null
        if (rest.length > 0) {
          const again = await payments.record(
            { contactId: receipt.contact_id, method: rest[0]!.method as never, paidOn: rest[0]!.paid_on, allocations: rest.map((l) => ({ chargeId: l.charge_id, amountCents: l.amount_cents })) },
            operatorId,
            ctx,
          )
          if (!again.ok) throw new Abort(again.error)
          newReceipt = again.receipt
        }
        return { ok: true as const, voided: receipt.number, newReceipt }
      })
    } catch (e) {
      if (e instanceof Abort) return { ok: false, error: e.code as 'not_found' | 'voided' | 'not_on_receipt' }
      throw e
    }
  }

  /**
   * Delete (void) a charge entered by mistake. Without `cascade`, the usual rules answer (void its receipt / invoice /
   * superbill first). With `cascade`, those are voided too, with the same reason, in the same transaction: the receipts
   * that paid it (other charges on those receipts become unpaid), its invoice and its superbill (their other charges are
   * freed to go on a new one).
   */
  async deleteCharge(chargeId: string, reason: string, operatorId: string, ctx: Ctx, opts: { cascade?: boolean } = {}): Promise<ChargeResult & { voidedDocuments?: string[] }> {
    if (!opts.cascade) return new ChargesRepo(this.db, this.locationId).void(chargeId, reason, operatorId, ctx)
    try {
      return await this.db.transaction(async (tx) => {
        const cur = (await tx.query<Charge>('SELECT id, voided_at, invoice_id, superbill_id FROM charges WHERE location_id = $1 AND id = $2 FOR UPDATE', [this.locationId, chargeId]))[0]
        if (!cur) throw new Abort('not_found')
        if (cur.voided_at) throw new Abort('voided')
        const done: string[] = []
        const receipts = await tx.query<{ id: string; number: string }>(
          `SELECT DISTINCT r.id, r.number FROM payments p JOIN billing_receipts r ON r.id = p.receipt_id
            WHERE p.location_id = $1 AND p.charge_id = $2 AND p.voided_at IS NULL AND r.voided_at IS NULL ORDER BY r.number`,
          [this.locationId, chargeId],
        )
        for (const r of receipts) {
          const v = await new PaymentsRepo(tx, this.locationId).voidReceipt(r.id, reason, operatorId, ctx)
          if (!v.ok) throw new Abort(v.error)
          done.push(r.number)
        }
        if (cur.invoice_id) {
          const [inv] = await tx.query<{ number: string; voided_at: string | null }>('SELECT number, voided_at FROM billing_invoices WHERE id = $1', [cur.invoice_id])
          if (inv && !inv.voided_at) {
            const v = await new BillingInvoicesRepo(tx, this.locationId).void(cur.invoice_id, reason, operatorId, ctx)
            if (!v.ok) throw new Abort(v.error)
            done.push(inv.number)
          }
        }
        if (cur.superbill_id) {
          const [sb] = await tx.query<{ number: string; voided_at: string | null }>('SELECT number, voided_at FROM superbills WHERE id = $1', [cur.superbill_id])
          if (sb && !sb.voided_at) {
            const v = await new SuperbillsRepo(tx, this.locationId).void(cur.superbill_id, reason, operatorId, ctx)
            if (!v.ok) throw new Abort(v.error)
            done.push(sb.number)
          }
        }
        const r = await new ChargesRepo(tx, this.locationId).void(chargeId, reason, operatorId, ctx)
        if (!r.ok) throw new Abort(r.error)
        return { ...r, voidedDocuments: done }
      })
    } catch (e) {
      if (e instanceof Abort) return { ok: false, error: e.code as never }
      throw e
    }
  }
}

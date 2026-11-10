import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { auditContext } from '../lib/audit'
import { PAYMENT_METHODS } from '../lib/billing-vocab'
import { BillingInvoicesRepo, type RecordPaymentError, PaymentsRepo } from '../repos/billing-documents-repo'

const MAX_MONEY_CENTS = 100_000_00
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'invalid date')
/** A payment is recorded after it happens. One day of slack covers every time zone. */
const notInTheFuture = (s: string) => s <= new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10)

const paymentSchema = z
  .object({
    contactId: z.string().min(1),
    method: z.enum(PAYMENT_METHODS),
    paidOn: isoDate.refine(notInTheFuture, 'future_date'),
    allocations: z.array(z.object({ chargeId: z.string().min(1), amountCents: z.number().int().min(1).max(MAX_MONEY_CENTS) })).min(1).max(50),
  })
  .refine((v) => new Set(v.allocations.map((a) => a.chargeId)).size === v.allocations.length, { message: 'duplicate_charge', path: ['allocations'] })

const invoiceSchema = z.object({
  contactId: z.string().min(1),
  chargeIds: z.array(z.string().min(1)).min(1).max(200),
  dueOn: isoDate.nullable().optional(),
  note: z.string().trim().max(300).optional(),
  clientAddress: z.string().trim().max(300).optional(),
})

const reason = z.object({ reason: z.string().trim().min(3).max(300) })
const byContact = z.object({ contactId: z.string().optional() })

const PAYMENT_STATUS: Record<RecordPaymentError, 404 | 409 | 422> = { unknown_contact: 404, charges_unavailable: 409, overpaid: 422, paid_mismatch: 409 }

/**
 * Payments, receipts and invoices, mounted inside the billing routes (so under /api/loc/:loc/billing, behind operatorAuth,
 * locationAccess and the `billing` module). See docs/psycrm/specs/extra-billing-invoices-receipts.md.
 *
 * Recording a payment ALWAYS issues its receipt: one act, one number. This only writes down money that already changed
 * hands; nothing here charges a card, and nothing is sent anywhere (these documents are shown in the app and printed).
 */
export function billingDocumentsRoute(deps: { db: Database }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const payments = (c: Context<AppEnv>) => new PaymentsRepo(deps.db, c.get('locationId'))
  const invoices = (c: Context<AppEnv>) => new BillingInvoicesRepo(deps.db, c.get('locationId'))
  const ctx = auditContext

  // --- payments (and their receipts) ---------------------------------------------------------------------------------

  app.post('/payments', zValidator('json', paymentSchema), async (c) => {
    const r = await payments(c).record(c.req.valid('json'), c.get('operatorId'), ctx(c))
    return r.ok ? c.json({ ok: true, receipt: r.receipt }, 201) : c.json({ error: r.error }, PAYMENT_STATUS[r.error])
  })

  app.get('/receipts', zValidator('query', byContact), async (c) => c.json({ receipts: await payments(c).listReceipts(c.req.valid('query').contactId) }))

  app.get('/receipts/:id', async (c) => {
    const repo = payments(c)
    const row = await repo.getReceipt(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    await repo.recordAccess(row.id, 'receipt.viewed', ctx(c))
    return c.json({ receipt: row })
  })

  app.post('/receipts/:id/printed', async (c) => ((await payments(c).recordAccess(c.req.param('id'), 'receipt.printed', ctx(c))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)))

  app.post('/receipts/:id/void', zValidator('json', reason), async (c) => {
    const r = await payments(c).voidReceipt(c.req.param('id'), c.req.valid('json').reason, c.get('operatorId'), ctx(c))
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
  })

  // --- invoices ------------------------------------------------------------------------------------------------------

  app.get('/invoices', zValidator('query', byContact), async (c) => c.json({ invoices: await invoices(c).list(c.req.valid('query').contactId) }))

  app.post('/invoices', zValidator('json', invoiceSchema), async (c) => {
    const r = await invoices(c).issue(c.req.valid('json'), c.get('operatorId'), ctx(c))
    if (r.ok) return c.json({ ok: true, invoice: r.invoice }, 201)
    if (r.error === 'incomplete') return c.json({ error: 'incomplete', missing: r.missing }, 422)
    return c.json({ error: r.error }, r.error === 'unknown_contact' ? 404 : r.error === 'charges_unavailable' ? 409 : 422)
  })

  app.get('/invoices/:id', async (c) => {
    const repo = invoices(c)
    const row = await repo.get(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    await repo.recordAccess(row.id, 'invoice.viewed', ctx(c))
    return c.json({ invoice: row })
  })

  app.post('/invoices/:id/printed', async (c) => ((await invoices(c).recordAccess(c.req.param('id'), 'invoice.printed', ctx(c))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)))

  app.post('/invoices/:id/void', zValidator('json', reason), async (c) => {
    const r = await invoices(c).void(c.req.param('id'), c.req.valid('json').reason, c.get('operatorId'), ctx(c))
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
  })

  return app
}

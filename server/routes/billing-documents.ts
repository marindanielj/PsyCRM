import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { auditContext } from '../lib/audit'
import { PAYMENT_METHODS } from '../lib/billing-vocab'
import { sendBillingLinkEmail } from '../lib/document-mail'
import { newToken, hashToken } from '../lib/document-tokens'
import { SlidingWindowRateLimiter } from '../lib/rate-limit'
import { type ResolvedEmailSender, resolveEmailSender } from '../lib/sending/resolve'
import { displayName } from '../repos/branding-repo'
import { BillingInvoicesRepo, type RecordPaymentError, PaymentsRepo } from '../repos/billing-documents-repo'
import { BillingSharesRepo, SHARE_TTL_DAYS, type ShareKind } from '../repos/billing-shares-repo'

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

const sendSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) })
const reason = z.object({ reason: z.string().trim().min(3).max(300) })
const byContact = z.object({ contactId: z.string().optional() })

const PAYMENT_STATUS: Record<RecordPaymentError, 404 | 409 | 422> = { unknown_contact: 404, charges_unavailable: 409, overpaid: 422, paid_mismatch: 409 }

/**
 * Payments, receipts and invoices, mounted inside the billing routes (so under /api/loc/:loc/billing, behind operatorAuth,
 * locationAccess and the `billing` module). See docs/psycrm/specs/extra-billing-invoices-receipts.md.
 *
 * Recording a payment ALWAYS issues its receipt: one act, one number. This only writes down money that already changed
 * hands; nothing here charges a card. An invoice or receipt can be emailed to the client as a link behind a one-time code.
 */
export function billingDocumentsRoute(deps: {
  db: Database
  /** Builds the practice's email sender; injectable so tests and dev need no provider. */
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  publicBaseUrl?: string
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  // A therapist sends a handful of documents an hour; this only stops a stolen session from using the practice's email as a relay.
  const sendsPerPractice = new SlidingWindowRateLimiter(30, 60 * 60_000)
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

  // --- emailing an invoice or a receipt to the client -----------------------------------------------------------------
  // The email carries a link only; the page behind it asks for a code sent to the same address. A superbill is never sent.
  async function emailDocument(c: Context<AppEnv>, kind: ShareKind, email: string) {
    const loc = c.get('locationId')
    const id = c.req.param('id') ?? ''
    const doc = kind === 'invoice' ? await invoices(c).get(id) : await payments(c).getReceipt(id)
    if (!doc) return c.json({ error: 'not found' }, 404)
    if (doc.voided_at) return c.json({ error: 'voided' }, 409)
    const shares = new BillingSharesRepo(deps.db, loc)
    const onFile = ((await shares.contactEmails(doc.contact_id)) ?? []).map((e) => e.trim().toLowerCase())
    if (!onFile.includes(email)) return c.json({ error: 'email_not_on_file' }, 422)
    if (!sendsPerPractice.check(loc, Date.now()).allowed) return c.json({ error: 'rate_limited' }, 429)

    const token = newToken()
    const shareId = await shares.create({ kind, documentId: doc.id, contactId: doc.contact_id, email, tokenHash: hashToken(token), createdBy: c.get('operatorId'), number: doc.number }, ctx(c))
    const sender = await (deps.resolveEmail ?? resolveEmailSender)(deps.db, loc)
    const base = (deps.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/$/, '')
    const name = (await displayName(deps.db, loc)) || 'Su terapeuta'
    const clientName = doc.snapshot.client.name
    const r = await sendBillingLinkEmail(sender.ok ? sender.sender : null, sender.ok ? undefined : sender.reason, { practice: name, to: email, name: clientName, kind, link: `${base}/b/${token}`, days: SHARE_TTL_DAYS })
    if (r.sent) return c.json({ ok: true, emailed: true })
    // Nobody received this link, so it must not stay alive.
    await shares.remove(shareId)
    return c.json({ error: 'email_unavailable', reason: r.reason }, 503)
  }

  app.post('/invoices/:id/send', zValidator('json', sendSchema), (c) => emailDocument(c, 'invoice', c.req.valid('json').email))
  app.post('/receipts/:id/send', zValidator('json', sendSchema), (c) => emailDocument(c, 'receipt', c.req.valid('json').email))

  return app
}

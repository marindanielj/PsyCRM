import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { auditContext } from '../lib/audit'
import {
  COMMON_CPT,
  CPT_PATTERN,
  MAX_DIAGNOSES,
  MODIFIERS,
  MODIFIER_PATTERN,
  PAYMENT_METHODS,
  PLACES_OF_SERVICE,
  POS_PATTERN,
  isValidIcd10,
  isValidNpi,
  normalizeIcd10,
  normalizeTaxId,
  parseMoneyToCents,
} from '../lib/billing-vocab'
import { PracticeRepo } from '../repos/practice-repo'
import { billingDocumentsRoute } from './billing-documents'
import {
  BillingProfileRepo,
  type ChargeError,
  ChargesRepo,
  SuperbillsRepo,
} from '../repos/billing-repo'

const MAX_MONEY_CENTS = 100_000_00 // $100,000 on one line is a typo, not a session
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'invalid date')

const icd10 = z
  .string()
  .transform(normalizeIcd10)
  .refine(isValidIcd10, 'invalid_icd10')
const diagnosisCodes = z.array(icd10).max(MAX_DIAGNOSES).transform((codes) => [...new Set(codes)])

const chargeFields = {
  serviceDate: isoDate,
  cptCode: z.string().trim().toUpperCase().regex(CPT_PATTERN, 'invalid_cpt'),
  modifiers: z.array(z.string().trim().toUpperCase().regex(MODIFIER_PATTERN, 'invalid_modifier')).max(4),
  placeOfService: z.string().regex(POS_PATTERN, 'invalid_pos'),
  units: z.number().int().min(1).max(99),
  diagnosisCodes,
  feeCents: z.number().int().min(0).max(MAX_MONEY_CENTS),
}

const createChargeSchema = z.object({
  contactId: z.string().min(1),
  ...chargeFields,
  modifiers: chargeFields.modifiers.default([]),
  units: chargeFields.units.default(1),
  appointmentId: z.string().min(1).nullable().optional(),
  sessionNoteId: z.string().min(1).nullable().optional(),
})

const patchChargeSchema = z.object({
  serviceDate: chargeFields.serviceDate.optional(),
  cptCode: chargeFields.cptCode.optional(),
  modifiers: chargeFields.modifiers.optional(),
  placeOfService: chargeFields.placeOfService.optional(),
  units: chargeFields.units.optional(),
  diagnosisCodes: chargeFields.diagnosisCodes.optional(),
  feeCents: chargeFields.feeCents.optional(),
})

const reason = z.object({ reason: z.string().trim().min(3).max(300) })

const issueSchema = z.object({
  contactId: z.string().min(1),
  chargeIds: z.array(z.string().min(1)).min(1).max(200),
  clientAddress: z.string().trim().max(300).optional(),
  memberId: z.string().trim().max(60).optional(),
})

const profileSchema = z.object({
  npi: z.string().trim().max(10).optional(),
  taxonomy: z.string().trim().toUpperCase().max(10).optional(),
  telehealthPos: z.enum(['10', '02']).optional(),
  /** A new tax id, or null to remove it. Write-only: it is never returned. */
  taxId: z.string().trim().max(20).nullable().optional(),
  fees: z.record(z.string(), z.number().int().min(0).max(MAX_MONEY_CENTS)).optional(),
})

const STATUS: Record<ChargeError, 400 | 404 | 409 | 422> = {
  not_found: 404,
  voided: 409,
  issued: 409,
  has_payments: 409,
  overpaid: 422,
  unknown_contact: 422,
  unknown_note: 422,
  unknown_appointment: 422,
  note_already_charged: 409,
  nothing_to_change: 400,
}

/**
 * Charges and superbills, at /api/loc/:loc/billing behind operatorAuth + locationAccess + the `billing` module.
 *
 * This only WRITES DOWN what already happened: it never charges a card or moves money, and nothing here leaves the
 * system. A superbill carries health information, so it is shown inside the app and is never sent by email.
 */
export function billingRoute(deps: { db: Database; secret: string }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const profile = (c: Context<AppEnv>) => new BillingProfileRepo(deps.db, c.get('locationId'))
  const charges = (c: Context<AppEnv>) => new ChargesRepo(deps.db, c.get('locationId'))
  const superbills = (c: Context<AppEnv>) => new SuperbillsRepo(deps.db, c.get('locationId'))
  const ctx = auditContext

  // What the forms offer.
  app.get('/meta', (c) => c.json({ cpt: COMMON_CPT, modifiers: MODIFIERS, placesOfService: PLACES_OF_SERVICE, paymentMethods: PAYMENT_METHODS, maxDiagnoses: MAX_DIAGNOSES }))

  // --- the billing profile -------------------------------------------------------------------------------------------

  app.get('/profile', async (c) => c.json({ profile: await profile(c).get() }))

  app.put('/profile', zValidator('json', profileSchema), async (c) => {
    const body = c.req.valid('json')
    if (body.npi !== undefined && body.npi !== '' && !isValidNpi(body.npi)) return c.json({ error: 'invalid_npi' }, 422)
    if (body.taxonomy !== undefined && body.taxonomy !== '' && !/^[0-9A-Z]{10}$/.test(body.taxonomy)) return c.json({ error: 'invalid_taxonomy' }, 422)
    for (const code of Object.keys(body.fees ?? {})) if (!CPT_PATTERN.test(code)) return c.json({ error: 'invalid_cpt' }, 422)
    let taxId: { digits: string; type: 'ein' | 'ssn' } | null | undefined
    if (body.taxId === null || body.taxId === '') taxId = null
    else if (body.taxId !== undefined) {
      const parsed = normalizeTaxId(body.taxId)
      if (!parsed) return c.json({ error: 'invalid_tax_id' }, 422)
      taxId = parsed
    }
    const saved = await profile(c).save({ npi: body.npi, taxonomy: body.taxonomy, telehealthPos: body.telehealthPos, taxId, fees: body.fees }, deps.secret, ctx(c))
    return c.json({ ok: true, profile: saved })
  })

  // --- charges -------------------------------------------------------------------------------------------------------

  // Signed notes without a charge, pre-filled for review.
  app.get('/suggestions', async (c) => {
    const practice = await new PracticeRepo(deps.db, c.get('locationId')).get()
    const fallback = { session: parseMoneyToCents(practice.fees.session), intake: parseMoneyToCents(practice.fees.intake) }
    return c.json({ suggestions: await charges(c).suggestions(await profile(c).get(), fallback) })
  })

  app.get('/charges', zValidator('query', z.object({ contactId: z.string().optional(), status: z.enum(['active', 'unpaid', 'paid', 'void', 'all']).optional() })), async (c) => {
    return c.json({ charges: await charges(c).list(c.req.valid('query')) })
  })

  app.post('/charges', zValidator('json', createChargeSchema), async (c) => {
    const r = await charges(c).create(c.req.valid('json'), c.get('operatorId'), ctx(c))
    return r.ok ? c.json({ ok: true, charge: r.charge }, 201) : c.json({ error: r.error }, STATUS[r.error])
  })

  app.patch('/charges/:id', zValidator('json', patchChargeSchema), async (c) => {
    const r = await charges(c).update(c.req.param('id'), c.req.valid('json'), ctx(c))
    return r.ok ? c.json({ ok: true, charge: r.charge }) : c.json({ error: r.error }, STATUS[r.error])
  })

  app.post('/charges/:id/void', zValidator('json', reason), async (c) => {
    const r = await charges(c).void(c.req.param('id'), c.req.valid('json').reason, c.get('operatorId'), ctx(c))
    return r.ok ? c.json({ ok: true, charge: r.charge }) : c.json({ error: r.error }, STATUS[r.error])
  })

  // --- superbills ----------------------------------------------------------------------------------------------------

  app.get('/superbills', zValidator('query', z.object({ contactId: z.string().optional() })), async (c) => {
    return c.json({ superbills: await superbills(c).list(c.req.valid('query').contactId) })
  })

  app.post('/superbills', zValidator('json', issueSchema), async (c) => {
    const r = await superbills(c).issue(c.req.valid('json'), c.get('operatorId'), ctx(c))
    if (r.ok) return c.json({ ok: true, superbill: shape(r.superbill, superbills(c), deps.secret) }, 201)
    if (r.error === 'incomplete') return c.json({ error: 'incomplete', missing: r.missing }, 422)
    return c.json({ error: r.error }, r.error === 'unknown_contact' ? 404 : r.error === 'charges_unavailable' ? 409 : 422)
  })

  app.get('/superbills/:id', async (c) => {
    const repo = superbills(c)
    const row = await repo.get(c.req.param('id'))
    if (!row) return c.json({ error: 'not found' }, 404)
    await repo.recordAccess(row.id, 'superbill.viewed', ctx(c))
    return c.json({ superbill: shape(row, repo, deps.secret) })
  })

  app.post('/superbills/:id/printed', async (c) => {
    return (await superbills(c).recordAccess(c.req.param('id'), 'superbill.printed', ctx(c))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })

  app.post('/superbills/:id/void', zValidator('json', reason), async (c) => {
    const r = await superbills(c).void(c.req.param('id'), c.req.valid('json').reason, c.get('operatorId'), ctx(c))
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
  })

  // Payments (each with its receipt) and invoices.
  app.route('/', billingDocumentsRoute({ db: deps.db }))

  return app
}

/** What the browser gets: the frozen content with the tax id opened for display, and never the sealed copy. */
function shape(row: NonNullable<Awaited<ReturnType<SuperbillsRepo['get']>>>, repo: SuperbillsRepo, secret: string) {
  const { taxIdSealed: _sealed, ...provider } = row.snapshot.provider
  const taxId = repo.openTaxId(row.snapshot, secret)
  return {
    ...row,
    snapshot: { ...row.snapshot, provider: { ...provider, taxId: taxId ?? (provider.taxIdLast4 ? formatMasked(provider.taxIdType, provider.taxIdLast4) : null) } },
  }
}

const formatMasked = (type: 'ein' | 'ssn', last4: string) => (type === 'ein' ? `••-•••${last4}` : `•••-••-${last4}`)


import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'
import {
  COMMON_CPT,
  MAX_DIAGNOSES,
  type PaymentMethod,
  type TelehealthPos,
  diagnosisPointers,
  formatSuperbillNumber,
  formatTaxId,
  suggestCpt,
  suggestPlace,
} from '../lib/billing-vocab'
import { isUniqueViolation } from '../lib/db-errors'
import { open, seal } from '../lib/secret-box'
import { normalizePractice } from './practice-repo'

type Ctx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

export const TAX_ID_SEAL_LABEL = 'billing-tax-id'

/** The name a document shows for a client: the full name if there is one, else first and last. */
export function normalizeContactName(c: { name: string | null; first_name: string | null; last_name: string | null }): string {
  return (c.name ?? `${c.first_name ?? ''} ${c.last_name ?? ''}`).trim()
}

// --- the billing profile ----------------------------------------------------------------------------------------

export interface BillingProfile {
  npi: string
  taxonomy: string
  telehealthPos: TelehealthPos
  /** Never the number itself: only whether one is saved, its kind and its last four digits. */
  hasTaxId: boolean
  taxIdType: 'ein' | 'ssn' | null
  taxIdLast4: string | null
  /** Default fee per CPT code, in cents. */
  fees: Record<string, number>
}

export interface BillingProfilePatch {
  npi?: string
  taxonomy?: string
  telehealthPos?: TelehealthPos
  /** The new tax id (digits and kind), or null to remove it. */
  taxId?: { digits: string; type: 'ein' | 'ssn' } | null
  fees?: Record<string, number>
}

interface StoredBilling {
  npi?: unknown
  taxonomy?: unknown
  telehealthPos?: unknown
  taxIdSealed?: unknown
  taxIdType?: unknown
  taxIdLast4?: unknown
  fees?: unknown
}

export function normalizeBilling(raw: unknown): BillingProfile {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as StoredBilling
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const fees: Record<string, number> = {}
  if (typeof r.fees === 'object' && r.fees !== null) {
    for (const [k, v] of Object.entries(r.fees as Record<string, unknown>)) if (Number.isInteger(v) && (v as number) >= 0) fees[k] = v as number
  }
  const hasTaxId = typeof r.taxIdSealed === 'string' && r.taxIdSealed.length > 0
  return {
    npi: str(r.npi),
    taxonomy: str(r.taxonomy),
    telehealthPos: r.telehealthPos === '02' ? '02' : '10',
    hasTaxId,
    taxIdType: hasTaxId && (r.taxIdType === 'ein' || r.taxIdType === 'ssn') ? r.taxIdType : null,
    taxIdLast4: hasTaxId && typeof r.taxIdLast4 === 'string' && /^\d{4}$/.test(r.taxIdLast4) ? r.taxIdLast4 : null,
    fees,
  }
}

export class BillingProfileRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  private async stored(db: Database = this.db, lock = false): Promise<{ billing: StoredBilling; practice: unknown }> {
    const rows = await db.query<{ settings: Record<string, unknown> | null }>(`SELECT settings FROM locations WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [this.locationId])
    const s = rows[0]?.settings ?? {}
    return { billing: (typeof s.billing === 'object' && s.billing !== null ? s.billing : {}) as StoredBilling, practice: s.practice }
  }

  async get(): Promise<BillingProfile> {
    return normalizeBilling((await this.stored()).billing)
  }

  /** The sealed tax id exactly as stored (for copying into a superbill), or null. */
  async sealedTaxId(): Promise<string | null> {
    const { billing } = await this.stored()
    return typeof billing.taxIdSealed === 'string' && billing.taxIdSealed ? billing.taxIdSealed : null
  }

  async save(patch: BillingProfilePatch, secret: string, ctx: Ctx): Promise<BillingProfile> {
    return this.db.transaction(async (tx) => {
      const { billing } = await this.stored(tx, true)
      const next: Record<string, unknown> = { ...billing }
      const changed: string[] = []
      if (patch.npi !== undefined && patch.npi !== (billing.npi ?? '')) {
        next.npi = patch.npi
        changed.push('npi')
      }
      if (patch.taxonomy !== undefined && patch.taxonomy !== (billing.taxonomy ?? '')) {
        next.taxonomy = patch.taxonomy
        changed.push('taxonomy')
      }
      if (patch.telehealthPos !== undefined && patch.telehealthPos !== normalizeBilling(billing).telehealthPos) {
        next.telehealthPos = patch.telehealthPos
        changed.push('telehealth_pos')
      }
      if (patch.taxId !== undefined) {
        if (patch.taxId === null) {
          // Removing one that is not there changes nothing, so it is not logged as a change.
          if (normalizeBilling(billing).hasTaxId) changed.push('tax_id')
          delete next.taxIdSealed
          delete next.taxIdType
          delete next.taxIdLast4
        } else {
          next.taxIdSealed = seal(formatTaxId(patch.taxId.digits, patch.taxId.type), secret, TAX_ID_SEAL_LABEL)
          next.taxIdType = patch.taxId.type
          next.taxIdLast4 = patch.taxId.digits.slice(-4)
          changed.push('tax_id')
        }
      }
      if (patch.fees !== undefined && JSON.stringify(patch.fees) !== JSON.stringify(normalizeBilling(billing).fees)) {
        next.fees = patch.fees
        changed.push('fees')
      }
      if (changed.length > 0) {
        await tx.query(`UPDATE locations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{billing}', $2::jsonb, true) WHERE id = $1`, [this.locationId, JSON.stringify(next)])
        // The tax id's value is never written to the log, only that it changed.
        await audit(tx, this.locationId, { action: 'billing.profile_updated', entityType: 'location', entityId: this.locationId, details: { fields: changed }, ...ctx })
      }
      return normalizeBilling(next)
    })
  }
}

// --- charges ----------------------------------------------------------------------------------------------------

export interface Charge {
  id: string
  location_id: string
  contact_id: string
  appointment_id: string | null
  session_note_id: string | null
  service_date: string
  cpt_code: string
  modifiers: string[]
  place_of_service: string
  units: number
  diagnosis_codes: string[]
  fee_cents: number
  paid_cents: number
  paid_at: string | null
  payment_method: PaymentMethod | null
  superbill_id: string | null
  invoice_id: string | null
  created_by: string
  created_at: string
  updated_at: string
  voided_at: string | null
  void_reason: string | null
}

export type ChargeWithClient = Charge & { contact_name: string | null; superbill_number: string | null; invoice_number: string | null }

const CHARGE_COLS = `ch.id, ch.location_id, ch.contact_id, ch.appointment_id, ch.session_note_id, ch.service_date::text AS service_date, ch.cpt_code,
  ch.modifiers, ch.place_of_service, ch.units, ch.diagnosis_codes, ch.fee_cents, ch.paid_cents, ch.paid_at, ch.payment_method, ch.superbill_id, ch.invoice_id,
  ch.created_by, ch.created_at, ch.updated_at, ch.voided_at, ch.void_reason`

export interface ChargeInput {
  contactId: string
  serviceDate: string
  cptCode: string
  modifiers: string[]
  placeOfService: string
  units: number
  diagnosisCodes: string[]
  feeCents: number
  appointmentId?: string | null
  sessionNoteId?: string | null
}

export type ChargePatch = Partial<Pick<ChargeInput, 'serviceDate' | 'cptCode' | 'modifiers' | 'placeOfService' | 'units' | 'diagnosisCodes' | 'feeCents'>>

export type ChargeError = 'not_found' | 'voided' | 'issued' | 'has_payments' | 'overpaid' | 'unknown_contact' | 'unknown_note' | 'unknown_appointment' | 'note_already_charged' | 'nothing_to_change'
export type ChargeResult = { ok: true; charge: Charge } | { ok: false; error: ChargeError }

/** What the therapist is offered for a signed note that has no charge yet: everything pre-filled, nothing fixed. */
export interface ChargeSuggestion {
  note_id: string
  contact_id: string
  contact_name: string | null
  appointment_id: string | null
  service_date: string
  session_type: string
  modality: string
  duration_min: number | null
  cpt_code: string | null
  modifiers: string[]
  place_of_service: string
  diagnosis_codes: string[]
  fee_cents: number | null
}

export class ChargesRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  /**
   * `active` (the default) = not voided; `unpaid` / `paid` = active with / without a balance left; `void`; `all`.
   * Whether a charge is already on a superbill or an invoice is shown on each row rather than used to filter: it can be on both.
   */
  async list(opts: { contactId?: string; status?: 'active' | 'unpaid' | 'paid' | 'void' | 'all' } = {}): Promise<ChargeWithClient[]> {
    const where = ['ch.location_id = $1']
    const params: unknown[] = [this.locationId]
    if (opts.contactId) {
      params.push(opts.contactId)
      where.push(`ch.contact_id = $${params.length}`)
    }
    switch (opts.status ?? 'active') {
      case 'active': where.push('ch.voided_at IS NULL'); break
      case 'unpaid': where.push('ch.voided_at IS NULL AND ch.paid_cents < ch.fee_cents'); break
      case 'paid': where.push('ch.voided_at IS NULL AND ch.paid_cents >= ch.fee_cents'); break
      case 'void': where.push('ch.voided_at IS NOT NULL'); break
      default: break
    }
    return this.db.query<ChargeWithClient>(
      `SELECT ${CHARGE_COLS}, c.name AS contact_name, s.number AS superbill_number, i.number AS invoice_number
         FROM charges ch
         LEFT JOIN contacts c ON c.id = ch.contact_id AND c.location_id = ch.location_id
         LEFT JOIN superbills s ON s.id = ch.superbill_id
         LEFT JOIN billing_invoices i ON i.id = ch.invoice_id
        WHERE ${where.join(' AND ')}
        ORDER BY ch.service_date DESC, ch.created_at DESC
        LIMIT 500`,
      params,
    )
  }

  async get(id: string): Promise<Charge | undefined> {
    return (await this.db.query<Charge>(`SELECT ${CHARGE_COLS} FROM charges ch WHERE ch.location_id = $1 AND ch.id = $2`, [this.locationId, id]))[0]
  }

  /**
   * Signed, undeleted notes that have no live charge, with the charge pre-filled from the session. The fee is the usual fee
   * for that code from Settings → Billing, else the Practice honorarium (intake or session) when it reads as money.
   */
  async suggestions(profile: BillingProfile, practiceFeeCents: { session: number | null; intake: number | null } = { session: null, intake: null }): Promise<ChargeSuggestion[]> {
    const rows = await this.db.query<{
      note_id: string; contact_id: string; contact_name: string | null; appointment_id: string | null; service_date: string
      session_type: string; modality: string; duration_min: number | null; diagnosis_codes: string[] | null; appt_minutes: number | null
    }>(
      `SELECT n.id AS note_id, n.contact_id, c.name AS contact_name, n.appointment_id, n.session_date::text AS service_date,
              n.session_type, n.modality, n.duration_min, n.diagnosis_codes,
              CASE WHEN a.id IS NULL THEN NULL ELSE round(extract(epoch FROM (a.ends_at - a.starts_at)) / 60)::int END AS appt_minutes
         FROM session_notes n
         LEFT JOIN contacts c ON c.id = n.contact_id AND c.location_id = n.location_id
         LEFT JOIN appointments a ON a.id = n.appointment_id AND a.location_id = n.location_id
        WHERE n.location_id = $1 AND n.status = 'signed' AND n.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM charges ch WHERE ch.session_note_id = n.id AND ch.voided_at IS NULL)
        ORDER BY n.session_date DESC, n.created_at DESC
        LIMIT 200`,
      [this.locationId],
    )
    return rows.map((r) => {
      const minutes = r.duration_min ?? r.appt_minutes
      const cpt = suggestCpt({ sessionType: r.session_type, durationMin: minutes })
      const place = suggestPlace(r.modality, profile.telehealthPos)
      return {
        note_id: r.note_id,
        contact_id: r.contact_id,
        contact_name: r.contact_name,
        appointment_id: r.appointment_id,
        service_date: r.service_date,
        session_type: r.session_type,
        modality: r.modality,
        duration_min: minutes,
        cpt_code: cpt,
        modifiers: place.modifiers,
        place_of_service: place.placeOfService,
        diagnosis_codes: r.diagnosis_codes ?? [],
        fee_cents: !cpt ? null : profile.fees[cpt] !== undefined ? profile.fees[cpt]! : cpt === '90791' ? practiceFeeCents.intake : practiceFeeCents.session,
      }
    })
  }

  async create(input: ChargeInput, operatorId: string, ctx: Ctx): Promise<ChargeResult> {
    try {
      return await this.db.transaction(async (tx): Promise<ChargeResult> => {
        const contact = await tx.query('SELECT 1 FROM contacts WHERE location_id = $1 AND id = $2', [this.locationId, input.contactId])
        if (contact.length === 0) return { ok: false, error: 'unknown_contact' }
        if (input.sessionNoteId) {
          const n = await tx.query("SELECT 1 FROM session_notes WHERE location_id = $1 AND id = $2 AND contact_id = $3 AND status = 'signed' AND deleted_at IS NULL", [this.locationId, input.sessionNoteId, input.contactId])
          if (n.length === 0) return { ok: false, error: 'unknown_note' }
          const dup = await tx.query('SELECT 1 FROM charges WHERE session_note_id = $1 AND voided_at IS NULL', [input.sessionNoteId])
          if (dup.length > 0) return { ok: false, error: 'note_already_charged' }
        }
        if (input.appointmentId) {
          const a = await tx.query('SELECT 1 FROM appointments WHERE location_id = $1 AND id = $2 AND contact_id = $3', [this.locationId, input.appointmentId, input.contactId])
          if (a.length === 0) return { ok: false, error: 'unknown_appointment' }
        }
        const id = nanoid()
        const rows = await tx.query<Charge>(
          `INSERT INTO charges (id, location_id, contact_id, appointment_id, session_note_id, service_date, cpt_code, modifiers, place_of_service, units, diagnosis_codes, fee_cents, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING ${CHARGE_COLS.replace(/ch\./g, '')}`,
          [id, this.locationId, input.contactId, input.appointmentId ?? null, input.sessionNoteId ?? null, input.serviceDate, input.cptCode, input.modifiers, input.placeOfService, input.units, input.diagnosisCodes, input.feeCents, operatorId],
        )
        await audit(tx, this.locationId, { action: 'charge.created', entityType: 'charge', entityId: id, contactId: input.contactId, details: { cpt: input.cptCode, serviceDate: input.serviceDate, fromNote: Boolean(input.sessionNoteId) }, ...ctx })
        return { ok: true, charge: rows[0]! }
      })
    } catch (err) {
      // Two requests for the same note raced past the check above; the partial unique index decided.
      if (isUniqueViolation(err)) return { ok: false, error: 'note_already_charged' }
      throw err
    }
  }

  async update(id: string, patch: ChargePatch, ctx: Ctx): Promise<ChargeResult> {
    return this.db.transaction(async (tx): Promise<ChargeResult> => {
      const cur = (await tx.query<Charge>(`SELECT ${CHARGE_COLS} FROM charges ch WHERE ch.location_id = $1 AND ch.id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      if (cur.voided_at) return { ok: false, error: 'voided' }
      if (cur.superbill_id || cur.invoice_id) return { ok: false, error: 'issued' }
      const cols: Record<keyof ChargePatch, string> = {
        serviceDate: 'service_date', cptCode: 'cpt_code', modifiers: 'modifiers', placeOfService: 'place_of_service',
        units: 'units', diagnosisCodes: 'diagnosis_codes', feeCents: 'fee_cents',
      }
      const sets: string[] = []
      const params: unknown[] = [this.locationId, id]
      const changed: string[] = []
      for (const [key, col] of Object.entries(cols) as [keyof ChargePatch, string][]) {
        const v = patch[key]
        if (v === undefined) continue
        const before = cur[col as keyof Charge]
        if (JSON.stringify(before) === JSON.stringify(v)) continue
        params.push(v)
        sets.push(`${col} = $${params.length}`)
        changed.push(col)
      }
      if (sets.length === 0) return { ok: false, error: 'nothing_to_change' }
      if (patch.feeCents !== undefined && patch.feeCents < cur.paid_cents) return { ok: false, error: 'overpaid' }
      const rows = await tx.query<Charge>(`UPDATE charges SET ${sets.join(', ')} WHERE location_id = $1 AND id = $2 RETURNING ${CHARGE_COLS.replace(/ch\./g, '')}`, params)
      await audit(tx, this.locationId, { action: 'charge.updated', entityType: 'charge', entityId: id, contactId: cur.contact_id, details: { fields: changed }, ...ctx })
      return { ok: true, charge: rows[0]! }
    })
  }

  // Payments are no longer set here: they are recorded (with their receipt) in payments-repo.ts, and `paid_cents` is
  // derived from them.

  async void(id: string, reason: string, operatorId: string, ctx: Ctx): Promise<ChargeResult> {
    return this.db.transaction(async (tx): Promise<ChargeResult> => {
      const cur = (await tx.query<Charge>(`SELECT ${CHARGE_COLS} FROM charges ch WHERE ch.location_id = $1 AND ch.id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      if (cur.voided_at) return { ok: false, error: 'voided' }
      if (cur.superbill_id || cur.invoice_id) return { ok: false, error: 'issued' } // void the superbill / invoice first
      if (cur.paid_cents > 0) return { ok: false, error: 'has_payments' } // void its receipt first
      const rows = await tx.query<Charge>(
        `UPDATE charges SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE location_id = $1 AND id = $2 RETURNING ${CHARGE_COLS.replace(/ch\./g, '')}`,
        [this.locationId, id, operatorId, reason],
      )
      await audit(tx, this.locationId, { action: 'charge.voided', entityType: 'charge', entityId: id, contactId: cur.contact_id, ...ctx }) // the typed reason stays on the charge, not in the log
      return { ok: true, charge: rows[0]! }
    })
  }
}

// --- superbills -------------------------------------------------------------------------------------------------

export interface SuperbillLine {
  chargeId: string
  date: string
  cpt: string
  label: string | null
  modifiers: string[]
  placeOfService: string
  dxPointers: string
  units: number
  feeCents: number
  paidCents: number
}

/** The exact content of an issued superbill. Frozen when issued; changing the profile or a charge later does not alter it. */
export interface SuperbillSnapshot {
  number: string
  issuedAt: string
  provider: {
    name: string
    practiceName: string
    license: string
    npi: string
    taxonomy: string
    address: string
    phone: string
    email: string
    taxIdType: 'ein' | 'ssn'
    taxIdLast4: string
    /** Still sealed: opened only when the document is shown. */
    taxIdSealed: string
  }
  client: { name: string; dateOfBirth: string; address: string; memberId: string }
  diagnoses: { letter: string; code: string }[]
  lines: SuperbillLine[]
  totals: { billedCents: number; paidCents: number; balanceCents: number }
}

export interface SuperbillRow {
  id: string
  contact_id: string
  number: string
  period_from: string
  period_to: string
  issued_at: string
  issued_by: string
  voided_at: string | null
  void_reason: string | null
  snapshot: SuperbillSnapshot
}

export type SuperbillSummary = Omit<SuperbillRow, 'snapshot'> & { contact_name: string | null; total_cents: number; paid_cents: number; line_count: number }

export type MissingItem = { code: string; chargeId?: string }
export type IssueError =
  | { ok: false; error: 'unknown_contact' | 'no_charges' | 'charges_unavailable' | 'too_many_diagnoses' }
  | { ok: false; error: 'incomplete'; missing: MissingItem[] }
export type IssueResult = { ok: true; superbill: SuperbillRow } | IssueError

export class SuperbillsRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  async list(contactId?: string): Promise<SuperbillSummary[]> {
    const rows = await this.db.query<Omit<SuperbillRow, 'snapshot'> & { contact_name: string | null; totals: SuperbillSnapshot['totals']; lines: unknown[] }>(
      `SELECT s.id, s.contact_id, s.number, s.period_from::text AS period_from, s.period_to::text AS period_to, s.issued_at, s.issued_by,
              s.voided_at, s.void_reason, c.name AS contact_name, s.snapshot->'totals' AS totals, s.snapshot->'lines' AS lines
         FROM superbills s LEFT JOIN contacts c ON c.id = s.contact_id AND c.location_id = s.location_id
        WHERE s.location_id = $1 ${contactId ? 'AND s.contact_id = $2' : ''}
        ORDER BY s.issued_at DESC LIMIT 500`,
      contactId ? [this.locationId, contactId] : [this.locationId],
    )
    return rows.map(({ totals, lines, ...r }) => ({ ...r, total_cents: totals?.billedCents ?? 0, paid_cents: totals?.paidCents ?? 0, line_count: Array.isArray(lines) ? lines.length : 0 }))
  }

  async get(id: string): Promise<SuperbillRow | undefined> {
    return (
      await this.db.query<SuperbillRow>(
        `SELECT id, contact_id, number, period_from::text AS period_from, period_to::text AS period_to, issued_at, issued_by, voided_at, void_reason, snapshot
           FROM superbills WHERE location_id = $1 AND id = $2`,
        [this.locationId, id],
      )
    )[0]
  }

  /**
   * Issue one superbill for one client from some of their unissued charges. Everything is read, checked and written in one
   * transaction that holds the practice's row, so two issues at once cannot take the same number or the same charge.
   */
  async issue(
    input: { contactId: string; chargeIds: string[]; clientAddress?: string; memberId?: string },
    operatorId: string,
    ctx: Ctx,
  ): Promise<IssueResult> {
    return this.db.transaction(async (tx): Promise<IssueResult> => {
      const loc = await tx.query<{ settings: Record<string, unknown> | null }>('SELECT settings FROM locations WHERE id = $1 FOR UPDATE', [this.locationId])
      const settings = loc[0]?.settings ?? {}
      const practice = normalizePractice(settings.practice)
      const billing = normalizeBilling(settings.billing)
      const sealedTaxId = typeof (settings.billing as { taxIdSealed?: unknown } | undefined)?.taxIdSealed === 'string' ? ((settings.billing as { taxIdSealed: string }).taxIdSealed) : ''

      const contact = (await tx.query<{ name: string | null; first_name: string | null; last_name: string | null; dob: string | null }>(
        `SELECT name, first_name, last_name, custom_fields->>'date_of_birth' AS dob FROM contacts WHERE location_id = $1 AND id = $2`,
        [this.locationId, input.contactId],
      ))[0]
      if (!contact) return { ok: false, error: 'unknown_contact' }
      const ids = [...new Set(input.chargeIds)]
      if (ids.length === 0) return { ok: false, error: 'no_charges' }

      const charges = await tx.query<Charge>(
        `SELECT ${CHARGE_COLS} FROM charges ch
          WHERE ch.location_id = $1 AND ch.contact_id = $2 AND ch.id = ANY($3::text[]) AND ch.voided_at IS NULL AND ch.superbill_id IS NULL
          ORDER BY ch.service_date, ch.created_at FOR UPDATE`,
        [this.locationId, input.contactId, ids],
      )
      // A charge that is another client's, already on a superbill, voided or unknown is refused as a whole.
      if (charges.length !== ids.length) return { ok: false, error: 'charges_unavailable' }

      const missing: MissingItem[] = []
      if (!practice.therapist.trim()) missing.push({ code: 'provider_name' })
      if (!practice.license.trim()) missing.push({ code: 'practice_license' })
      if (!practice.address.trim()) missing.push({ code: 'practice_address' })
      if (!billing.npi) missing.push({ code: 'provider_npi' })
      if (!billing.hasTaxId) missing.push({ code: 'provider_tax_id' })
      if (!contact.dob) missing.push({ code: 'client_date_of_birth' })
      for (const c of charges) {
        if (c.diagnosis_codes.length === 0) missing.push({ code: 'charge_no_diagnosis', chargeId: c.id })
        if (c.fee_cents <= 0) missing.push({ code: 'charge_zero_fee', chargeId: c.id })
      }
      if (missing.length > 0) return { ok: false, error: 'incomplete', missing }

      const diagnoses = [...new Set(charges.flatMap((c) => c.diagnosis_codes))]
      if (diagnoses.length > MAX_DIAGNOSES) return { ok: false, error: 'too_many_diagnoses' }

      const year = new Date().getUTCFullYear()
      const prefix = `SB-${year}-`
      const used = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM superbills WHERE location_id = $1 AND number LIKE $2', [this.locationId, `${prefix}%`])
      const number = formatSuperbillNumber(year, (used[0]?.n ?? 0) + 1)

      const lines: SuperbillLine[] = charges.map((c) => ({
        chargeId: c.id,
        date: c.service_date,
        cpt: c.cpt_code,
        label: COMMON_CPT.find((x) => x.code === c.cpt_code)?.label ?? null,
        modifiers: c.modifiers,
        placeOfService: c.place_of_service,
        dxPointers: diagnosisPointers(c.diagnosis_codes, diagnoses),
        units: c.units,
        feeCents: c.fee_cents,
        paidCents: c.paid_cents,
      }))
      const billed = lines.reduce((s, l) => s + l.feeCents, 0)
      const paid = lines.reduce((s, l) => s + l.paidCents, 0)
      const clientName = normalizeContactName(contact)
      const issuedAt = new Date().toISOString()
      const snapshot: SuperbillSnapshot = {
        number,
        issuedAt,
        provider: {
          name: practice.therapist.trim(), practiceName: practice.name.trim(), license: practice.license.trim(), npi: billing.npi, taxonomy: billing.taxonomy,
          address: practice.address.trim(), phone: practice.phone.trim(), email: practice.email.trim(),
          taxIdType: billing.taxIdType ?? 'ein', taxIdLast4: billing.taxIdLast4 ?? '', taxIdSealed: sealedTaxId,
        },
        client: { name: clientName, dateOfBirth: contact.dob!, address: (input.clientAddress ?? '').trim(), memberId: (input.memberId ?? '').trim() },
        diagnoses: diagnoses.map((code, i) => ({ letter: String.fromCharCode(65 + i), code })),
        lines,
        totals: { billedCents: billed, paidCents: paid, balanceCents: billed - paid },
      }

      const id = nanoid()
      await tx.query(
        `INSERT INTO superbills (id, location_id, contact_id, number, period_from, period_to, snapshot, issued_at, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [id, this.locationId, input.contactId, number, lines[0]!.date, lines[lines.length - 1]!.date, JSON.stringify(snapshot), issuedAt, operatorId],
      )
      await tx.query('UPDATE charges SET superbill_id = $3 WHERE location_id = $1 AND id = ANY($2::text[])', [this.locationId, charges.map((c) => c.id), id])
      await audit(tx, this.locationId, { action: 'superbill.issued', entityType: 'superbill', entityId: id, contactId: input.contactId, details: { number, lines: lines.length }, ...ctx })
      const row = (await new SuperbillsRepo(tx, this.locationId).get(id))!
      return { ok: true, superbill: row }
    })
  }

  /** Void a superbill (with a reason). Its charges are released so a corrected one can be issued. The superbill itself stays. */
  async void(id: string, reason: string, operatorId: string, ctx: Ctx): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'voided' }> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<{ contact_id: string; number: string; voided_at: string | null }>('SELECT contact_id, number, voided_at FROM superbills WHERE location_id = $1 AND id = $2 FOR UPDATE', [this.locationId, id]))[0]
      if (!cur) return { ok: false as const, error: 'not_found' as const }
      if (cur.voided_at) return { ok: false as const, error: 'voided' as const }
      await tx.query('UPDATE superbills SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE location_id = $1 AND id = $2', [this.locationId, id, operatorId, reason])
      await tx.query('UPDATE charges SET superbill_id = NULL WHERE location_id = $1 AND superbill_id = $2', [this.locationId, id])
      await audit(tx, this.locationId, { action: 'superbill.voided', entityType: 'superbill', entityId: id, contactId: cur.contact_id, details: { number: cur.number }, ...ctx }) // the typed reason stays on the superbill, not in the log
      return { ok: true as const }
    })
  }

  /** Record that a superbill was opened or printed. */
  async recordAccess(id: string, action: 'superbill.viewed' | 'superbill.printed', ctx: Ctx): Promise<boolean> {
    const row = await this.get(id)
    if (!row) return false
    await audit(this.db, this.locationId, { action, entityType: 'superbill', entityId: id, contactId: row.contact_id, details: { number: row.number }, ...ctx })
    return true
  }

  /** The tax id, opened for display on one superbill. Null if it cannot be opened (e.g. the secret changed). */
  openTaxId(snapshot: SuperbillSnapshot, secret: string): string | null {
    return snapshot.provider.taxIdSealed ? open(snapshot.provider.taxIdSealed, secret, TAX_ID_SEAL_LABEL) : null
  }
}

import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import { isMinor, isValidIsoDate, todayIn } from '../lib/age'
import { type AuditEntry, audit } from '../lib/audit'
import { normalizeEmail, normalizePhone } from '../lib/contact-match'
import { cleanAnswers } from '../lib/document-answers'
import { type RequestAudience, assignSigner } from '../lib/document-assignment'
import { documentShell, renderDocumentBody, renderSignatureBlock } from '../lib/document-render'
import { maskEmail } from '../lib/document-tokens'
import type { SignerRole, TemplateField } from '../lib/document-vocab'
import { LocationScopedRepo } from './base-repo'
import { PracticeRepo } from './practice-repo'
import { TimelineRepo } from './timeline-repo'

export type RequestStatus = 'sent' | 'in_progress' | 'completed' | 'expired' | 'voided'
export type SignerStatus = 'pending' | 'viewed' | 'in_progress' | 'completed'

export type DocActorRef = Pick<AuditEntry, 'ip' | 'userAgent'> & { operatorId: string }

/** Who is acting when a visitor on the public page signs. */
export interface PublicActor {
  signerId: string
  role: SignerRole
  ip: string
  userAgent: string
}

export interface DocumentRequest {
  id: string
  contactId: string
  packetId: string | null
  packetName: string
  audience: RequestAudience
  templateIds: string[]
  status: RequestStatus
  sentBy: string
  sentAt: string
  expiresAt: string
  completedAt: string | null
  voidedAt: string | null
  voidReason: string | null
  /** Set when everyone signed but something needs the therapist's eye first (e.g. a date of birth that does not match). */
  needsReview: string | null
}

export interface RequestSigner {
  id: string
  role: SignerRole
  name: string
  email: string
  status: SignerStatus
  verifiedAt: string | null
  firstViewedAt: string | null
  completedAt: string | null
  /** True once the verification code was failed too many times: only a re-send by the therapist unlocks it. */
  locked: boolean
}

export interface RequestDocument {
  templateId: string
  familyId: string
  title: string
  version: number
  signerId: string | null
  signerRole: SignerRole | null
  signedDocumentId: string | null
  signedAt: string | null
}

export interface RequestView extends DocumentRequest {
  contactName: string | null
  signers: RequestSigner[]
  documents: RequestDocument[]
}

export interface SignedDocumentSummary {
  id: string
  requestId: string
  contactId: string
  signerRole: SignerRole
  signerName: string
  templateId: string
  templateTitle: string
  templateVersion: number
  locale: 'es' | 'en'
  signedAt: string
  contentSha256: string
}
export interface SignedDocument extends SignedDocumentSummary {
  renderedHtml: string
  fieldValues: Record<string, unknown>
  signerIp: string
  verifiedVia: string
  /** sha256(renderedHtml) recomputed now equals the stored hash: the record is intact. */
  intact: boolean
}

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString())
const num = (v: unknown) => Number(v)

interface ReqRow {
  id: string; contact_id: string; packet_id: string | null; packet_name: string; audience: RequestAudience; template_ids: string[]
  status: RequestStatus; sent_by: string; sent_at: Date | string; expires_at: Date | string; completed_at: Date | string | null
  voided_at: Date | string | null; void_reason: string | null; needs_review: string | null
}
interface SignerRow {
  id: string; request_id: string; role: SignerRole; name: string; email: string; status: SignerStatus; otp_attempts: number
  verified_at: Date | string | null; first_viewed_at: Date | string | null; completed_at: Date | string | null
}
const REQ_COLS = 'id, contact_id, packet_id, packet_name, audience, template_ids, status, sent_by, sent_at, expires_at, completed_at, voided_at, void_reason, needs_review'
const SIGNER_COLS = 'id, request_id, role, name, email, status, otp_attempts, verified_at, first_viewed_at, completed_at'
const SIGNED_COLS = 'id, request_id, contact_id, signer_role, signer_name, template_id, template_title, template_version, locale, signed_at, content_sha256'

export const OTP_MAX_ATTEMPTS = 5

const toRequest = (r: ReqRow): DocumentRequest => ({
  id: r.id, contactId: r.contact_id, packetId: r.packet_id, packetName: r.packet_name, audience: r.audience, templateIds: r.template_ids,
  status: r.status, sentBy: r.sent_by, sentAt: iso(r.sent_at)!, expiresAt: iso(r.expires_at)!, completedAt: iso(r.completed_at),
  voidedAt: iso(r.voided_at), voidReason: r.void_reason, needsReview: r.needs_review,
})
const toSigner = (r: SignerRow): RequestSigner => ({
  id: r.id, role: r.role, name: r.name, email: r.email, status: r.status, verifiedAt: iso(r.verified_at),
  firstViewedAt: iso(r.first_viewed_at), completedAt: iso(r.completed_at), locked: num(r.otp_attempts) >= OTP_MAX_ATTEMPTS,
})
const toSignedSummary = (r: Record<string, any>): SignedDocumentSummary => ({
  id: r.id, requestId: r.request_id, contactId: r.contact_id, signerRole: r.signer_role, signerName: r.signer_name, templateId: r.template_id,
  templateTitle: r.template_title, templateVersion: num(r.template_version), locale: r.locale, signedAt: iso(r.signed_at)!, contentSha256: r.content_sha256,
})

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
/** A PNG data URL of at most 100 KB, and nothing else: it goes into a stored HTML snapshot. */
export const MAX_SIGNATURE_BYTES = 100 * 1024
export function isSignaturePng(v: unknown): v is string {
  return typeof v === 'string' && v.length <= Math.ceil(MAX_SIGNATURE_BYTES * 1.4) + 30 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(v)
}

interface TemplateRow {
  id: string; family_id: string; locale: 'es' | 'en'; version: number; kind: string; title: string; body_md: string
  fields: TemplateField[]; signature: { required: boolean; drawn: boolean }; signer_roles: SignerRole[]
}
const TEMPLATE_COLS = 'id, family_id, locale, version, kind, title, body_md, fields, signature, signer_roles'

export type SignError =
  | { ok: false; error: 'not_found' | 'request_closed' | 'template_not_assigned' | 'consent_required' | 'signature_required' | 'name_required' }
  | { ok: false; error: 'signature_invalid' }
  | { ok: false; error: 'invalid_answers'; issues: { key: string; reason: string }[] }

export interface SignOk {
  ok: true
  signed: SignedDocumentSummary
  /** The family of the template just signed (what a `document_signed` workflow filters on). */
  templateFamilyId: string
  alreadySigned: boolean
  signerCompleted: boolean
  requestCompleted: boolean
  /** Everyone signed, but the request was held back for review (see `needsReview`). */
  held: string | null
}

export interface DocTemplateForSigning {
  id: string
  title: string
  locale: 'es' | 'en'
  version: number
  bodyMd: string
  fields: TemplateField[]
  signature: { required: boolean; drawn: boolean }
  signerRoles: SignerRole[]
  signerId: string | null
}

export class DocumentRequestsRepo extends LocationScopedRepo {
  private operator(actor: DocActorRef): Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'> {
    return { actor: { type: 'operator', id: actor.operatorId }, ip: actor.ip, userAgent: actor.userAgent }
  }
  private visitor(a: PublicActor): Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'> {
    return { actor: { type: 'client', id: a.signerId, label: a.role }, ip: a.ip, userAgent: a.userAgent }
  }

  // --- sending ---------------------------------------------------------------

  async create(
    input: {
      contactId: string
      packet: { id: string; name: string; audience: RequestAudience }
      templates: { id: string; version: number }[]
      signers: { role: SignerRole; name: string; email: string; tokenHash: string }[]
      warnings: string[]
    },
    actor: { sentBy: string; audit: Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'> },
  ): Promise<{ request: DocumentRequest; signers: (RequestSigner & { tokenHash: string })[] }> {
    const id = nanoid()
    return this.db.transaction(async (tx) => {
      const r = (await tx.query<ReqRow>(
        `INSERT INTO document_requests (id, location_id, contact_id, packet_id, packet_name, audience, template_ids, sent_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${REQ_COLS}`,
        [id, this.locationId, input.contactId, input.packet.id, input.packet.name, input.packet.audience, input.templates.map((t) => t.id), actor.sentBy],
      ))[0]!
      const signers: (RequestSigner & { tokenHash: string })[] = []
      for (const s of input.signers) {
        const row = (await tx.query<SignerRow>(
          `INSERT INTO document_signers (id, location_id, request_id, role, name, email, token_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${SIGNER_COLS}`,
          [nanoid(), this.locationId, id, s.role, s.name, s.email, s.tokenHash],
        ))[0]!
        signers.push({ ...toSigner(row), tokenHash: s.tokenHash })
      }
      await audit(tx, this.locationId, {
        action: 'packet.sent', entityType: 'document_request', entityId: id, contactId: input.contactId,
        details: { packetId: input.packet.id, audience: input.packet.audience, templates: input.templates, signerRoles: input.signers.map((s) => s.role), warnings: input.warnings },
        ...actor.audit,
      })
      await new TimelineRepo(tx, this.locationId).add({ contactId: input.contactId, type: 'documents_sent', refTable: 'document_requests', refId: id, payload: { packetName: input.packet.name, documents: input.templates.length } })
      return { request: toRequest(r), signers }
    })
  }

  // --- reading ---------------------------------------------------------------

  private async view(rows: ReqRow[]): Promise<RequestView[]> {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const signers = await this.db.query<SignerRow>(`SELECT ${SIGNER_COLS} FROM document_signers WHERE location_id = $1 AND request_id = ANY($2::text[]) ORDER BY id`, [this.locationId, ids])
    const signed = await this.db.query<Record<string, any>>(`SELECT ${SIGNED_COLS}, signer_id FROM signed_documents WHERE location_id = $1 AND request_id = ANY($2::text[])`, [this.locationId, ids])
    const templateIds = [...new Set(rows.flatMap((r) => r.template_ids))]
    const templates = templateIds.length ? await this.db.query<TemplateRow>(`SELECT ${TEMPLATE_COLS} FROM document_templates WHERE location_id = $1 AND id = ANY($2::text[])`, [this.locationId, templateIds]) : []
    const contacts = await this.db.query<{ id: string; name: string | null }>('SELECT id, name FROM contacts WHERE location_id = $1 AND id = ANY($2::text[])', [this.locationId, [...new Set(rows.map((r) => r.contact_id))]])
    const tById = new Map(templates.map((t) => [t.id, t]))
    const cName = new Map(contacts.map((c) => [c.id, c.name]))
    return rows.map((r) => {
      const rs = signers.filter((s) => s.request_id === r.id).map(toSigner)
      const docs: RequestDocument[] = r.template_ids.flatMap((tid) => {
        const t = tById.get(tid)
        if (!t) return []
        const owner = assignSigner(t.signer_roles, rs)
        const sd = signed.find((x) => x.request_id === r.id && x.template_id === tid)
        return [{ templateId: tid, familyId: t.family_id, title: t.title, version: num(t.version), signerId: owner?.id ?? null, signerRole: owner?.role ?? null, signedDocumentId: sd?.id ?? null, signedAt: iso(sd?.signed_at) }]
      })
      return { ...toRequest(r), contactName: cName.get(r.contact_id) ?? null, signers: rs, documents: docs }
    })
  }

  async list(opts: { contactId?: string; status?: RequestStatus; limit?: number } = {}): Promise<RequestView[]> {
    const params: unknown[] = [this.locationId]
    let where = 'location_id = $1'
    if (opts.contactId) { params.push(opts.contactId); where += ` AND contact_id = $${params.length}` }
    if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}` }
    params.push(Math.min(opts.limit ?? 100, 200))
    const rows = await this.db.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE ${where} ORDER BY sent_at DESC LIMIT $${params.length}`, params)
    return this.view(rows)
  }

  /** Is there already a request for this packet that is open or done? (An automation must not send it twice.) */
  async hasLiveRequest(contactId: string, packetId: string): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM document_requests WHERE location_id = $1 AND contact_id = $2 AND packet_id = $3 AND status IN ('sent','in_progress','completed') LIMIT 1`,
      [this.locationId, contactId, packetId],
    )
    return rows.length > 0
  }

  async get(id: string): Promise<RequestView | null> {
    const rows = await this.db.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE location_id = $1 AND id = $2`, [this.locationId, id])
    return (await this.view(rows))[0] ?? null
  }

  async listSigned(contactId: string): Promise<SignedDocumentSummary[]> {
    const rows = await this.db.query<Record<string, any>>(`SELECT ${SIGNED_COLS} FROM signed_documents WHERE location_id = $1 AND contact_id = $2 ORDER BY signed_at DESC`, [this.locationId, contactId])
    return rows.map(toSignedSummary)
  }

  async getSigned(id: string): Promise<SignedDocument | null> {
    const r = (await this.db.query<Record<string, any>>(`SELECT ${SIGNED_COLS}, rendered_html, field_values, signer_ip, verified_via FROM signed_documents WHERE location_id = $1 AND id = $2`, [this.locationId, id]))[0]
    if (!r) return null
    return { ...toSignedSummary(r), renderedHtml: r.rendered_html, fieldValues: r.field_values, signerIp: r.signer_ip, verifiedVia: r.verified_via, intact: sha256(r.rendered_html) === r.content_sha256 }
  }

  // --- operator actions ------------------------------------------------------

  /** Issue a new link to one signer (the old one stops working) and unlock them. */
  async rotateToken(requestId: string, signerId: string, tokenHash: string, actor: DocActorRef): Promise<{ ok: true; signer: RequestSigner; request: DocumentRequest } | { ok: false; error: 'not_found' | 'not_open' | 'signer_completed' }> {
    return this.db.transaction(async (tx) => {
      const r = (await tx.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, requestId]))[0]
      if (!r) return { ok: false, error: 'not_found' }
      if (r.status !== 'sent' && r.status !== 'in_progress') return { ok: false, error: 'not_open' }
      const s = (await tx.query<SignerRow>(`SELECT ${SIGNER_COLS} FROM document_signers WHERE location_id = $1 AND request_id = $2 AND id = $3 FOR UPDATE`, [this.locationId, requestId, signerId]))[0]
      if (!s) return { ok: false, error: 'not_found' }
      if (s.status === 'completed') return { ok: false, error: 'signer_completed' }
      const upd = (await tx.query<SignerRow>(
        `UPDATE document_signers SET token_hash = $3, otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0, verified_at = NULL WHERE location_id = $1 AND id = $2 RETURNING ${SIGNER_COLS}`,
        [this.locationId, signerId, tokenHash],
      ))[0]!
      await audit(tx, this.locationId, { action: 'packet.resent', entityType: 'document_request', entityId: requestId, contactId: r.contact_id, details: { signerId, role: s.role }, ...this.operator(actor) })
      return { ok: true, signer: toSigner(upd), request: toRequest(r) }
    })
  }

  async void(id: string, reason: string, actor: DocActorRef): Promise<{ ok: true; request: DocumentRequest } | { ok: false; error: 'not_found' | 'not_open' }> {
    return this.db.transaction(async (tx) => {
      const r = (await tx.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!r) return { ok: false, error: 'not_found' }
      if (r.status === 'completed' || r.status === 'voided') return { ok: false, error: 'not_open' }
      const upd = (await tx.query<ReqRow>(`UPDATE document_requests SET status = 'voided', voided_at = now(), void_reason = $3 WHERE location_id = $1 AND id = $2 RETURNING ${REQ_COLS}`, [this.locationId, id, reason]))[0]!
      // The reason is free text: it stays on the row, not in the audit log.
      await audit(tx, this.locationId, { action: 'packet.voided', entityType: 'document_request', entityId: id, contactId: r.contact_id, details: { previousStatus: r.status }, ...this.operator(actor) })
      return { ok: true, request: toRequest(upd) }
    })
  }

  /** Requests past their deadline become `expired`, each leaving a follow-up task. Safe to call any time; returns what it expired. */
  async expireDue(now: Date = new Date()): Promise<string[]> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM document_requests WHERE location_id = $1 AND status IN ('sent','in_progress') AND expires_at <= $2`, [this.locationId, now.toISOString()],
    )
    const expired: string[] = []
    for (const { id } of due) {
      const done = await this.db.transaction(async (tx) => {
        const r = (await tx.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE location_id = $1 AND id = $2 AND status IN ('sent','in_progress') AND expires_at <= $3 FOR UPDATE`, [this.locationId, id, now.toISOString()]))[0]
        if (!r) return false
        await tx.query(`UPDATE document_requests SET status = 'expired' WHERE location_id = $1 AND id = $2`, [this.locationId, id])
        await audit(tx, this.locationId, { action: 'packet.expired', entityType: 'document_request', entityId: id, contactId: r.contact_id, details: { previousStatus: r.status }, actor: { type: 'system', label: 'Document expiry' } })
        await this.addTask(tx, r.contact_id, 'Follow up: onboarding documents expired for', 'The documents link expired before they were completed. Send them again from the client’s Documents tab.')
        return true
      })
      if (done) expired.push(id)
    }
    return expired
  }

  private async addTask(tx: Database, contactId: string, titlePrefix: string, body: string): Promise<void> {
    const c = (await tx.query<{ name: string | null }>('SELECT name FROM contacts WHERE location_id = $1 AND id = $2', [this.locationId, contactId]))[0]
    await tx.query(`INSERT INTO contact_tasks (id, location_id, contact_id, title, body) VALUES ($1,$2,$3,$4,$5)`, [nanoid(), this.locationId, contactId, `${titlePrefix} ${c?.name ?? 'client'}`, body])
  }

  /** The therapist accepts a request that was held for review: it is completed now. */
  async acceptHeld(id: string, actor: DocActorRef): Promise<{ ok: true; request: DocumentRequest } | { ok: false; error: 'not_found' | 'not_held' }> {
    return this.db.transaction(async (tx) => {
      const r = (await tx.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!r) return { ok: false, error: 'not_found' }
      if (r.status !== 'in_progress' || !r.needs_review) return { ok: false, error: 'not_held' }
      await this.completeRequest(tx, r, this.operator(actor), { via: 'accepted_after_review', review: r.needs_review })
      const upd = (await tx.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE location_id = $1 AND id = $2`, [this.locationId, id]))[0]!
      return { ok: true, request: toRequest(upd) }
    })
  }

  // --- progress saved without signing ---------------------------------------

  async saveDraft(signerId: string, templateId: string, values: Record<string, unknown>): Promise<boolean> {
    const s = (await this.db.query<{ request_id: string; status: SignerStatus; draft_values: Record<string, unknown> }>(`SELECT request_id, status, draft_values FROM document_signers WHERE location_id = $1 AND id = $2`, [this.locationId, signerId]))[0]
    if (!s || s.status === 'completed') return false
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE document_signers SET draft_values = draft_values || jsonb_build_object($3::text, $4::jsonb), status = CASE WHEN status = 'completed' THEN status ELSE 'in_progress' END WHERE location_id = $1 AND id = $2`,
        [this.locationId, signerId, templateId, JSON.stringify(values)],
      )
      await tx.query(`UPDATE document_requests SET status = 'in_progress' WHERE location_id = $1 AND id = $2 AND status = 'sent'`, [this.locationId, s.request_id])
    })
    return true
  }

  // --- verification (the one-time code) -------------------------------------

  async storeOtp(signerId: string, otpHash: string, expiresAt: Date): Promise<void> {
    await this.db.query(`UPDATE document_signers SET otp_hash = $3, otp_expires_at = $4 WHERE location_id = $1 AND id = $2`, [this.locationId, signerId, otpHash, expiresAt.toISOString()])
  }

  /** Count a wrong code. The fifth locks the signer (and says so in the audit log). Returns the attempts used so far. */
  async failOtp(signerId: string, actor: PublicActor): Promise<number> {
    return this.db.transaction(async (tx) => {
      const row = (await tx.query<{ otp_attempts: number; request_id: string }>(
        `UPDATE document_signers SET otp_attempts = otp_attempts + 1 WHERE location_id = $1 AND id = $2 RETURNING otp_attempts, request_id`, [this.locationId, signerId],
      ))[0]
      const attempts = num(row?.otp_attempts)
      if (attempts === OTP_MAX_ATTEMPTS) {
        const req = (await tx.query<{ contact_id: string }>('SELECT contact_id FROM document_requests WHERE location_id = $1 AND id = $2', [this.locationId, row!.request_id]))[0]
        await audit(tx, this.locationId, { action: 'signer.locked', entityType: 'document_signer', entityId: signerId, contactId: req?.contact_id ?? null, details: { role: actor.role }, ...this.visitor(actor) })
      }
      return attempts
    })
  }

  /** A correct code: the signer is verified, the code is burned, and the first time is recorded as "opened". */
  async markVerified(signerId: string, actor: PublicActor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const s = (await tx.query<{ request_id: string; first_viewed_at: Date | null }>(
        `SELECT request_id, first_viewed_at FROM document_signers WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, signerId],
      ))[0]
      if (!s) return
      await tx.query(
        `UPDATE document_signers
            SET verified_at = now(), otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0,
                first_viewed_at = COALESCE(first_viewed_at, now()),
                status = CASE WHEN status = 'pending' THEN 'viewed' ELSE status END
          WHERE location_id = $1 AND id = $2`, [this.locationId, signerId],
      )
      if (s.first_viewed_at) return // already opened before: nothing new to record
      const req = (await tx.query<{ contact_id: string }>('SELECT contact_id FROM document_requests WHERE location_id = $1 AND id = $2', [this.locationId, s.request_id]))[0]
      await audit(tx, this.locationId, { action: 'document.viewed', entityType: 'document_signer', entityId: signerId, contactId: req?.contact_id ?? null, details: { requestId: s.request_id, role: actor.role }, ...this.visitor(actor) })
    })
  }

  /** Every signed document of one signer, for their own copy. */
  async signedFor(signerId: string): Promise<{ id: string; templateId: string; title: string; renderedHtml: string; signedAt: string }[]> {
    const rows = await this.db.query<Record<string, any>>('SELECT id, template_id, template_title, rendered_html, signed_at FROM signed_documents WHERE location_id = $1 AND signer_id = $2 ORDER BY signed_at', [this.locationId, signerId])
    return rows.map((r) => ({ id: r.id, templateId: r.template_id, title: r.template_title, renderedHtml: r.rendered_html, signedAt: iso(r.signed_at)! }))
  }

  async recordDownload(signerId: string, contactId: string, requestId: string, actor: PublicActor): Promise<void> {
    await audit(this.db, this.locationId, { action: 'document.downloaded', entityType: 'document_signer', entityId: signerId, contactId, details: { requestId, role: actor.role }, ...this.visitor(actor) })
  }

  /** The template versions of a request, in the order they were frozen, with who signs each. */
  async templatesFor(requestId: string): Promise<(DocTemplateForSigning)[]> {
    const r = (await this.db.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE location_id = $1 AND id = $2`, [this.locationId, requestId]))[0]
    if (!r) return []
    const ts = await this.db.query<TemplateRow>(`SELECT ${TEMPLATE_COLS} FROM document_templates WHERE location_id = $1 AND id = ANY($2::text[])`, [this.locationId, r.template_ids])
    const signers = (await this.db.query<SignerRow>(`SELECT ${SIGNER_COLS} FROM document_signers WHERE location_id = $1 AND request_id = $2`, [this.locationId, requestId])).map(toSigner)
    return r.template_ids.flatMap((id) => {
      const t = ts.find((x) => x.id === id)
      if (!t) return []
      return [{ id: t.id, title: t.title, locale: t.locale, version: num(t.version), bodyMd: t.body_md, fields: t.fields, signature: t.signature, signerRoles: t.signer_roles, signerId: assignSigner(t.signer_roles, signers)?.id ?? null }]
    })
  }

  // --- signing ---------------------------------------------------------------

  async sign(
    input: {
      signerId: string
      templateId: string
      signerName: string
      signaturePng: string | null
      agreeTerms: boolean
      esignConsent: boolean
      values: Record<string, unknown>
      now?: Date
    },
    actor: PublicActor,
  ): Promise<SignOk | SignError> {
    const now = input.now ?? new Date()
    return this.db.transaction(async (tx): Promise<SignOk | SignError> => {
      const s = (await tx.query<SignerRow & { email: string }>(`SELECT ${SIGNER_COLS} FROM document_signers WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, input.signerId]))[0]
      if (!s) return { ok: false, error: 'not_found' }
      const r = (await tx.query<ReqRow>(`SELECT ${REQ_COLS} FROM document_requests WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, s.request_id]))[0]!
      const templates = await tx.query<TemplateRow>(`SELECT ${TEMPLATE_COLS} FROM document_templates WHERE location_id = $1 AND id = ANY($2::text[])`, [this.locationId, r.template_ids])
      const signers = (await tx.query<SignerRow>(`SELECT ${SIGNER_COLS} FROM document_signers WHERE location_id = $1 AND request_id = $2`, [this.locationId, r.id])).map(toSigner)
      const tpl = templates.find((t) => t.id === input.templateId)
      if (!tpl || !r.template_ids.includes(tpl.id) || assignSigner(tpl.signer_roles, signers)?.id !== s.id) return { ok: false, error: 'template_not_assigned' }

      // Idempotent: signing a document twice returns the first signature untouched.
      const existing = (await tx.query<Record<string, any>>(`SELECT ${SIGNED_COLS} FROM signed_documents WHERE location_id = $1 AND signer_id = $2 AND template_id = $3`, [this.locationId, s.id, tpl.id]))[0]
      if (existing) return { ok: true, signed: toSignedSummary(existing), templateFamilyId: tpl.family_id, alreadySigned: true, signerCompleted: s.status === 'completed', requestCompleted: r.status === 'completed', held: r.needs_review }
      if ((r.status !== 'sent' && r.status !== 'in_progress') || new Date(iso(r.expires_at)!).getTime() <= now.getTime()) return { ok: false, error: 'request_closed' }

      if (!input.agreeTerms || !input.esignConsent) return { ok: false, error: 'consent_required' }
      const name = input.signerName.trim()
      if (!name || name.length > 120) return { ok: false, error: 'name_required' }
      if (tpl.signature.drawn) {
        if (!input.signaturePng) return { ok: false, error: 'signature_required' }
        if (!isSignaturePng(input.signaturePng)) return { ok: false, error: 'signature_invalid' }
      }
      const { values, issues } = cleanAnswers(tpl.fields, input.values)
      if (issues.length) return { ok: false, error: 'invalid_answers', issues }

      const contact = (await tx.query<{ id: string; name: string | null; first_name: string | null; last_name: string | null; custom_fields: Record<string, unknown> }>('SELECT id, name, first_name, last_name, custom_fields FROM contacts WHERE location_id = $1 AND id = $2', [this.locationId, r.contact_id]))[0]!
      const dobRaw = contact.custom_fields?.date_of_birth
      const practice = await new PracticeRepo(tx, this.locationId).get()
      const docId = nanoid()
      const body = renderDocumentBody(
        { title: tpl.title, bodyMd: tpl.body_md, fields: tpl.fields, locale: tpl.locale, signerRoles: tpl.signer_roles },
        { practice, contact: { first_name: contact.first_name, last_name: contact.last_name, name: contact.name, dateOfBirth: typeof dobRaw === 'string' ? dobRaw : null }, today: todayIn(undefined, now), mode: 'signed', values },
      )
      const renderedHtml = documentShell(
        tpl.title,
        body + renderSignatureBlock({ signerName: name, signedAt: now, ip: actor.ip, maskedEmail: maskEmail(s.email), signaturePng: tpl.signature.drawn ? input.signaturePng : null, documentId: docId, locale: tpl.locale }),
        tpl.locale,
      )
      const hash = sha256(renderedHtml)

      const row = (await tx.query<Record<string, any>>(
        `INSERT INTO signed_documents (id, location_id, contact_id, request_id, signer_id, signer_role, template_id, template_title, template_version, locale, field_values, rendered_html, content_sha256, signer_name, signature_png, esign_consent, signer_ip, signer_user_agent, verified_via, signed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,true,$16,$17,'email_otp',$18) RETURNING ${SIGNED_COLS}`,
        [docId, this.locationId, r.contact_id, r.id, s.id, s.role, tpl.id, tpl.title, tpl.version, tpl.locale, JSON.stringify(values), renderedHtml, hash, name, tpl.signature.drawn ? input.signaturePng : null, actor.ip, actor.userAgent.slice(0, 300), now.toISOString()],
      ))[0]!
      await audit(tx, this.locationId, { action: 'document.signed', entityType: 'signed_document', entityId: docId, contactId: r.contact_id, details: { requestId: r.id, templateId: tpl.id, templateVersion: num(tpl.version), signerRole: s.role, contentSha256: hash }, ...this.visitor(actor) })
      await new TimelineRepo(tx, this.locationId).add({ contactId: r.contact_id, type: 'document_signed', refTable: 'signed_documents', refId: docId, payload: { title: tpl.title, role: s.role } })
      if (r.status === 'sent') await tx.query(`UPDATE document_requests SET status = 'in_progress' WHERE location_id = $1 AND id = $2`, [this.locationId, r.id])

      // Did this finish the signer's list? Then, did it finish the packet?
      const mine = templates.filter((t) => assignSigner(t.signer_roles, signers)?.id === s.id)
      const signedIds = new Set((await tx.query<{ template_id: string }>('SELECT template_id FROM signed_documents WHERE location_id = $1 AND signer_id = $2', [this.locationId, s.id])).map((x) => x.template_id))
      const signerCompleted = mine.every((t) => signedIds.has(t.id))
      let requestCompleted = false
      let held: string | null = null
      if (signerCompleted) {
        await tx.query(`UPDATE document_signers SET status = 'completed', completed_at = $3 WHERE location_id = $1 AND id = $2`, [this.locationId, s.id, now.toISOString()])
        await audit(tx, this.locationId, { action: 'signer.completed', entityType: 'document_signer', entityId: s.id, contactId: r.contact_id, details: { requestId: r.id, role: s.role }, ...this.visitor(actor) })
        const open = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM document_signers WHERE location_id = $1 AND request_id = $2 AND status <> 'completed'`, [this.locationId, r.id])
        if (num(open[0]?.n) === 0) {
          const review = await this.reviewReason(tx, r, templates)
          if (review) {
            held = review
            await tx.query(`UPDATE document_requests SET needs_review = $3 WHERE location_id = $1 AND id = $2`, [this.locationId, r.id, review])
            await audit(tx, this.locationId, { action: 'packet.age_mismatch', entityType: 'document_request', entityId: r.id, contactId: r.contact_id, details: { reason: review, audience: r.audience }, ...this.visitor(actor) })
            await this.addTask(tx, r.contact_id, 'Review: date of birth mismatch for', 'The date of birth answered in the intake does not match the record, or does not fit the packet that was sent. Check it, then fix the record or send the right packet.')
          } else {
            await this.completeRequest(tx, r, this.visitor(actor), { via: 'signed' })
            requestCompleted = true
          }
        }
      }
      return { ok: true, signed: toSignedSummary(row), templateFamilyId: tpl.family_id, alreadySigned: false, signerCompleted, requestCompleted, held }
    })
  }

  /** The answered date of birth, if the packet asked for it (a field copied to `custom:date_of_birth`). */
  private async intakeDob(tx: Database, r: ReqRow, templates: TemplateRow[]): Promise<string | null> {
    const signed = await tx.query<{ template_id: string; field_values: Record<string, unknown> }>('SELECT template_id, field_values FROM signed_documents WHERE location_id = $1 AND request_id = $2', [this.locationId, r.id])
    for (const sd of signed) {
      const t = templates.find((x) => x.id === sd.template_id)
      for (const f of t?.fields ?? []) {
        if (f.mapsTo === 'custom:date_of_birth' && typeof sd.field_values[f.key] === 'string' && isValidIsoDate(sd.field_values[f.key])) return sd.field_values[f.key] as string
      }
    }
    return null
  }

  /** Why a completed packet should not be marked done yet (a date of birth that contradicts the record or the packet), or null. */
  private async reviewReason(tx: Database, r: ReqRow, templates: TemplateRow[]): Promise<string | null> {
    const answered = await this.intakeDob(tx, r, templates)
    if (!answered) return null
    const c = (await tx.query<{ custom_fields: Record<string, unknown> }>('SELECT custom_fields FROM contacts WHERE location_id = $1 AND id = $2', [this.locationId, r.contact_id]))[0]
    const recorded = c?.custom_fields?.date_of_birth
    if (isValidIsoDate(recorded) && recorded !== answered) return 'dob_mismatch'
    const minor = isMinor(answered)
    if (minor === true && r.audience === 'adult') return 'adult_packet_minor'
    if (minor === false && r.audience === 'adolescent') return 'adolescent_packet_adult'
    return null
  }

  private async completeRequest(tx: Database, r: ReqRow, ctx: Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>, meta: Record<string, unknown>): Promise<void> {
    await tx.query(`UPDATE document_requests SET status = 'completed', completed_at = now(), needs_review = NULL WHERE location_id = $1 AND id = $2`, [this.locationId, r.id])
    await this.handOff(tx, r, ctx)
    await audit(tx, this.locationId, { action: 'packet.completed', entityType: 'document_request', entityId: r.id, contactId: r.contact_id, details: { ...meta, audience: r.audience }, ...ctx })
    await new TimelineRepo(tx, this.locationId).add({ contactId: r.contact_id, type: 'documents_completed', refTable: 'document_requests', refId: r.id, payload: { packetName: r.packet_name } })
  }

  /** Copy intake answers (fields with `mapsTo`) onto the client's record. Never overwrites what the record already has: a difference is flagged for review instead. */
  private async handOff(tx: Database, r: ReqRow, ctx: Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>): Promise<void> {
    const templates = await tx.query<TemplateRow>(`SELECT ${TEMPLATE_COLS} FROM document_templates WHERE location_id = $1 AND id = ANY($2::text[])`, [this.locationId, r.template_ids])
    const signed = await tx.query<{ template_id: string; field_values: Record<string, unknown> }>('SELECT template_id, field_values FROM signed_documents WHERE location_id = $1 AND request_id = $2', [this.locationId, r.id])
    const answers: { target: string; value: string }[] = []
    for (const sd of signed) {
      const t = templates.find((x) => x.id === sd.template_id)
      for (const f of t?.fields ?? []) {
        const v = sd.field_values[f.key]
        if (f.mapsTo && typeof v === 'string' && v.trim() !== '') answers.push({ target: f.mapsTo, value: v.trim() })
      }
    }
    if (answers.length === 0) return
    const c = (await tx.query<{ name: string | null; first_name: string | null; last_name: string | null; emails: string[] | null; phones: string[] | null; custom_fields: Record<string, unknown> }>(
      'SELECT name, first_name, last_name, emails, phones, custom_fields FROM contacts WHERE location_id = $1 AND id = $2 FOR UPDATE', [this.locationId, r.contact_id],
    ))[0]
    if (!c) return
    const sets: { first_name?: string; last_name?: string; name?: string; emails?: string[]; phones?: string[] } = {}
    const custom: Record<string, unknown> = {}
    const conflicts: Record<string, { record: string; answered: string }> = {}
    const touched: string[] = []
    const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    for (const { target, value } of answers) {
      if (target === 'first_name' || target === 'last_name') {
        const cur = c[target]
        if (!cur) { sets[target] = value; touched.push(target) } else if (fold(cur) !== fold(value)) conflicts[target] = { record: cur, answered: value }
      } else if (target === 'email') {
        const e = normalizeEmail(value)
        if (!c.emails?.length) { sets.emails = [e]; touched.push('email') } else if (!c.emails.map(normalizeEmail).includes(e)) conflicts.email = { record: c.emails[0]!, answered: e }
      } else if (target === 'phone') {
        const p = normalizePhone(value)
        if (!c.phones?.length) { sets.phones = [p]; touched.push('phone') } else if (!c.phones.map(normalizePhone).includes(p)) conflicts.phone = { record: c.phones[0]!, answered: p }
      } else if (target.startsWith('custom:')) {
        const key = target.slice(7)
        const cur = c.custom_fields?.[key]
        // The date of birth picks the packet and the rules: it is never silently replaced.
        if (key === 'date_of_birth' && typeof cur === 'string' && cur && cur !== value) conflicts[key] = { record: cur, answered: value }
        else { custom[key] = value; touched.push(`custom:${key}`) }
      }
    }
    if ((sets.first_name || sets.last_name) && !c.name) sets.name = [sets.first_name ?? c.first_name, sets.last_name ?? c.last_name].filter(Boolean).join(' ')
    const cols = Object.keys(sets) as (keyof typeof sets)[]
    const params: unknown[] = [this.locationId, r.contact_id]
    const assigns = cols.map((k) => { params.push(sets[k]); return `${k} = $${params.length}` })
    const newCustom = { ...custom, ...(Object.keys(conflicts).length ? { intake_conflicts: { ...((c.custom_fields?.intake_conflicts as object) ?? {}), ...conflicts } } : {}) }
    if (Object.keys(newCustom).length) { params.push(JSON.stringify(newCustom)); assigns.push(`custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $${params.length}::jsonb`) }
    if (assigns.length === 0) return
    await tx.query(`UPDATE contacts SET ${assigns.join(', ')}, updated_at = now() WHERE location_id = $1 AND id = $2`, params)
    await audit(tx, this.locationId, { action: 'contact.updated_from_intake', entityType: 'contact', entityId: r.contact_id, contactId: r.contact_id, details: { fields: touched, conflicts: Object.keys(conflicts) }, ...ctx })
  }
}

// --- public lookups: the visitor has a token and nothing else, so these are keyed by it ---------

export interface SignerContext {
  locationId: string
  request: DocumentRequest
  signer: RequestSigner & { otpHash: string | null; otpExpiresAt: string | null; otpAttempts: number; draftValues: Record<string, Record<string, unknown>> }
}

/** Find the signer a link belongs to. One query for every outcome, so a bad token costs the same as a good one. */
export async function findSignerByTokenHash(db: Database, tokenHash: string): Promise<SignerContext | null> {
  const rows = await db.query<Record<string, any>>(
    `SELECT s.location_id, s.otp_hash, s.otp_expires_at, s.otp_attempts, s.draft_values,
            s.id AS s_id, s.request_id, s.role, s.name, s.email, s.status AS s_status, s.verified_at, s.first_viewed_at, s.completed_at AS s_completed_at,
            r.id AS r_id, r.contact_id, r.packet_id, r.packet_name, r.audience, r.template_ids, r.status AS r_status, r.sent_by, r.sent_at, r.expires_at, r.completed_at AS r_completed_at, r.voided_at, r.void_reason, r.needs_review
       FROM document_signers s JOIN document_requests r ON r.id = s.request_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  )
  const x = rows[0]
  if (!x) return null
  const signer = toSigner({ id: x.s_id, request_id: x.request_id, role: x.role, name: x.name, email: x.email, status: x.s_status, otp_attempts: x.otp_attempts, verified_at: x.verified_at, first_viewed_at: x.first_viewed_at, completed_at: x.s_completed_at })
  return {
    locationId: x.location_id,
    request: toRequest({ id: x.r_id, contact_id: x.contact_id, packet_id: x.packet_id, packet_name: x.packet_name, audience: x.audience, template_ids: x.template_ids, status: x.r_status, sent_by: x.sent_by, sent_at: x.sent_at, expires_at: x.expires_at, completed_at: x.r_completed_at, voided_at: x.voided_at, void_reason: x.void_reason, needs_review: x.needs_review }),
    signer: { ...signer, otpHash: x.otp_hash, otpExpiresAt: iso(x.otp_expires_at), otpAttempts: num(x.otp_attempts), draftValues: x.draft_values ?? {} },
  }
}


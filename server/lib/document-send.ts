import type { Database } from '../db/database'
import { isMinor, isValidIsoDate, todayIn } from './age'
import type { AuditEntry } from './audit'
import { assignSigner, validateSignerRoles } from './document-assignment'
import { sendLinkEmail } from './document-mail'
import { REQUEST_TTL_DAYS, hashToken, newToken } from './document-tokens'
import type { SignerRole } from './document-vocab'
import { type ResolvedEmailSender, resolveEmailSender } from './sending/resolve'
import { ContactsRepo } from '../repos/contacts-repo'
import { DocumentPacketsRepo } from '../repos/document-packets-repo'
import { type DocumentRequest, DocumentRequestsRepo } from '../repos/document-requests-repo'
import { DocumentTemplatesRepo } from '../repos/document-templates-repo'
import { displayName } from '../repos/branding-repo'

/** Who is sending: a person at the keyboard, or an automation. Recorded in the request and the audit log. */
export interface SendActor {
  sentBy: string
  audit: Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>
}

export interface SendDeps {
  db: Database
  locationId: string
  /** YYYY-MM-DD in practice time (injectable for tests). */
  today?: () => string
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  /** Origin of the signing links; null = not configured (an automation cannot guess it). */
  baseUrl: string | null
}

export interface SendInput {
  contactId: string
  packetId: string
  excludeFamilyIds: string[]
  signers: { role: SignerRole; name: string; email: string }[]
}

export interface SentSigner {
  id: string
  role: SignerRole
  name: string
  email: string
  link: string
  emailed: boolean
  emailIssue: string | null
}

export type SendResult =
  | { ok: true; request: DocumentRequest; signers: SentSigner[]; warnings: string[] }
  | { ok: false; status: 400 | 422 | 500; body: Record<string, unknown> }

const fail = (status: 400 | 422 | 500, error: string, extra: Record<string, unknown> = {}): SendResult => ({ ok: false, status, body: { error, ...extra } })

/**
 * Send a packet for signature. The one place this happens — the "Send onboarding packet"
 * button and the `send_document_packet` automation both come through here, so the age
 * rule, the frozen versions, the audit entries and the email are identical.
 */
export async function sendDocumentPacket(deps: SendDeps, input: SendInput, actor: SendActor): Promise<SendResult> {
  const { db, locationId } = deps
  const today = deps.today?.() ?? todayIn()
  if (!deps.baseUrl) return fail(500, 'base_url_missing')

  const contact = await new ContactsRepo(db, locationId).get(input.contactId)
  if (!contact || contact.archived_at) return fail(400, 'unknown contact')
  const packets = new DocumentPacketsRepo(db, locationId)
  const packet = await packets.get(input.packetId)
  if (!packet || packet.archivedAt) return fail(400, 'unknown packet')

  // The packet follows the client's age: 18+ adult, under 18 adolescent.
  const dob = contact.custom_fields?.date_of_birth
  if (!isValidIsoDate(dob)) return fail(422, 'date_of_birth_required')
  const expected = isMinor(dob, today) ? 'adolescent' : 'adult'
  if (packet.audience !== expected) return fail(422, 'packet_audience_mismatch', { expected, packetAudience: packet.audience })

  const roleIssues = validateSignerRoles(packet.audience, input.signers.map((s) => s.role))
  if (roleIssues.length) return fail(422, 'invalid_signers', { issues: roleIssues })

  // The versions IN FORCE are frozen into the request now; later edits never reach it.
  const templates = new DocumentTemplatesRepo(db, locationId)
  const wanted = packet.familyIds.filter((f) => !input.excludeFamilyIds.includes(f))
  const resolved = await templates.resolveFamilies(wanted)
  const notActive = wanted.filter((f) => !resolved.find((r) => r.familyId === f)?.active)
  if (notActive.length) return fail(422, 'template_not_active', { familyIds: notActive })
  if (resolved.length === 0) return fail(422, 'no_documents')

  const warnings: string[] = []
  const kept = resolved.filter((r) => {
    if (assignSigner(r.template.signerRoles, input.signers)) return true
    // A document written only for the minor is skipped (with a note) when the minor is not signing.
    if (r.template.signerRoles.every((x) => x === 'minor')) warnings.push(`skipped_minor_document:${r.familyId}`)
    return false
  })
  const unassigned = resolved.filter((r) => !kept.includes(r) && !r.template.signerRoles.every((x) => x === 'minor'))
  if (unassigned.length) return fail(422, 'signer_missing', { familyIds: unassigned.map((r) => r.familyId) })
  if (kept.length === 0) return fail(422, 'no_documents')

  const tokens = input.signers.map((s) => ({ ...s, token: newToken() }))
  const created = await new DocumentRequestsRepo(db, locationId).create(
    {
      contactId: contact.id,
      packet: { id: packet.id, name: packet.name, audience: packet.audience },
      templates: kept.map((r) => ({ id: r.template.id, version: r.template.version })),
      signers: tokens.map((t) => ({ role: t.role, name: t.name, email: t.email, tokenHash: hashToken(t.token) })),
      warnings,
    },
    actor,
  )

  const name = (await displayName(db, locationId)) || 'Su terapeuta'
  const sender = await (deps.resolveEmail ?? resolveEmailSender)(db, locationId)
  const out: SentSigner[] = []
  for (const s of created.signers) {
    const t = tokens.find((x) => x.role === s.role)!
    const link = `${deps.baseUrl.replace(/\/$/, '')}/d/${t.token}`
    const m = await sendLinkEmail(sender.ok ? sender.sender : null, sender.ok ? undefined : sender.reason, { practice: name, to: s.email, name: s.name, link, days: REQUEST_TTL_DAYS })
    out.push({ id: s.id, role: s.role, name: s.name, email: s.email, link, emailed: m.sent, emailIssue: m.reason ?? null })
  }
  return { ok: true, request: created.request, signers: out, warnings }
}

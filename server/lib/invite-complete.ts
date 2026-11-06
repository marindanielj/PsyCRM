import type { Database } from '../db/database'
import { isMinor, isValidIsoDate, todayIn } from './age'
import { audit } from './audit'
import { normalizePhone } from './contact-match'
import { ContactsRepo } from '../repos/contacts-repo'
import type { ClientInvite } from '../repos/client-invites-repo'

export interface RegistrationInput {
  firstName: string
  lastName: string
  phone?: string
  dateOfBirth: string
  /** Guardian invitations: the parent or guardian's own name and phone. */
  guardianName?: string
  guardianPhone?: string
}

export type CompleteResult =
  | { ok: true; contactId: string; created: boolean }
  | { ok: false; error: 'closed' | 'invalid_date_of_birth' | 'age_mismatch_minor' | 'age_mismatch_adult' | 'guardian_name_required' }

/**
 * The invited person's answers become a contact. Nothing exists before this: a client record
 * always starts with a date of birth, so the packet that fits their age can be chosen.
 *
 *  - adult invitation: the contact is the person (matched by email/phone, never duplicated);
 *  - guardian invitation: the contact is the minor, WITHOUT an email or phone of their own (so
 *    two siblings with one parent never merge), and the guardian's details go to the guardian_* fields.
 */
export async function completeInvite(
  db: Database,
  locationId: string,
  invite: ClientInvite,
  input: RegistrationInput,
  ctx: { ip: string | null; userAgent: string | null; now?: Date },
): Promise<CompleteResult> {
  const now = ctx.now ?? new Date()
  const today = todayIn(undefined, now)
  if (!isValidIsoDate(input.dateOfBirth) || input.dateOfBirth > today) return { ok: false, error: 'invalid_date_of_birth' }
  const minor = isMinor(input.dateOfBirth, today)
  if (invite.kind === 'adult' && minor) return { ok: false, error: 'age_mismatch_minor' }
  if (invite.kind === 'guardian' && !minor) return { ok: false, error: 'age_mismatch_adult' }
  const guardianName = (input.guardianName ?? '').trim()
  if (invite.kind === 'guardian' && !guardianName) return { ok: false, error: 'guardian_name_required' }

  const fullName = `${input.firstName.trim()} ${input.lastName.trim()}`.trim()
  const who = { actor: { type: 'client' as const, id: invite.id, label: invite.kind === 'guardian' ? 'Parent or guardian (invitation)' : 'Client (invitation)' }, ip: ctx.ip, userAgent: ctx.userAgent }

  return db.transaction(async (tx): Promise<CompleteResult> => {
    const row = (await tx.query<{ status: string; expires_at: Date | string }>(`SELECT status, expires_at FROM client_invites WHERE location_id = $1 AND id = $2 FOR UPDATE`, [locationId, invite.id]))[0]
    // Single use: a second submission, an expired or cancelled invitation all land here.
    if (!row || row.status !== 'sent' || new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, error: 'closed' }

    const contacts = new ContactsRepo(tx, locationId)
    // An adult who is already in the book (under any of their emails) is that client, not a new one.
    const known =
      invite.kind === 'adult'
        ? (await tx.query<{ id: string }>('SELECT id FROM contacts WHERE location_id = $1 AND archived_at IS NULL AND emails @> ARRAY[$2]::text[] ORDER BY created_at LIMIT 1', [locationId, invite.email]))[0]
        : undefined
    const { contact, created } = known
      ? { contact: (await contacts.get(known.id))!, created: false }
      : invite.kind === 'adult'
        // Matched by the invited EMAIL alone (the phone a person types must not split one client into two).
        ? await contacts.upsertByMatchFlagged({ name: fullName, email: invite.email }, 'invite')
        : await contacts.upsertByMatchFlagged({ name: fullName }, 'invite') // keyless: always a new record

    if (created) {
      await tx.query('UPDATE contacts SET first_name = $3, last_name = $4 WHERE location_id = $1 AND id = $2', [locationId, contact.id, input.firstName.trim(), input.lastName.trim()])
    }
    const phone = input.phone?.trim()
    if (invite.kind === 'adult' && phone && (created || !(contact.phones ?? []).length)) {
      await tx.query('UPDATE contacts SET phones = ARRAY[$3]::text[], updated_at = now() WHERE location_id = $1 AND id = $2', [locationId, contact.id, normalizePhone(phone)])
    }
    const recorded = contact.custom_fields?.date_of_birth
    const custom: Record<string, unknown> = {}
    if (created || !recorded) custom.date_of_birth = input.dateOfBirth
    // An existing client answering differently is flagged for review; their recorded date is never replaced.
    else if (recorded !== input.dateOfBirth) custom.intake_conflicts = { ...((contact.custom_fields?.intake_conflicts as object) ?? {}), date_of_birth: { record: String(recorded), answered: input.dateOfBirth } }
    if (invite.kind === 'guardian') {
      custom.guardian_name = guardianName
      custom.guardian_email = invite.email
      if (input.guardianPhone?.trim()) custom.guardian_phone = input.guardianPhone.trim()
    }
    if (Object.keys(custom).length) {
      await tx.query(`UPDATE contacts SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $3::jsonb, updated_at = now() WHERE location_id = $1 AND id = $2`, [locationId, contact.id, JSON.stringify(custom)])
    }

    await tx.query(`UPDATE client_invites SET status = 'completed', completed_at = $3, contact_id = $4 WHERE location_id = $1 AND id = $2`, [locationId, invite.id, now.toISOString(), contact.id])
    if (created) {
      await audit(tx, locationId, { action: 'contact.created', entityType: 'contact', entityId: contact.id, contactId: contact.id, details: { source: 'invite', kind: invite.kind, fields: ['name', 'date_of_birth', invite.kind === 'adult' ? 'email' : 'guardian'] }, ...who })
    }
    await audit(tx, locationId, { action: 'invite.completed', entityType: 'client_invite', entityId: invite.id, contactId: contact.id, details: { kind: invite.kind, newClient: created }, ...who })
    return { ok: true, contactId: contact.id, created }
  })
}


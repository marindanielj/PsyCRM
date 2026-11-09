import type { Database } from '../db/database'
import { type AuditEntry, audit } from './audit'

/**
 * Opening the documents asks for a code. Normally the system emails it. A practice can also turn on
 * "codes given by the therapist": she asks for a code in the app and reads it to the person by phone
 * or in person, so the flow does not stop when email is unavailable (e.g. SES still in sandbox).
 *
 * It is weaker: the code no longer proves the person controls that email, it relies on the therapist
 * knowing who she is talking to. So it is OFF by default, switched on deliberately, audited, and every
 * document signed that way says so (`verified_via = 'therapist_code'`).
 */
export const THERAPIST_CODE_TTL_MS = 30 * 60_000

export async function therapistCodesEnabled(db: Database, locationId: string): Promise<boolean> {
  const rows = await db.query<{ on: boolean | null }>(
    "SELECT (settings -> 'documentVerification' ->> 'therapistCode')::boolean AS on FROM locations WHERE id = $1",
    [locationId],
  )
  return rows[0]?.on === true
}

export async function setTherapistCodes(db: Database, locationId: string, on: boolean, ctx: Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE locations
          SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{documentVerification}', $2::jsonb, true)
        WHERE id = $1`,
      [locationId, JSON.stringify({ therapistCode: on })],
    )
    await audit(tx, locationId, { action: 'document.verification_changed', entityType: 'location', entityId: locationId, details: { therapistCode: on }, ...ctx })
  })
}

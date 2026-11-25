import type { Database } from '../db/database'
import { seedFamilyId } from './document-seed'

/** The seeded "Consentimiento para telepsicología" template family (document-seed-content.ts, slug `telepsychology`). */
export const TELEPSYCHOLOGY_FAMILY = seedFamilyId('telepsychology')

/**
 * Has this client (or their guardian, for a minor) signed the telepsychology consent, in any version of it?
 * Advice only: a video session with no consent on file still goes ahead, the therapist is just told.
 */
export async function hasTelepsychologyConsent(db: Database, locationId: string, contactId: string): Promise<boolean> {
  const rows = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM signed_documents s JOIN document_templates t ON t.id = s.template_id
      WHERE s.location_id = $1 AND s.contact_id = $2 AND t.family_id = $3 LIMIT 1`,
    [locationId, contactId, TELEPSYCHOLOGY_FAMILY],
  )
  return rows.length > 0
}

import type { Database } from '../db/database'

/** The practice profile stored under locations.settings.practice. Strings are
 *  free text on purpose (fees like "$100", an address block) — they feed document
 *  merge fields and the printed note letterhead, not arithmetic. */
export interface PracticeProfile {
  name: string
  therapist: string
  license: string
  address: string
  phone: string
  email: string
  fees: { session: string; intake: string; late_cancel: string }
  policy: { cancel_hours: string }
}

export const EMPTY_PRACTICE: PracticeProfile = {
  name: '',
  therapist: '',
  license: '',
  address: '',
  phone: '',
  email: '',
  fees: { session: '', intake: '', late_cancel: '' },
  policy: { cancel_hours: '24' },
}

/** Merge whatever is stored over the empty profile so callers always get every key. */
export function normalizePractice(raw: unknown): PracticeProfile {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
  const fees = (typeof r.fees === 'object' && r.fees !== null ? r.fees : {}) as Record<string, unknown>
  const policy = (typeof r.policy === 'object' && r.policy !== null ? r.policy : {}) as Record<string, unknown>
  return {
    name: str(r.name, ''),
    therapist: str(r.therapist, ''),
    license: str(r.license, ''),
    address: str(r.address, ''),
    phone: str(r.phone, ''),
    email: str(r.email, ''),
    fees: {
      session: str(fees.session, ''),
      intake: str(fees.intake, ''),
      late_cancel: str(fees.late_cancel, ''),
    },
    policy: { cancel_hours: str(policy.cancel_hours, EMPTY_PRACTICE.policy.cancel_hours) },
  }
}

/**
 * Reads/writes locations.settings.practice for ONE location. Takes the
 * locationId explicitly (a location IS the tenant root, like LocationsRepo) and
 * only ever touches that row's `practice` key — other settings are left alone.
 */
export class PracticeRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  async get(): Promise<PracticeProfile> {
    const rows = await this.db.query<{ settings: Record<string, unknown> | null }>(
      'SELECT settings FROM locations WHERE id=$1',
      [this.locationId],
    )
    return normalizePractice(rows[0]?.settings?.practice)
  }

  async save(profile: PracticeProfile): Promise<PracticeProfile> {
    const rows = await this.db.query<{ settings: Record<string, unknown> | null }>(
      `UPDATE locations
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{practice}', $2::jsonb, true)
       WHERE id=$1 RETURNING settings`,
      [this.locationId, JSON.stringify(profile)],
    )
    return normalizePractice(rows[0]?.settings?.practice)
  }
}

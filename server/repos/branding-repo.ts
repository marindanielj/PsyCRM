import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'
import { sha256Hex } from '../lib/document-tokens'
import { type Branding, type LogoType, normalizeBranding } from '../lib/branding'

type Ctx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

/** Reads and writes ONE location's branding (the name and colour live in `locations.branding`; the logo in `location_logos`). */
export class BrandingRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  async get(): Promise<Branding> {
    const r = (await this.db.query<{ branding: unknown }>('SELECT branding FROM locations WHERE id = $1', [this.locationId]))[0]
    return normalizeBranding(r?.branding)
  }

  /** Change the name and/or colour (`null` clears one). Other keys of the stored object are untouched. */
  async saveLook(patch: { name?: string | null; color?: string | null }, ctx: Ctx): Promise<Branding> {
    return this.db.transaction(async (tx) => {
      const sets: Record<string, string | null> = {}
      if (patch.name !== undefined) sets.name = patch.name
      if (patch.color !== undefined) sets.color = patch.color
      await this.merge(tx, sets)
      await audit(tx, this.locationId, { action: 'practice.branding_updated', entityType: 'location', entityId: this.locationId, details: { fields: Object.keys(sets) }, ...ctx })
      return new BrandingRepo(tx, this.locationId).get()
    })
  }

  async putLogo(type: LogoType, data: Buffer, ctx: Ctx): Promise<Branding> {
    const version = sha256Hex(data).slice(0, 8)
    return this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO location_logos (location_id, content_type, data) VALUES ($1,$2,$3)
         ON CONFLICT (location_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
        [this.locationId, type, data],
      )
      await this.merge(tx, { logoVersion: version })
      await audit(tx, this.locationId, { action: 'practice.branding_updated', entityType: 'location', entityId: this.locationId, details: { fields: ['logo'] }, ...ctx })
      return new BrandingRepo(tx, this.locationId).get()
    })
  }

  async removeLogo(ctx: Ctx): Promise<Branding> {
    return this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM location_logos WHERE location_id = $1', [this.locationId])
      await this.merge(tx, { logoVersion: null })
      await audit(tx, this.locationId, { action: 'practice.branding_updated', entityType: 'location', entityId: this.locationId, details: { fields: ['logo_removed'] }, ...ctx })
      return new BrandingRepo(tx, this.locationId).get()
    })
  }

  private async merge(tx: Database, sets: Record<string, string | null>): Promise<void> {
    // A null removes the key; anything else is set. `jsonb_strip_nulls` drops the nulls in one pass.
    await tx.query(
      `UPDATE locations SET branding = jsonb_strip_nulls(COALESCE(branding, '{}'::jsonb) || $2::jsonb) WHERE id = $1`,
      [this.locationId, JSON.stringify(sets)],
    )
  }
}

/** The logo's bytes, for the public image route (not location-scoped by an operator: anyone may see a practice's logo). */
export async function readLogo(db: Database, locationId: string): Promise<{ type: LogoType; data: Buffer } | null> {
  const r = (await db.query<{ content_type: LogoType; data: Buffer }>('SELECT content_type, data FROM location_logos WHERE location_id = $1', [locationId]))[0]
  return r ? { type: r.content_type, data: Buffer.from(r.data) } : null
}

/** The name clients see: the branding name when the practice set one, else the practice's own name. */
export async function displayName(db: Database, locationId: string): Promise<string> {
  const r = (await db.query<{ branding: unknown; settings: { practice?: { name?: unknown } } | null }>('SELECT branding, settings FROM locations WHERE id = $1', [locationId]))[0]
  const branded = normalizeBranding(r?.branding).name
  const practice = typeof r?.settings?.practice?.name === 'string' ? r.settings.practice.name : ''
  return branded ?? practice
}

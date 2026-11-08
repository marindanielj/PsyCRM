import type { Database } from '../db/database'
import { SEED_PACKETS, SEED_TEMPLATES } from './document-seed-content'
import { fieldsSchema } from './document-vocab'

/** Family ids of the starter templates are stable, so seeding twice never duplicates anything. */
export const seedFamilyId = (slug: string) => `seed_${slug}`

/**
 * Create the starter templates (as DRAFTS) and packets for one location. Idempotent:
 * anything already there is left untouched, including edits the therapist made.
 */
export async function seedDocuments(db: Database, locationId: string): Promise<{ templates: number; packets: number }> {
  let templates = 0
  let packets = 0
  for (const t of SEED_TEMPLATES) {
    const fields = fieldsSchema.parse(t.fields) // a broken seed fails loudly, not in production
    const family = seedFamilyId(t.slug)
    const rows = await db.query(
      `INSERT INTO document_templates (id, location_id, family_id, translation_group_id, locale, version, status, kind, title, body_md, fields, signature, signer_roles)
       VALUES ($1,$2,$3,$4,'es',1,'draft',$5,$6,$7,$8::jsonb,$9::jsonb,$10)
       ON CONFLICT (location_id, family_id, version) DO NOTHING RETURNING id`,
      [`${family}_v1_${locationId}`, locationId, family, `seed_tg_${t.slug}`, t.kind, t.title, t.bodyMd, JSON.stringify(fields),
        JSON.stringify({ required: true, drawn: true }), t.signerRoles],
    )
    templates += rows.length
  }
  for (const p of SEED_PACKETS) {
    const rows = await db.query(
      `INSERT INTO document_packets (id, location_id, name, description, family_ids, audience)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [`seed_packet_${p.slug}_${locationId}`, locationId, p.name, p.description, p.slugs.map(seedFamilyId), p.audience],
    )
    packets += rows.length
  }
  return { templates, packets }
}

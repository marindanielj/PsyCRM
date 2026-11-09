import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'
import { sha256Hex } from '../lib/document-tokens'
import { type Branding, type LogoType, normalizeBranding } from '../lib/branding'
import { type PageInput, type PublicPageConfig, RESERVED_SLUGS, missingForPublish, normalizePage } from '../lib/public-page'
import { type PracticeProfile, normalizePractice } from './practice-repo'

type Ctx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

export type SaveResult =
  | { ok: true; page: PublicPageConfig; slug: string | null }
  | { ok: false; error: 'incomplete'; missing: string[] }
  | { ok: false; error: 'slug_taken' | 'slug_reserved' }

const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505'

/** Reads and writes ONE practice's public page: its text and settings, its address (`public_slug`), and its banner picture. */
export class PublicPageRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  async get(): Promise<{ page: PublicPageConfig; slug: string | null }> {
    const r = (await this.db.query<{ page: unknown; slug: string | null }>("SELECT settings -> 'publicPage' AS page, public_slug AS slug FROM locations WHERE id = $1", [this.locationId]))[0]
    return { page: normalizePage(r?.page), slug: r?.slug ?? null }
  }

  /** Save the editor's content. A page goes live only with an address and a headline; an address belongs to one practice. */
  async save(input: PageInput, ctx: Ctx): Promise<SaveResult> {
    const { slug, ...rest } = input
    if (slug && RESERVED_SLUGS.has(slug)) return { ok: false, error: 'slug_reserved' }
    const before = await this.get()
    const next = normalizePage({ ...rest, bannerVersion: before.page.bannerVersion })
    if (next.enabled) {
      const missing = missingForPublish(next, slug)
      if (missing.length) return { ok: false, error: 'incomplete', missing }
    }
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE locations
              SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{publicPage}', $2::jsonb, true), public_slug = $3
            WHERE id = $1`,
          [this.locationId, JSON.stringify(next), slug],
        )
        const changed = (Object.keys(next) as (keyof PublicPageConfig)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before.page[k]))
        if (slug !== before.slug) changed.push('slug' as never)
        if (changed.length) await audit(tx, this.locationId, { action: 'publicpage.updated', entityType: 'location', entityId: this.locationId, details: { fields: changed }, ...ctx })
      })
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, error: 'slug_taken' }
      throw e
    }
    return { ok: true, page: next, slug }
  }

  async putBanner(type: LogoType, data: Buffer, ctx: Ctx): Promise<PublicPageConfig> {
    const version = sha256Hex(data).slice(0, 8)
    return this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO location_banners (location_id, content_type, data) VALUES ($1,$2,$3)
         ON CONFLICT (location_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
        [this.locationId, type, data],
      )
      await this.setBannerVersion(tx, version)
      await audit(tx, this.locationId, { action: 'publicpage.banner_updated', entityType: 'location', entityId: this.locationId, details: { removed: false }, ...ctx })
      return (await new PublicPageRepo(tx, this.locationId).get()).page
    })
  }

  async removeBanner(ctx: Ctx): Promise<PublicPageConfig> {
    return this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM location_banners WHERE location_id = $1', [this.locationId])
      await this.setBannerVersion(tx, null)
      await audit(tx, this.locationId, { action: 'publicpage.banner_updated', entityType: 'location', entityId: this.locationId, details: { removed: true }, ...ctx })
      return (await new PublicPageRepo(tx, this.locationId).get()).page
    })
  }

  private async setBannerVersion(tx: Database, version: string | null): Promise<void> {
    await tx.query(
      `UPDATE locations
          SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{publicPage}', COALESCE(settings -> 'publicPage', '{}'::jsonb) || $2::jsonb, true)
        WHERE id = $1`,
      [this.locationId, JSON.stringify({ bannerVersion: version })],
    )
  }
}

export interface PublicPageContext {
  locationId: string
  slug: string
  page: PublicPageConfig
  practice: PracticeProfile
  branding: Branding
}

/** The page behind an address, or null for an unknown one. Does NOT check `enabled`: the caller decides what a disabled page shows. */
export async function findPageBySlug(db: Database, slug: string): Promise<PublicPageContext | null> {
  const r = (await db.query<{ id: string; page: unknown; practice: unknown; branding: unknown }>(
    "SELECT id, settings -> 'publicPage' AS page, settings -> 'practice' AS practice, branding FROM locations WHERE public_slug = $1",
    [slug],
  ))[0]
  if (!r) return null
  return { locationId: r.id, slug, page: normalizePage(r.page), practice: normalizePractice(r.practice), branding: normalizeBranding(r.branding) }
}

export async function readBanner(db: Database, locationId: string): Promise<{ type: LogoType; data: Buffer } | null> {
  const r = (await db.query<{ content_type: LogoType; data: Buffer }>('SELECT content_type, data FROM location_banners WHERE location_id = $1', [locationId]))[0]
  return r ? { type: r.content_type, data: Buffer.from(r.data) } : null
}

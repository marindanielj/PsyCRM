import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { auditContext } from '../lib/audit'
import { detectLogoType, logoUrl, readableBrand } from '../lib/branding'
import { BANNER_MAX_BYTES, SUGGESTED_QUESTIONS, decodeBannerDataUrl, pageSchema, suggestSlug } from '../lib/public-page'
import { renderPublicPage } from '../lib/public-page-html'
import { InquiriesRepo } from '../repos/inquiries-repo'
import { PublicPageRepo } from '../repos/public-page-repo'
import { PracticeRepo } from '../repos/practice-repo'
import { BrandingRepo } from '../repos/branding-repo'
import { randomBytes } from 'node:crypto'

const bannerSchema = z.object({ dataUrl: z.string().max(Math.ceil((BANNER_MAX_BYTES * 4) / 3) + 100) })

/** Settings → Public page, at /api/loc/:loc/public-page behind operatorAuth + locationAccess. */
export function publicPageAdminRoute(deps: { db: Database; publicBaseUrl?: string }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const repo = (c: Context<AppEnv>) => new PublicPageRepo(deps.db, c.get('locationId'))
  const base = (c: Context<AppEnv>) => (deps.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/$/, '')

  app.get('/', async (c) => {
    const { page, slug } = await repo(c).get()
    const practice = await new PracticeRepo(deps.db, c.get('locationId')).get()
    const branding = await new BrandingRepo(deps.db, c.get('locationId')).get()
    return c.json({
      page,
      slug,
      url: slug ? `${base(c)}/p/${slug}` : null,
      suggestedSlug: suggestSlug(branding.name ?? practice.name),
      suggestedQuestions: SUGGESTED_QUESTIONS,
      practiceName: branding.name ?? practice.name,
      fees: practice.fees,
      bannerUrl: slug && page.bannerVersion ? `/p/${slug}/banner?v=${page.bannerVersion}` : null,
    })
  })

  app.put('/', zValidator('json', pageSchema), async (c) => {
    const r = await repo(c).save(c.req.valid('json'), auditContext(c))
    if (!r.ok) return c.json(r.error === 'incomplete' ? { error: r.error, missing: r.missing } : { error: r.error }, r.error === 'slug_taken' ? 409 : 422)
    return c.json({ ok: true, page: r.page, slug: r.slug, url: r.slug ? `${base(c)}/p/${r.slug}` : null })
  })

  // The banner picture. What it IS is decided by its first bytes.
  app.put('/banner', zValidator('json', bannerSchema), async (c) => {
    const bytes = decodeBannerDataUrl(c.req.valid('json').dataUrl)
    if (!bytes) return c.json({ error: 'invalid_banner' }, 422)
    if (bytes.length > BANNER_MAX_BYTES) return c.json({ error: 'banner_too_large' }, 413)
    const type = detectLogoType(bytes)
    if (!type) return c.json({ error: 'invalid_banner' }, 422)
    return c.json({ ok: true, page: await repo(c).putBanner(type, bytes, auditContext(c)) })
  })
  app.delete('/banner', async (c) => c.json({ ok: true, page: await repo(c).removeBanner(auditContext(c)) }))

  // The page as it will look, before it is public. Opens in a new tab with the operator's session.
  app.get('/preview', async (c) => {
    const loc = c.get('locationId')
    const nonce = randomBytes(16).toString('base64')
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`)
    const { page, slug } = await repo(c).get()
    const practice = await new PracticeRepo(deps.db, loc).get()
    const branding = await new BrandingRepo(deps.db, loc).get()
    return c.html(
      renderPublicPage({
        nonce,
        slug: slug ?? 'su-pagina',
        practice,
        displayName: branding.name ?? practice.name,
        brand: branding.color ? readableBrand(branding.color) : undefined,
        logoUrl: logoUrl(loc, branding),
        page,
        preview: true,
      }),
    )
  })

  return app
}

const handledSchema = z.object({ handled: z.boolean() })
const invitedSchema = z.object({ inviteId: z.string().min(1).max(64) })
const statusQuery = z.object({ status: z.enum(['new', 'invited', 'handled']).optional() })

/** The inbox of requests from the public page, at /api/loc/:loc/inquiries behind operatorAuth + locationAccess. */
export function inquiriesRoute(deps: { db: Database }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const repo = (c: Context<AppEnv>) => new InquiriesRepo(deps.db, c.get('locationId'))

  app.get('/', zValidator('query', statusQuery), async (c) => c.json({ inquiries: await repo(c).list(c.req.valid('query').status), newCount: await repo(c).countNew() }))
  app.get('/count', async (c) => c.json({ newCount: await repo(c).countNew() }))

  app.patch('/:id', zValidator('json', handledSchema), async (c) => {
    const r = await repo(c).setHandled(c.req.param('id'), c.req.valid('json').handled, auditContext(c))
    return r ? c.json({ ok: true, inquiry: r }) : c.json({ error: 'not found' }, 404)
  })

  // After the therapist sent an invitation from a request: remember which one, so the inbox shows it as answered.
  app.post('/:id/invited', zValidator('json', invitedSchema), async (c) => {
    const { inviteId } = c.req.valid('json')
    const exists = await deps.db.query('SELECT 1 FROM client_invites WHERE location_id = $1 AND id = $2', [c.get('locationId'), inviteId])
    if (exists.length === 0) return c.json({ error: 'unknown invitation' }, 400)
    const r = await repo(c).markInvited(c.req.param('id'), inviteId, auditContext(c))
    return r ? c.json({ ok: true, inquiry: r }) : c.json({ error: 'not found' }, 404)
  })

  app.delete('/:id', async (c) => ((await repo(c).remove(c.req.param('id'), auditContext(c))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)))

  return app
}

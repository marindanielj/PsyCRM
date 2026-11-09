import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { logoUrl, readableBrand } from '../lib/branding'
import { clientIp } from '../lib/client-ip'
import { checkInquiry } from '../lib/public-page'
import { renderPageNotFound, renderPublicPage } from '../lib/public-page-html'
import { SlidingWindowRateLimiter } from '../lib/rate-limit'
import { type ResolvedEmailSender, resolveEmailSender } from '../lib/sending/resolve'
import { InquiriesRepo } from '../repos/inquiries-repo'
import { findPageBySlug, readBanner } from '../repos/public-page-repo'

/**
 * A practice's public page, mounted at `/p` outside any session:
 *
 *   GET  /p/:slug          -> the page (404 until the practice publishes it)
 *   GET  /p/:slug/banner   -> its banner picture
 *   POST /p/:slug/inquiry  -> a request for information or an appointment
 *
 * A request is NOT a client: it lands in the therapist's inbox, not in any record. It carries no clinical
 * information (the form says so and has no field for it) and the audit log keeps only its shape.
 */
export function publicPageRoute(deps: {
  db: Database
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  publicBaseUrl?: string
  now?: () => Date
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const clock = () => deps.now?.() ?? new Date()
  const pageHits = new SlidingWindowRateLimiter(120, 15 * 60_000)
  const perIp = new SlidingWindowRateLimiter(5, 60 * 60_000)
  const perPage = new SlidingWindowRateLimiter(60, 60 * 60_000)
  const notified = new Map<string, number>()

  const nonceHeaders = (c: Context<AppEnv>): string => {
    const nonce = randomBytes(16).toString('base64')
    c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`)
    return nonce
  }

  app.get('/:slug', async (c) => {
    const nonce = nonceHeaders(c)
    c.header('Cache-Control', 'no-store')
    if (!pageHits.check(clientIp(c), clock().getTime()).allowed) return c.html(renderPageNotFound(nonce), 429)
    const ctx = await findPageBySlug(deps.db, c.req.param('slug'))
    if (!ctx || !ctx.page.enabled) return c.html(renderPageNotFound(nonce), 404)
    return c.html(
      renderPublicPage({
        nonce,
        slug: ctx.slug,
        practice: ctx.practice,
        displayName: ctx.branding.name ?? ctx.practice.name,
        brand: ctx.branding.color ? readableBrand(ctx.branding.color) : undefined,
        logoUrl: logoUrl(ctx.locationId, ctx.branding),
        page: ctx.page,
      }),
    )
  })

  app.get('/:slug/banner', async (c) => {
    const ctx = await findPageBySlug(deps.db, c.req.param('slug'))
    if (!ctx || !ctx.page.enabled || !ctx.page.bannerVersion) return c.json({ error: 'not found' }, 404)
    const banner = await readBanner(deps.db, ctx.locationId)
    if (!banner) return c.json({ error: 'not found' }, 404)
    return new Response(new Uint8Array(banner.data), {
      headers: {
        'Content-Type': banner.type,
        'Cache-Control': 'public, max-age=3600', // the URL carries the picture's fingerprint
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  })

  app.post('/:slug/inquiry', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (Number(c.req.header('content-length') ?? 0) > 20_000) return c.json({ error: 'invalid' }, 413)
    const now = clock().getTime()
    if (!perIp.check(clientIp(c), now).allowed) return c.json({ error: 'rate_limited' }, 429)
    const ctx = await findPageBySlug(deps.db, c.req.param('slug'))
    if (!ctx || !ctx.page.enabled) return c.json({ error: 'not_found' }, 404)
    if (!perPage.check(ctx.locationId, now).allowed) return c.json({ error: 'rate_limited' }, 429)

    const raw = await c.req.json().catch(() => null)
    if (typeof raw === 'object' && raw !== null && typeof (raw as { website?: unknown }).website === 'string' && (raw as { website: string }).website) return c.json({ ok: true }) // a bot: pretend, store nothing
    const checked = checkInquiry(ctx.page, raw)
    if (!checked.ok) return c.json({ error: checked.error }, 422)

    const ip = clientIp(c)
    const made = await new InquiriesRepo(deps.db, ctx.locationId).create(checked.value, {
      actor: { type: 'client', id: ctx.slug, label: 'Public page form' },
      ip: ip === 'unknown' ? null : ip,
      userAgent: c.req.header('user-agent') ?? null,
    })
    if (!made.duplicate) void tellPractice(ctx.locationId, ctx.practice.email, ctx.branding.name ?? ctx.practice.name, (deps.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/$/, ''), now)
    return c.json({ ok: true })
  })

  /** One email an hour at most, with no name and nothing the person wrote: it only says there is something to read. Best effort. */
  async function tellPractice(locationId: string, to: string, name: string, base: string, now: number): Promise<void> {
    if (!to || now - (notified.get(locationId) ?? 0) < 60 * 60_000) return
    notified.set(locationId, now)
    try {
      const sender = await (deps.resolveEmail ?? resolveEmailSender)(deps.db, locationId)
      if (!sender.ok) return
      await sender.sender.sendEmail({
        to,
        subject: `${name || 'PsyCRM'}: nueva solicitud`,
        text: `Tiene una solicitud nueva de su página pública.\n\nLéala en su bandeja de Contactos: ${base}/contacts\n\nPor privacidad, este correo no incluye datos de la persona.`,
      })
    } catch {
      /* the inbox in the app is the source of truth; an email that did not go out is not an error */
    }
  }

  return app
}

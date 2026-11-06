import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { clientIp } from '../lib/client-ip'
import { BRAND_NAME_MAX, HEX_COLOR, MAX_LOGO_BYTES, decodeDataUrl, detectLogoType, logoUrl } from '../lib/branding'
import { BrandingRepo, readLogo } from '../repos/branding-repo'

const lookSchema = z
  .object({
    name: z.string().trim().max(BRAND_NAME_MAX).nullable().optional(),
    color: z.string().regex(HEX_COLOR).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, { message: 'nothing to change' })

const logoSchema = z.object({ dataUrl: z.string().max(Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 100) })

/** Settings → Branding, at /api/loc/:loc/branding behind operatorAuth + locationAccess. */
export function brandingRoute(deps: { db: Database }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const repo = (c: Context<AppEnv>) => new BrandingRepo(deps.db, c.get('locationId'))
  const ctx = (c: Context<AppEnv>) => {
    const ip = clientIp(c)
    return { actor: { type: 'operator' as const, id: c.get('operatorId') }, ip: ip === 'unknown' ? null : ip, userAgent: c.req.header('user-agent') ?? null }
  }
  const view = (c: Context<AppEnv>, b: Awaited<ReturnType<BrandingRepo['get']>>) => ({ ...b, logoUrl: logoUrl(c.get('locationId'), b) })

  app.get('/', async (c) => c.json({ branding: view(c, await repo(c).get()) }))

  app.put('/', zValidator('json', lookSchema), async (c) => {
    const body = c.req.valid('json')
    const patch = { ...(body.name !== undefined ? { name: body.name && body.name.trim() ? body.name.trim() : null } : {}), ...(body.color !== undefined ? { color: body.color ? body.color.toLowerCase() : null } : {}) }
    return c.json({ ok: true, branding: view(c, await repo(c).saveLook(patch, ctx(c))) })
  })

  // The logo arrives as a data URL; what it IS is decided by its first bytes, never by what it claims to be.
  app.put('/logo', zValidator('json', logoSchema), async (c) => {
    const bytes = decodeDataUrl(c.req.valid('json').dataUrl)
    if (!bytes) return c.json({ error: 'invalid_logo' }, 422)
    if (bytes.length > MAX_LOGO_BYTES) return c.json({ error: 'logo_too_large' }, 413)
    const type = detectLogoType(bytes)
    if (!type) return c.json({ error: 'invalid_logo' }, 422)
    return c.json({ ok: true, branding: view(c, await repo(c).putLogo(type, bytes, ctx(c))) })
  })

  app.delete('/logo', async (c) => c.json({ ok: true, branding: view(c, await repo(c).removeLogo(ctx(c))) }))

  return app
}

/**
 * The public image route (`/brand/:loc/logo`): a practice's logo is shown on pages its clients see, with no
 * session. A logo is not private; nothing else about a practice is served here.
 */
export function brandLogoRoute(deps: { db: Database }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get('/:loc/logo', async (c) => {
    const logo = await readLogo(deps.db, c.req.param('loc'))
    if (!logo) return c.json({ error: 'not found' }, 404)
    return new Response(new Uint8Array(logo.data), {
      headers: {
        'Content-Type': logo.type,
        // The URL carries the logo's fingerprint, so a changed logo is a new URL.
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    })
  })
  return app
}

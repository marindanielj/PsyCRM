import { randomBytes } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { clientIp } from '../lib/client-ip'
import { renderInvalidPage } from '../lib/document-page'
import { hashToken, looksLikeToken } from '../lib/document-tokens'
import { completeInvite } from '../lib/invite-complete'
import { renderInviteDone, renderInviteForm } from '../lib/invite-page'
import { normalizeBranding, logoUrl, readableBrand } from '../lib/branding'
import { enabledModules } from '../lib/modules'
import { SlidingWindowRateLimiter } from '../lib/rate-limit'
import { type InviteContext, findInviteByTokenHash } from '../repos/client-invites-repo'
import { LocationsRepo } from '../repos/locations-repo'
import { PracticeRepo } from '../repos/practice-repo'

const submitSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).optional(),
  dateOfBirth: z.string().trim().max(10),
  guardianName: z.string().trim().max(120).optional(),
  guardianPhone: z.string().trim().max(40).optional(),
  // A field people never see: a bot that fills it in is quietly ignored.
  website: z.string().max(200).optional(),
})

/**
 * The invitation page, mounted at `/i` outside the operator session. The link is one-time and
 * single-use; the person sees nothing but the name and email the therapist typed. Unknown,
 * expired and cancelled links all get the same page.
 *
 *   GET  /i/:token         -> form | thanks | "invalid or expired"
 *   POST /i/:token/submit  -> create the contact (and let onboarding start)
 */
export function publicInvitesRoute(deps: { db: Database; dispatch?: WorkflowDispatch; now?: () => Date }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const clock = () => deps.now?.() ?? new Date()
  const pageHits = new SlidingWindowRateLimiter(60, 15 * 60_000)
  const submits = new SlidingWindowRateLimiter(10, 60 * 60_000)

  const nonceHeaders = (c: import('hono').Context<AppEnv>): string => {
    const nonce = randomBytes(16).toString('base64')
    c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`)
    return nonce
  }

  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
    c.header('X-Robots-Tag', 'noindex, nofollow')
  })

  type Valid = InviteContext & { practice: string; brand?: string; logoUrl?: string; usable: boolean }
  async function resolveLink(token: string): Promise<Valid | null> {
    if (!looksLikeToken(token)) return null
    const ctx = await findInviteByTokenHash(deps.db, hashToken(token))
    if (!ctx) return null
    const location = await new LocationsRepo(deps.db).getById(ctx.locationId)
    if (!location || !enabledModules(location.settings).includes('contacts')) return null
    const { status, expiresAt } = ctx.invite
    const expired = status === 'sent' && new Date(expiresAt).getTime() <= clock().getTime()
    if (status === 'voided' || status === 'expired' || expired) return null
    const practice = await new PracticeRepo(deps.db, ctx.locationId).get()
    const look = normalizeBranding(location.branding)
    return { ...ctx, practice: look.name ?? practice.name, brand: look.color ? readableBrand(look.color) : undefined, logoUrl: logoUrl(ctx.locationId, look) ?? undefined, usable: status === 'sent' }
  }

  app.get('/:token', async (c) => {
    const nonce = nonceHeaders(c)
    if (!pageHits.check(clientIp(c), clock().getTime()).allowed) return c.html(renderInvalidPage(nonce), 429)
    const v = await resolveLink(c.req.param('token'))
    if (!v) return c.html(renderInvalidPage(nonce), 404)
    if (!v.usable) return c.html(renderInviteDone({ practice: v.practice, brand: v.brand, logoUrl: v.logoUrl, nonce }))
    // First time the link is opened: the therapist's list shows "Opened" instead of "Sent".
    if (!v.invite.openedAt) await deps.db.query('UPDATE client_invites SET opened_at = $3 WHERE location_id = $1 AND id = $2 AND opened_at IS NULL', [v.locationId, v.invite.id, clock().toISOString()])
    return c.html(renderInviteForm({ practice: v.practice, brand: v.brand, logoUrl: v.logoUrl, token: c.req.param('token'), nonce, kind: v.invite.kind, name: v.invite.name, email: v.invite.email }))
  })

  app.post('/:token/submit', zValidator('json', submitSchema, (res, c) => (res.success ? undefined : c.json({ error: 'invalid' }, 422))), async (c) => {
    if (Number(c.req.header('content-length') ?? 0) > 20_000) return c.json({ error: 'invalid' }, 413)
    if (!submits.check(clientIp(c), clock().getTime()).allowed) return c.json({ error: 'rate_limited' }, 429)
    const v = await resolveLink(c.req.param('token'))
    if (!v) return c.json({ error: 'closed' }, 404)
    if (!v.usable) return c.json({ error: 'closed' }, 409)
    const body = c.req.valid('json')
    if (body.website) return c.json({ ok: true }) // a bot: pretend, create nothing

    const ip = clientIp(c)
    const r = await completeInvite(deps.db, v.locationId, v.invite, {
      firstName: body.firstName, lastName: body.lastName, phone: body.phone, dateOfBirth: body.dateOfBirth, guardianName: body.guardianName, guardianPhone: body.guardianPhone,
    }, { ip: ip === 'unknown' ? null : ip, userAgent: c.req.header('user-agent') ?? null, now: clock() })
    if (!r.ok) return c.json({ error: r.error }, r.error === 'closed' ? 409 : 422)

    // After the commit: a NEW client starts onboarding (the packet goes out by itself when that automation is on).
    if (r.created) {
      await deps.dispatch?.({ locationId: v.locationId, triggerType: 'contact_created', contactId: r.contactId, payload: { source: 'invite', inviteKind: v.invite.kind }, depth: 0 })
    }
    return c.json({ ok: true })
  })

  return app
}

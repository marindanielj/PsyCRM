import { randomBytes } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { clientAuditContext } from '../lib/audit'
import { renderInvoiceSharePage, renderReceiptSharePage } from '../lib/billing-share-page'
import { normalizeBranding, logoUrl, readableBrand } from '../lib/branding'
import { sendOtpEmail } from '../lib/document-mail'
import { renderInvalidPage, renderVerifyPage } from '../lib/document-page'
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS, SIGNER_SESSION_TTL_MS, checkOtp, createSignerSession, hashOtp, hashToken, looksLikeToken, maskEmail, newOtp, readSignerSession } from '../lib/document-tokens'
import { clientIp } from '../lib/client-ip'
import { enabledModules } from '../lib/modules'
import { SlidingWindowRateLimiter } from '../lib/rate-limit'
import { type ResolvedEmailSender, resolveEmailSender } from '../lib/sending/resolve'
import { BillingInvoicesRepo, PaymentsRepo } from '../repos/billing-documents-repo'
import { BillingSharesRepo, type Share, findShareByTokenHash } from '../repos/billing-shares-repo'
import { LocationsRepo } from '../repos/locations-repo'
import { PracticeRepo } from '../repos/practice-repo'

const verifySchema = z.object({ code: z.string().regex(/^\d{6}$/) })

/**
 * The client side of an emailed invoice or receipt, mounted at `/b` OUTSIDE the operator session. Everything is keyed by the
 * link token (only its hash is stored). Nothing is shown until the one-time code, sent to the address the document was
 * emailed to, was verified. An unknown, expired or voided link all get the same page.
 *
 *   GET  /b/:token         -> verification | the document
 *   POST /b/:token/otp     -> email a 6-digit code
 *   POST /b/:token/verify  -> check the code, set the cookie
 */
export function publicBillingRoute(deps: {
  db: Database
  sessionSecret: string
  secure?: boolean
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  now?: () => Date
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const clock = () => deps.now?.() ?? new Date()
  const otpPerShare = new SlidingWindowRateLimiter(3, 15 * 60_000)
  const otpPerIp = new SlidingWindowRateLimiter(10, 60 * 60_000)
  const verifyPerIp = new SlidingWindowRateLimiter(30, 15 * 60_000)

  type Valid = { share: Share; number: string; practice: string; brand?: string; logoUrl?: string }

  /** The share behind a link, or null for anything that should look like "invalid or expired". */
  async function resolveLink(token: string): Promise<Valid | null> {
    if (!looksLikeToken(token)) return null
    const share = await findShareByTokenHash(deps.db, hashToken(token))
    if (!share || new Date(share.expires_at).getTime() <= clock().getTime()) return null
    const location = await new LocationsRepo(deps.db).getById(share.location_id)
    if (!location || !enabledModules(location.settings).includes('billing')) return null
    const number = await liveNumber(share)
    if (!number) return null
    const practice = await new PracticeRepo(deps.db, share.location_id).get()
    const look = normalizeBranding(location.branding)
    return { share, number, practice: look.name ?? practice.name, brand: look.color ? readableBrand(look.color) : undefined, logoUrl: logoUrl(share.location_id, look) ?? undefined }
  }

  /** The document's number while it is still valid (a voided one is gone for the client), else null. */
  async function liveNumber(share: Share): Promise<string | null> {
    if (share.kind === 'invoice') {
      const inv = await new BillingInvoicesRepo(deps.db, share.location_id).get(share.document_id)
      return inv && !inv.voided_at && inv.contact_id === share.contact_id ? inv.number : null
    }
    const rec = await new PaymentsRepo(deps.db, share.location_id).getReceipt(share.document_id)
    return rec && !rec.voided_at && rec.contact_id === share.contact_id ? rec.number : null
  }

  const cookieName = (id: string) => `bs_${id}`
  const isVerified = (c: Context<AppEnv>, v: Valid) => readSignerSession(getCookie(c, cookieName(v.share.id)), deps.sessionSecret, clock().getTime()) === v.share.id

  function htmlHeaders(c: Context<AppEnv>): string {
    const nonce = randomBytes(16).toString('base64')
    c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`)
    return nonce
  }

  // Never cache, never index; the global middleware adds the other security headers.
  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
    c.header('X-Robots-Tag', 'noindex, nofollow')
  })

  app.get('/:token', async (c) => {
    const token = c.req.param('token')
    const nonce = htmlHeaders(c)
    const v = await resolveLink(token)
    if (!v) return c.html(renderInvalidPage(nonce), 404)
    const base = { practice: v.practice, brand: v.brand, logoUrl: v.logoUrl, nonce }
    if (!isVerified(c, v)) {
      return c.html(renderVerifyPage({ ...base, maskedEmail: maskEmail(v.share.email), token, locked: v.share.otp_attempts >= OTP_MAX_ATTEMPTS, basePath: '/b/' }))
    }
    const { share } = v
    if (share.kind === 'invoice') {
      const invoice = await new BillingInvoicesRepo(deps.db, share.location_id).get(share.document_id)
      return invoice ? c.html(renderInvoiceSharePage({ ...base, invoice })) : c.html(renderInvalidPage(nonce), 404)
    }
    const receipt = await new PaymentsRepo(deps.db, share.location_id).getReceipt(share.document_id)
    return receipt ? c.html(renderReceiptSharePage({ ...base, receipt })) : c.html(renderInvalidPage(nonce), 404)
  })

  app.post('/:token/otp', async (c) => {
    const v = await resolveLink(c.req.param('token'))
    if (!v) return c.json({ error: 'invalid_link' }, 404)
    if (v.share.otp_attempts >= OTP_MAX_ATTEMPTS) return c.json({ error: 'locked' }, 423)
    const now = clock().getTime()
    if (!otpPerShare.check(v.share.id, now).allowed || !otpPerIp.check(clientIp(c), now).allowed) return c.json({ error: 'rate_limited' }, 429)
    const sender = await (deps.resolveEmail ?? resolveEmailSender)(deps.db, v.share.location_id)
    const code = newOtp()
    await new BillingSharesRepo(deps.db, v.share.location_id).storeOtp(v.share.id, hashOtp(code), new Date(now + OTP_TTL_MS))
    const r = await sendOtpEmail(sender.ok ? sender.sender : null, sender.ok ? undefined : sender.reason, { practice: v.practice || 'Su terapeuta', to: v.share.email, name: '', code })
    return r.sent ? c.json({ ok: true }) : c.json({ error: 'email_unavailable' }, 503)
  })

  app.post('/:token/verify', zValidator('json', verifySchema, (res, c) => (res.success ? undefined : c.json({ error: 'code_invalid' }, 401))), async (c) => {
    const v = await resolveLink(c.req.param('token'))
    if (!v) return c.json({ error: 'invalid_link' }, 404)
    if (v.share.otp_attempts >= OTP_MAX_ATTEMPTS) return c.json({ error: 'locked' }, 423)
    if (!verifyPerIp.check(clientIp(c), clock().getTime()).allowed) return c.json({ error: 'rate_limited' }, 429)
    const repo = new BillingSharesRepo(deps.db, v.share.location_id)
    const expired = !v.share.otp_expires_at || new Date(v.share.otp_expires_at).getTime() <= clock().getTime()
    if (!expired && checkOtp(c.req.valid('json').code, v.share.otp_hash)) {
      await repo.markVerified(v.share, v.number, clientAuditContext(c, 'Client (emailed link)', v.share.contact_id))
      setCookie(c, cookieName(v.share.id), createSignerSession(v.share.id, deps.sessionSecret, { now: clock().getTime() }), {
        httpOnly: true, secure: deps.secure ?? false, sameSite: 'Strict', path: '/b/', maxAge: SIGNER_SESSION_TTL_MS / 1000,
      })
      return c.json({ ok: true })
    }
    const attempts = await repo.failOtp(v.share.id)
    if (attempts >= OTP_MAX_ATTEMPTS) return c.json({ error: 'locked' }, 423)
    return c.json({ error: 'code_invalid', remaining: OTP_MAX_ATTEMPTS - attempts }, 401)
  })

  return app
}

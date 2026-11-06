import { randomBytes } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { todayIn } from '../lib/age'
import { clientIp } from '../lib/client-ip'
import { sendCopyEmail, sendOtpEmail } from '../lib/document-mail'
import {
  type ChecklistItem, renderChecklistPage, renderCopyPage, renderDocumentPage, renderDonePage, renderInvalidPage,
  renderSignedViewPage, renderVerifyPage, snapshotBody,
} from '../lib/document-page'
import { renderDocumentBody } from '../lib/document-render'
import { COPY_WINDOW_MS, OTP_MAX_ATTEMPTS, OTP_TTL_MS, SIGNER_SESSION_TTL_MS, checkOtp, createSignerSession, hashOtp, hashToken, looksLikeToken, maskEmail, newOtp, readSignerSession } from '../lib/document-tokens'
import { normalizeBranding, logoUrl, readableBrand } from '../lib/branding'
import { enabledModules } from '../lib/modules'
import { SlidingWindowRateLimiter } from '../lib/rate-limit'
import { type ResolvedEmailSender, resolveEmailSender } from '../lib/sending/resolve'
import { ContactsRepo } from '../repos/contacts-repo'
import { type PublicActor, DocumentRequestsRepo, type SignerContext, findSignerByTokenHash, isSignaturePng } from '../repos/document-requests-repo'
import { LocationsRepo } from '../repos/locations-repo'
import { PracticeRepo } from '../repos/practice-repo'

const verifySchema = z.object({ code: z.string().regex(/^\d{6}$/) })
const draftSchema = z.object({ templateId: z.string().min(1).max(64), values: z.record(z.string().max(100), z.unknown()) })
const signSchema = z.object({
  values: z.record(z.string().max(100), z.unknown()),
  signerName: z.string().max(200),
  signaturePng: z.string().nullable(),
  agreeTerms: z.boolean(),
  esignConsent: z.boolean(),
})
/** A drawn signature is at most 100 KB; the body gets some room for the answers. */
const MAX_BODY_BYTES = 400 * 1024

/**
 * The client-facing signing flow, mounted at `/d` OUTSIDE the operator session. Everything
 * is keyed by the link token (only its hash is stored). Nothing about a client is shown
 * until the one-time code was verified; an unknown, expired or voided link all get the
 * same page.
 *
 *   GET  /d/:token            -> verification | checklist | document | done  (by state)
 *   POST /d/:token/otp        -> email a 6-digit code
 *   POST /d/:token/verify     -> check the code, set the signer cookie
 *   POST /d/:token/draft      -> save progress
 *   POST /d/:token/sign/:tid  -> sign one document
 *   GET  /d/:token/copy       -> printable copy of the signer's documents
 */
export function publicDocumentsRoute(deps: {
  db: Database
  sessionSecret: string
  secure?: boolean
  dispatch?: WorkflowDispatch
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  publicBaseUrl?: string
  now?: () => Date
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const clock = () => deps.now?.() ?? new Date()
  const otpPerSigner = new SlidingWindowRateLimiter(3, 15 * 60_000)
  const otpPerIp = new SlidingWindowRateLimiter(10, 60 * 60_000)
  const verifyPerIp = new SlidingWindowRateLimiter(30, 15 * 60_000)
  // A person signs a handful of documents; this only stops a script hammering the endpoints with a stolen session.
  const writesPerSigner = new SlidingWindowRateLimiter(60, 10 * 60_000)

  type Valid = SignerContext & { practice: string; brand?: string; logoUrl?: string }

  /** The signer behind a link, or null for anything that should look like "invalid or expired". */
  async function resolveLink(token: string): Promise<Valid | null> {
    if (!looksLikeToken(token)) return null
    const ctx = await findSignerByTokenHash(deps.db, hashToken(token))
    if (!ctx) return null
    const now = clock()
    const { request } = ctx
    const repo = new DocumentRequestsRepo(deps.db, ctx.locationId)
    if (request.status === 'voided' || request.status === 'expired') return null
    if ((request.status === 'sent' || request.status === 'in_progress') && new Date(request.expiresAt).getTime() <= now.getTime()) {
      await repo.expireDue(now)
      return null
    }
    if (request.status === 'completed' && request.completedAt && now.getTime() > new Date(request.completedAt).getTime() + COPY_WINDOW_MS) return null
    const location = await new LocationsRepo(deps.db).getById(ctx.locationId)
    if (!location || !enabledModules(location.settings).includes('documents')) return null
    const practice = await new PracticeRepo(deps.db, ctx.locationId).get()
    const look = normalizeBranding(location.branding)
    return { ...ctx, practice: look.name ?? practice.name, brand: look.color ? readableBrand(look.color) : undefined, logoUrl: logoUrl(ctx.locationId, look) ?? undefined }
  }

  const cookieName = (signerId: string) => `ds_${signerId}`
  const isVerified = (c: Context<AppEnv>, v: Valid) => readSignerSession(getCookie(c, cookieName(v.signer.id)), deps.sessionSecret, clock().getTime()) === v.signer.id
  const actorOf = (c: Context<AppEnv>, v: Valid): PublicActor => {
    const ip = clientIp(c)
    return { signerId: v.signer.id, role: v.signer.role, ip: ip === 'unknown' ? '0.0.0.0' : ip, userAgent: c.req.header('user-agent') ?? 'unknown' }
  }
  const baseUrl = (c: Context<AppEnv>) => (deps.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/$/, '')

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

  const invalidJson = (c: Context<AppEnv>) => c.json({ error: 'invalid_link' }, 404)

  // --- the page ---------------------------------------------------------------
  app.get('/:token', async (c) => {
    const token = c.req.param('token')
    const nonce = htmlHeaders(c)
    const v = await resolveLink(token)
    if (!v) return c.html(renderInvalidPage(nonce), 404)
    const base = { practice: v.practice, brand: v.brand, logoUrl: v.logoUrl, nonce }

    if (!isVerified(c, v)) {
      return c.html(renderVerifyPage({ ...base, maskedEmail: maskEmail(v.signer.email), token, locked: v.signer.otpAttempts >= OTP_MAX_ATTEMPTS }))
    }

    const repo = new DocumentRequestsRepo(deps.db, v.locationId)
    const docs = (await repo.templatesFor(v.request.id)).filter((t) => t.signerId === v.signer.id)
    const signed = new Map((await repo.signedFor(v.signer.id)).map((s) => [s.templateId, s]))
    const href = (n: number) => `/d/${token}?doc=${n}`
    const firstOpen = docs.findIndex((d) => !signed.has(d.id))

    const requested = Number.parseInt(c.req.query('doc') ?? '', 10)
    if (firstOpen === -1) {
      if (Number.isInteger(requested) && requested >= 1 && requested <= docs.length) return viewSigned(requested)
      return c.html(renderDonePage({ ...base, copyHref: `/d/${token}/copy`, waiting: v.request.status !== 'completed' }))
    }
    if (!Number.isInteger(requested)) {
      if (docs.length === 1) return fill(firstOpen + 1)
      const items: ChecklistItem[] = docs.map((d, i) => ({
        title: d.title,
        state: signed.has(d.id) ? 'signed' : v.signer.draftValues[d.id] ? 'in_progress' : 'pending',
        href: href(i + 1),
      }))
      return c.html(renderChecklistPage({ ...base, signerName: v.signer.name, items }))
    }
    if (requested < 1 || requested > docs.length) return c.redirect(`/d/${token}`)
    return signed.has(docs[requested - 1]!.id) ? viewSigned(requested) : fill(requested)

    function viewSigned(n: number) {
      const doc = docs[n - 1]!
      return c.html(renderSignedViewPage({ ...base, index: n, total: docs.length, bodyHtml: snapshotBody(signed.get(doc.id)!.renderedHtml), backHref: `/d/${token}`, nextHref: n < docs.length ? href(n + 1) : null }))
    }
    async function fill(n: number) {
      const doc = docs[n - 1]!
      const contact = await new ContactsRepo(deps.db, v!.locationId).get(v!.request.contactId)
      const practice = await new PracticeRepo(deps.db, v!.locationId).get()
      const dob = contact?.custom_fields?.date_of_birth
      const draft = (v!.signer.draftValues[doc.id] ?? {}) as Record<string, unknown>
      const fillHtml = renderDocumentBody(
        { title: doc.title, bodyMd: doc.bodyMd, fields: doc.fields, locale: doc.locale, signerRoles: doc.signerRoles },
        { practice, contact: contact ? { first_name: contact.first_name, last_name: contact.last_name, name: contact.name, dateOfBirth: typeof dob === 'string' ? dob : null } : null, today: todayIn(undefined, clock()), mode: 'fill', values: draft },
      )
      const nextOpen = docs.findIndex((d, i) => i !== n - 1 && !signed.has(d.id) && i > n - 1)
      return c.html(renderDocumentPage({
        ...base, token, templateId: doc.id, index: n, total: docs.length, title: doc.title, fillHtml, signerName: v!.signer.name, drawn: doc.signature.drawn,
        nextHref: nextOpen === -1 ? `/d/${token}` : href(nextOpen + 1), checklistHref: docs.length > 1 ? `/d/${token}` : null,
      }))
    }
  })

  // --- the one-time code --------------------------------------------------------
  app.post('/:token/otp', async (c) => {
    const v = await resolveLink(c.req.param('token'))
    if (!v) return invalidJson(c)
    if (v.signer.otpAttempts >= OTP_MAX_ATTEMPTS) return c.json({ error: 'locked' }, 423)
    const now = clock().getTime()
    if (!otpPerSigner.check(v.signer.id, now).allowed || !otpPerIp.check(clientIp(c), now).allowed) return c.json({ error: 'rate_limited' }, 429)

    const sender = await (deps.resolveEmail ?? resolveEmailSender)(deps.db, v.locationId)
    const code = newOtp()
    await new DocumentRequestsRepo(deps.db, v.locationId).storeOtp(v.signer.id, hashOtp(code), new Date(now + OTP_TTL_MS))
    const r = await sendOtpEmail(sender.ok ? sender.sender : null, sender.ok ? undefined : sender.reason, { practice: v.practice || 'Su terapeuta', to: v.signer.email, name: v.signer.name, code })
    return r.sent ? c.json({ ok: true }) : c.json({ error: 'email_unavailable' }, 503)
  })

  app.post('/:token/verify', zValidator('json', verifySchema, (res, c) => (res.success ? undefined : c.json({ error: 'code_invalid' }, 401))), async (c) => {
    const v = await resolveLink(c.req.param('token'))
    if (!v) return invalidJson(c)
    if (v.signer.otpAttempts >= OTP_MAX_ATTEMPTS) return c.json({ error: 'locked' }, 423)
    if (!verifyPerIp.check(clientIp(c), clock().getTime()).allowed) return c.json({ error: 'rate_limited' }, 429)
    const repo = new DocumentRequestsRepo(deps.db, v.locationId)
    const expired = !v.signer.otpExpiresAt || new Date(v.signer.otpExpiresAt).getTime() <= clock().getTime()
    if (!expired && checkOtp(c.req.valid('json').code, v.signer.otpHash)) {
      await repo.markVerified(v.signer.id, actorOf(c, v))
      setCookie(c, cookieName(v.signer.id), createSignerSession(v.signer.id, deps.sessionSecret, { now: clock().getTime() }), {
        httpOnly: true, secure: deps.secure ?? false, sameSite: 'Strict', path: '/d/', maxAge: SIGNER_SESSION_TTL_MS / 1000,
      })
      return c.json({ ok: true })
    }
    const attempts = await repo.failOtp(v.signer.id, actorOf(c, v))
    if (attempts >= OTP_MAX_ATTEMPTS) return c.json({ error: 'locked' }, 423)
    return c.json({ error: 'code_invalid', remaining: OTP_MAX_ATTEMPTS - attempts }, 401)
  })

  /** Everything below needs the verified signer. */
  async function session(c: Context<AppEnv>): Promise<Valid | Response> {
    const v = await resolveLink(c.req.param('token') ?? '')
    if (!v) return invalidJson(c)
    if (!isVerified(c, v)) return c.json({ error: 'verification_required' }, 401)
    return v
  }
  const bodyTooBig = (c: Context<AppEnv>) => Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES

  app.post('/:token/draft', zValidator('json', draftSchema), async (c) => {
    if (bodyTooBig(c)) return c.json({ error: 'too_large' }, 413)
    const v = await session(c)
    if (v instanceof Response) return v
    if (!writesPerSigner.check(v.signer.id, clock().getTime()).allowed) return c.json({ error: 'rate_limited' }, 429)
    if (v.request.status !== 'sent' && v.request.status !== 'in_progress') return c.json({ error: 'request_closed' }, 409)
    const { templateId, values } = c.req.valid('json')
    const repo = new DocumentRequestsRepo(deps.db, v.locationId)
    const t = (await repo.templatesFor(v.request.id)).find((x) => x.id === templateId && x.signerId === v.signer.id)
    if (!t) return c.json({ error: 'template_not_assigned' }, 403)
    // A draft keeps only this document's own fields, in plain shapes (strings, booleans, lists of strings).
    const keep: Record<string, unknown> = {}
    for (const f of t.fields) {
      const x = values[f.key]
      if (typeof x === 'string') keep[f.key] = x.slice(0, 5000)
      else if (typeof x === 'boolean') keep[f.key] = x
      else if (Array.isArray(x)) keep[f.key] = x.filter((i): i is string => typeof i === 'string').slice(0, 50)
    }
    await repo.saveDraft(v.signer.id, templateId, keep)
    return c.json({ ok: true })
  })

  app.post('/:token/sign/:templateId', zValidator('json', signSchema), async (c) => {
    if (bodyTooBig(c)) return c.json({ error: 'signature_too_large' }, 413)
    const v = await session(c)
    if (v instanceof Response) return v
    if (!writesPerSigner.check(v.signer.id, clock().getTime()).allowed) return c.json({ error: 'rate_limited' }, 429)
    const body = c.req.valid('json')
    if (body.signaturePng) {
      const length = body.signaturePng.length
      if (!isSignaturePng(body.signaturePng)) return c.json({ error: 'signature_invalid' }, length > 140_000 ? 413 : 422)
    }
    const token = c.req.param('token')
    const repo = new DocumentRequestsRepo(deps.db, v.locationId)
    const r = await repo.sign({ signerId: v.signer.id, templateId: c.req.param('templateId'), signerName: body.signerName, signaturePng: body.signaturePng, agreeTerms: body.agreeTerms, esignConsent: body.esignConsent, values: body.values, now: clock() }, actorOf(c, v))
    if (!r.ok) {
      const status = r.error === 'template_not_assigned' ? 403 : r.error === 'request_closed' ? 409 : r.error === 'not_found' ? 404 : 422
      return c.json(r.error === 'invalid_answers' ? { error: r.error, issues: r.issues } : { error: r.error }, status)
    }
    if (!r.alreadySigned) {
      // After the commit: let live automations react once per packet, and send the copy link once per signer.
      await deps.dispatch?.({ locationId: v.locationId, triggerType: 'document_signed', contactId: v.request.contactId, payload: { requestId: v.request.id, templateFamilyId: r.templateFamilyId }, depth: 0 })
      if (r.requestCompleted) await deps.dispatch?.({ locationId: v.locationId, triggerType: 'documents_completed', contactId: v.request.contactId, payload: { requestId: v.request.id, packetId: v.request.packetId }, depth: 0 })
      if (r.signerCompleted) {
        const sender = await (deps.resolveEmail ?? resolveEmailSender)(deps.db, v.locationId)
        await sendCopyEmail(sender.ok ? sender.sender : null, sender.ok ? undefined : sender.reason, { practice: v.practice || 'Su terapeuta', to: v.signer.email, name: v.signer.name, link: `${baseUrl(c)}/d/${token}` })
      }
    }
    const docs = (await repo.templatesFor(v.request.id)).filter((t) => t.signerId === v.signer.id)
    const signedIds = new Set((await repo.signedFor(v.signer.id)).map((s) => s.templateId))
    const nextOpen = docs.findIndex((d) => !signedIds.has(d.id))
    return c.json({ ok: true, signedId: r.signed.id, signerCompleted: r.signerCompleted, next: nextOpen === -1 ? `/d/${token}` : `/d/${token}?doc=${nextOpen + 1}` })
  })

  app.get('/:token/copy', async (c) => {
    const nonce = htmlHeaders(c)
    const v = await resolveLink(c.req.param('token'))
    if (!v) return c.html(renderInvalidPage(nonce), 404)
    if (!isVerified(c, v) || v.signer.status !== 'completed') return c.redirect(`/d/${c.req.param('token')}`)
    const repo = new DocumentRequestsRepo(deps.db, v.locationId)
    const docs = await repo.signedFor(v.signer.id)
    await repo.recordDownload(v.signer.id, v.request.contactId, v.request.id, actorOf(c, v))
    return c.html(renderCopyPage({ practice: v.practice, brand: v.brand, logoUrl: v.logoUrl, nonce, docs: docs.map((d) => ({ title: d.title, bodyHtml: snapshotBody(d.renderedHtml) })) }))
  })

  return app
}

import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { clientIp } from '../lib/client-ip'
import { todayIn } from '../lib/age'
import { audit } from '../lib/audit'
import { sendLinkEmail } from '../lib/document-mail'
import { REQUEST_TTL_DAYS, hashToken, newToken } from '../lib/document-tokens'
import { sendDocumentPacket } from '../lib/document-send'
import { renderDocumentHtml, renderPacketHtml, type RenderableTemplate, type RenderContact } from '../lib/document-render'
import { type ResolvedEmailSender, resolveEmailSender } from '../lib/sending/resolve'
import { SIGNER_ROLES, createTemplateSchema, DOCUMENT_MERGE_FIELDS, FIELD_TYPES, packetSchema, patchPacketSchema, patchTemplateSchema } from '../lib/document-vocab'
import { ContactsRepo } from '../repos/contacts-repo'
import { DocumentPacketsRepo } from '../repos/document-packets-repo'
import { DocumentRequestsRepo } from '../repos/document-requests-repo'
import { type DocActor, type DocumentTemplate, DocumentTemplatesRepo, type TemplateError } from '../repos/document-templates-repo'
import { PracticeRepo } from '../repos/practice-repo'
import { displayName } from '../repos/branding-repo'

const previewBody = z.object({ contactId: z.string().min(1).max(64).optional() })

/** A made-up client for previews without a real one: no real person's data is needed to read a template. */
const SAMPLE_CONTACT: RenderContact = { first_name: 'Ana', last_name: 'Rivera', name: 'Ana Rivera', dateOfBirth: '1990-04-12' }

function refuse(c: Context<AppEnv>, r: TemplateError) {
  switch (r.error) {
    case 'not_found':
      return c.json({ error: 'not found' }, 404)
    case 'template_immutable':
      // Active and retired versions never change: make a new version instead.
      return c.json({ error: 'template_immutable' }, 409)
    case 'draft_exists':
      return c.json({ error: 'draft_exists', draftId: r.draftId }, 409)
    case 'not_draft':
      return c.json({ error: 'not_draft' }, 409)
    case 'not_active':
      return c.json({ error: 'not_active' }, 409)
  }
}

function databaseRefusal(c: Context<AppEnv>, err: unknown) {
  const message = String((err as { message?: unknown } | null)?.message ?? '')
  if (/document_template_immutable/.test(message)) return c.json({ error: 'template_immutable' }, 409)
  if (/document_template_status/.test(message)) return c.json({ error: 'not_active' }, 409)
  throw err
}

const asRenderable = (t: DocumentTemplate): RenderableTemplate => ({
  title: t.title, bodyMd: t.bodyMd, fields: t.fields, locale: t.locale, signerRoles: t.signerRoles,
})

/**
 * Document templates and packets for the current location, at /api/loc/:loc/documents
 * behind operatorAuth + locationAccess + the `documents` module. Active and retired
 * versions are immutable (a database trigger); editing one means a new version.
 */
const sendSchema = z.object({
  contactId: z.string().min(1).max(64),
  packetId: z.string().min(1).max(64),
  excludeFamilyIds: z.array(z.string().min(1).max(64)).max(40).default([]),
  signers: z.array(z.object({ role: z.enum(SIGNER_ROLES), name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(200) })).min(1).max(3),
})
const resendSchema = z.object({ signerId: z.string().min(1).max(64), deliver: z.enum(['email', 'none']).default('email') })
const voidSchema = z.object({ reason: z.string().trim().min(1).max(500) })
const requestsQuery = z.object({
  contactId: z.string().min(1).max(64).optional(),
  status: z.enum(['sent', 'in_progress', 'completed', 'expired', 'voided']).optional(),
})

export function documentsRoute(deps: {
  db: Database
  today?: () => string
  /** Builds the email sender for the practice; injectable so tests and dev need no provider. */
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  /** Public origin used in the links (PUBLIC_BASE_URL); falls back to the request's own origin. */
  publicBaseUrl?: string
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const templates = (c: Context<AppEnv>) => new DocumentTemplatesRepo(deps.db, c.get('locationId'))
  const packets = (c: Context<AppEnv>) => new DocumentPacketsRepo(deps.db, c.get('locationId'))
  const actor = (c: Context<AppEnv>): DocActor => {
    const ip = clientIp(c)
    return { operatorId: c.get('operatorId'), ip: ip === 'unknown' ? null : ip, userAgent: c.req.header('user-agent') ?? null }
  }
  const today = () => deps.today?.() ?? todayIn()

  /** The real client when given (their record is opened for the preview), else the sample. */
  async function previewContact(c: Context<AppEnv>, contactId: string | undefined): Promise<RenderContact | null | 'unknown'> {
    if (!contactId) return SAMPLE_CONTACT
    const contact = await new ContactsRepo(deps.db, c.get('locationId')).get(contactId)
    if (!contact) return 'unknown'
    const dob = contact.custom_fields?.date_of_birth
    return {
      first_name: contact.first_name,
      last_name: contact.last_name,
      name: contact.name ?? ([contact.first_name, contact.last_name].filter(Boolean).join(' ') || null),
      dateOfBirth: typeof dob === 'string' ? dob : null,
    }
  }

  app.get('/meta', (c) => c.json({ mergeFields: DOCUMENT_MERGE_FIELDS, fieldTypes: FIELD_TYPES }))

  // --- templates -------------------------------------------------------------
  app.get('/templates', async (c) => c.json({ templates: await templates(c).list() }))

  // Literal paths before /:id so "families" is not read as a template id.
  app.get('/templates/families/:familyId', async (c) => {
    const versions = await templates(c).history(c.req.param('familyId'))
    return versions.length ? c.json({ versions }) : c.json({ error: 'not found' }, 404)
  })

  app.get('/templates/:id', async (c) => {
    const template = await templates(c).get(c.req.param('id'))
    return template ? c.json({ template }) : c.json({ error: 'not found' }, 404)
  })

  app.post('/templates', zValidator('json', createTemplateSchema), async (c) => {
    const template = await templates(c).create(c.req.valid('json'), actor(c))
    return c.json({ ok: true, template }, 201)
  })

  app.patch('/templates/:id', zValidator('json', patchTemplateSchema), async (c) => {
    try {
      const r = await templates(c).update(c.req.param('id'), c.req.valid('json'), actor(c))
      return r.ok ? c.json({ ok: true, template: r.template }) : refuse(c, r)
    } catch (err) {
      return databaseRefusal(c, err)
    }
  })

  app.post('/templates/:id/new-version', async (c) => {
    const r = await templates(c).newVersion(c.req.param('id'), actor(c))
    return r.ok ? c.json({ ok: true, template: r.template }, 201) : refuse(c, r)
  })

  app.post('/templates/:id/activate', async (c) => {
    try {
      const r = await templates(c).activate(c.req.param('id'), actor(c))
      return r.ok ? c.json({ ok: true, template: r.template, retiredVersion: r.retiredVersion }) : refuse(c, r)
    } catch (err) {
      return databaseRefusal(c, err)
    }
  })

  app.post('/templates/:id/retire', async (c) => {
    const r = await templates(c).retire(c.req.param('id'), actor(c))
    return r.ok ? c.json({ ok: true, template: r.template }) : refuse(c, r)
  })

  app.post('/templates/:id/preview', zValidator('json', previewBody), async (c) => {
    const template = await templates(c).get(c.req.param('id'))
    if (!template) return c.json({ error: 'not found' }, 404)
    const contact = await previewContact(c, c.req.valid('json').contactId)
    if (contact === 'unknown') return c.json({ error: 'unknown contact' }, 400)
    const practice = await new PracticeRepo(deps.db, c.get('locationId')).get()
    return c.json({ html: renderDocumentHtml(asRenderable(template), { practice, contact, today: today(), mode: 'preview' }) })
  })

  // --- packets ---------------------------------------------------------------
  app.get('/packets', zValidator('query', z.object({ includeArchived: z.enum(['true', 'false']).optional() })), async (c) => {
    const list = await packets(c).list({ includeArchived: c.req.valid('query').includeArchived === 'true' })
    // Warn (don't block) when a packet names a family with no version in force: it cannot be sent until one is.
    const resolved = await templates(c).resolveFamilies([...new Set(list.flatMap((p) => p.familyIds))])
    const inactive = new Set(resolved.filter((r) => !r.active).map((r) => r.familyId))
    return c.json({ packets: list.map((p) => ({ ...p, inactiveFamilyIds: p.familyIds.filter((f) => inactive.has(f)) })) })
  })

  app.get('/packets/:id', async (c) => {
    const packet = await packets(c).get(c.req.param('id'))
    if (!packet) return c.json({ error: 'not found' }, 404)
    const items = await templates(c).resolveFamilies(packet.familyIds)
    return c.json({
      packet,
      documents: items.map((i) => ({ familyId: i.familyId, templateId: i.template.id, title: i.template.title, version: i.template.version, status: i.template.status, active: i.active })),
    })
  })

  app.post('/packets', zValidator('json', packetSchema), async (c) => {
    const r = await packets(c).create(c.req.valid('json'), actor(c))
    if (!r.ok) return r.error === 'unknown_family' ? c.json({ error: 'unknown_family', familyIds: r.familyIds }, 400) : c.json({ error: 'not found' }, 404)
    return c.json({ ok: true, packet: r.packet }, 201)
  })

  app.patch('/packets/:id', zValidator('json', patchPacketSchema), async (c) => {
    const r = await packets(c).update(c.req.param('id'), c.req.valid('json'), actor(c))
    if (!r.ok) return r.error === 'unknown_family' ? c.json({ error: 'unknown_family', familyIds: r.familyIds }, 400) : c.json({ error: 'not found' }, 404)
    return c.json({ ok: true, packet: r.packet })
  })

  // The whole packet in sequence (active versions; the newest draft/retired one when none is in force).
  app.post('/packets/:id/preview', zValidator('json', previewBody), async (c) => {
    const packet = await packets(c).get(c.req.param('id'))
    if (!packet) return c.json({ error: 'not found' }, 404)
    const contact = await previewContact(c, c.req.valid('json').contactId)
    if (contact === 'unknown') return c.json({ error: 'unknown contact' }, 400)
    const practice = await new PracticeRepo(deps.db, c.get('locationId')).get()
    const items = await templates(c).resolveFamilies(packet.familyIds)
    return c.json({ html: renderPacketHtml(items.map((i) => asRenderable(i.template)), { practice, contact, today: today(), mode: 'preview' }, packet.name) })
  })

  // --- sending for signature (days 6) ----------------------------------------
  const requests = (c: Context<AppEnv>) => new DocumentRequestsRepo(deps.db, c.get('locationId'))
  const baseUrl = (c: Context<AppEnv>) => (deps.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/$/, '')
  const emailSender = (c: Context<AppEnv>) => (deps.resolveEmail ?? resolveEmailSender)(deps.db, c.get('locationId'))

  app.post('/requests', zValidator('json', sendSchema), async (c) => {
    const a = actor(c)
    const r = await sendDocumentPacket(
      { db: deps.db, locationId: c.get('locationId'), today, resolveEmail: deps.resolveEmail, baseUrl: baseUrl(c) },
      c.req.valid('json'),
      { sentBy: a.operatorId, audit: { actor: { type: 'operator', id: a.operatorId }, ip: a.ip, userAgent: a.userAgent } },
    )
    if (!r.ok) return c.json(r.body, r.status)
    return c.json({ ok: true, request: r.request, signers: r.signers.map((s) => ({ ...s })), warnings: r.warnings }, 201)
  })

  async function mailLink(c: Context<AppEnv>, o: { to: string; name: string; token: string }) {
    const name = (await displayName(deps.db, c.get('locationId'))) || 'Su terapeuta'
    const sender = await emailSender(c)
    const link = `${baseUrl(c)}/d/${o.token}`
    const r = await sendLinkEmail(sender.ok ? sender.sender : null, sender.ok ? undefined : sender.reason, { practice: name, to: o.to, name: o.name, link, days: REQUEST_TTL_DAYS })
    return { link, emailed: r.sent, reason: r.reason }
  }

  // Past-deadline requests are closed (with a follow-up task) whenever someone looks.
  app.get('/requests', zValidator('query', requestsQuery), async (c) => {
    await requests(c).expireDue()
    return c.json({ requests: await requests(c).list(c.req.valid('query')) })
  })

  app.get('/requests/:id', async (c) => {
    await requests(c).expireDue()
    const view = await requests(c).get(c.req.param('id'))
    return view ? c.json({ request: view }) : c.json({ error: 'not found' }, 404)
  })

  app.post('/requests/:id/resend', zValidator('json', resendSchema), async (c) => {
    const token = newToken()
    const id = c.req.param('id')
    const { signerId, deliver } = c.req.valid('json')
    const copy = deliver === 'none'
    const r = await requests(c).rotateToken(id, signerId, hashToken(token), actor(c), copy ? 'copy' : 'email')
    if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
    // Copy mode never touches the email provider: the therapist sends the link herself.
    if (copy) return c.json({ ok: true, signer: { id: r.signer.id, role: r.signer.role, link: `${baseUrl(c)}/d/${token}`, emailed: false, emailIssue: null } })
    const m = await mailLink(c, { to: r.signer.email, name: r.signer.name, token })
    return c.json({ ok: true, signer: { id: r.signer.id, role: r.signer.role, link: m.link, emailed: m.emailed, emailIssue: m.reason ?? null } })
  })

  app.post('/requests/:id/void', zValidator('json', voidSchema), async (c) => {
    const r = await requests(c).void(c.req.param('id'), c.req.valid('json').reason, actor(c))
    return r.ok ? c.json({ ok: true, request: r.request }) : c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
  })

  // The therapist looked at a held request (date of birth that did not match) and accepts it as complete.
  app.post('/requests/:id/accept-review', async (c) => {
    const r = await requests(c).acceptHeld(c.req.param('id'), actor(c))
    return r.ok ? c.json({ ok: true, request: r.request }) : c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
  })

  // Signed documents (read-only). Opening one is an access to the client's record: audited.
  app.get('/signed', zValidator('query', z.object({ contactId: z.string().min(1).max(64) })), async (c) =>
    c.json({ documents: await requests(c).listSigned(c.req.valid('query').contactId) }),
  )
  app.get('/signed/:id', async (c) => {
    const doc = await requests(c).getSigned(c.req.param('id'))
    if (!doc) return c.json({ error: 'not found' }, 404)
    await audit(deps.db, c.get('locationId'), {
      action: 'document.viewed_by_operator', entityType: 'signed_document', entityId: doc.id, contactId: doc.contactId,
      details: { templateId: doc.templateId }, actor: { type: 'operator', id: c.get('operatorId') }, ip: actor(c).ip, userAgent: actor(c).userAgent,
    })
    return c.json({ document: doc })
  })

  return app
}

import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { clientIp } from '../lib/client-ip'
import { sendInviteEmail } from '../lib/document-mail'
import { REQUEST_TTL_DAYS, hashToken, newToken } from '../lib/document-tokens'
import { type ResolvedEmailSender, resolveEmailSender } from '../lib/sending/resolve'
import { ClientInvitesRepo } from '../repos/client-invites-repo'
import { displayName } from '../repos/branding-repo'

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  // adult: the person fills in their own details; guardian: a parent or guardian fills in a minor's.
  kind: z.enum(['adult', 'guardian']),
})

/**
 * Client invitations, at /api/loc/:loc/invites behind operatorAuth + locationAccess + the
 * `contacts` module. The therapist enters a name and an email; the person fills in the rest on
 * their own page, and only then does a contact exist (see public-invites.ts).
 */
export function invitesRoute(deps: {
  db: Database
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  publicBaseUrl?: string
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const repo = (c: Context<AppEnv>) => new ClientInvitesRepo(deps.db, c.get('locationId'))
  const actor = (c: Context<AppEnv>) => {
    const ip = clientIp(c)
    return { operatorId: c.get('operatorId'), ip: ip === 'unknown' ? null : ip, userAgent: c.req.header('user-agent') ?? null }
  }
  const baseUrl = (c: Context<AppEnv>) => (deps.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/$/, '')

  async function mail(c: Context<AppEnv>, o: { to: string; name: string; token: string }) {
    const name = (await displayName(deps.db, c.get('locationId'))) || 'Su terapeuta'
    const sender = await (deps.resolveEmail ?? resolveEmailSender)(deps.db, c.get('locationId'))
    const link = `${baseUrl(c)}/i/${o.token}`
    const r = await sendInviteEmail(sender.ok ? sender.sender : null, sender.ok ? undefined : sender.reason, { practice: name, to: o.to, name: o.name, link, days: REQUEST_TTL_DAYS })
    return { link, emailed: r.sent, emailIssue: r.reason ?? null }
  }

  app.get('/', async (c) => c.json({ invites: await repo(c).list() }))

  app.post('/', zValidator('json', createSchema), async (c) => {
    const input = c.req.valid('json')
    const token = newToken()
    const r = await repo(c).create({ ...input, tokenHash: hashToken(token) }, actor(c))
    if (!r.ok) return c.json({ error: r.error, inviteId: 'inviteId' in r ? r.inviteId : undefined }, 409)
    return c.json({ ok: true, invite: r.invite, ...(await mail(c, { to: r.invite.email, name: r.invite.name, token })) }, 201)
  })

  app.post('/:id/resend', async (c) => {
    const token = newToken()
    const r = await repo(c).rotate(c.req.param('id'), hashToken(token), actor(c))
    if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
    return c.json({ ok: true, invite: r.invite, ...(await mail(c, { to: r.invite.email, name: r.invite.name, token })) })
  })

  app.post('/:id/void', async (c) => {
    const r = await repo(c).void(c.req.param('id'), actor(c))
    return r.ok ? c.json({ ok: true, invite: r.invite }) : c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
  })

  return app
}

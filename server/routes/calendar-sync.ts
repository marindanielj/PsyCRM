import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { auditContext } from '../lib/audit'
import { readCalendar, syncOne } from '../lib/calendar-sync'
import { clientIp } from '../lib/client-ip'
import { looksLikeToken } from '../lib/document-tokens'
import { buildFeed } from '../lib/ics'
import { type FetchResult, checkCalendarUrl } from '../lib/ssrf'
import {
  CalendarSyncRepo,
  FEED_TITLES,
  MAX_EXTERNAL_CALENDARS,
  findFeedByToken,
  recordFeedFetch,
  recordSync,
} from '../repos/calendar-sync-repo'

const DAY_MS = 24 * 3600_000
/** The feed shows the recent past (so a phone keeps its history) and a long way ahead. */
const FEED_PAST_DAYS = 30
const FEED_AHEAD_DAYS = 365
/** A manual "sync now" is refused when the calendar was just read. */
const MANUAL_SYNC_MIN_MS = 60_000

export interface CalendarSyncDeps {
  db: Database
  /** SESSION_SECRET — the key external addresses are sealed under. */
  secret: string
  /** Public origin for the feed address (PUBLIC_BASE_URL). Falls back to the request's origin. */
  publicBaseUrl?: string
  /** Injectable for tests. */
  fetchText?: (url: string) => Promise<FetchResult>
}

const addSchema = z.object({
  label: z.string().trim().min(1).max(60).default('My calendar'),
  url: z.string().trim().min(8).max(2048),
})

const patchSchema = z
  .object({ enabled: z.boolean().optional(), label: z.string().trim().min(1).max(60).optional() })
  .refine((v) => v.enabled !== undefined || v.label !== undefined, { message: 'nothing to change' })

const rangeSchema = z.object({ from: z.string().datetime(), to: z.string().datetime() })

function origin(deps: CalendarSyncDeps, c: Context): string {
  return (deps.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/+$/, '')
}

/**
 * Settings → Calendar sync, at /api/loc/:loc/calendar-sync behind operatorAuth + locationAccess.
 *
 * Two independent pieces, each moving only time blocks:
 *   - the practice's own feed (`/feed`): a secret address the therapist subscribes to from her phone;
 *   - her personal calendars (`/calendars`): addresses PsyCRM reads to learn when she is busy.
 * Neither response ever contains a client name, and the personal calendar addresses are never returned.
 */
export function calendarSyncRoute(deps: CalendarSyncDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const repo = (c: Context<AppEnv>) => new CalendarSyncRepo(deps.db, c.get('locationId'))
  const feedUrl = (c: Context, token: string) => `${origin(deps, c)}/cal/${token}.ics`

  app.get('/', async (c) => {
    const r = repo(c)
    const [feed, calendars] = await Promise.all([r.getFeed(), r.listExternal()])
    return c.json({ feed: feed ?? null, calendars, limits: { maxCalendars: MAX_EXTERNAL_CALENDARS }, titles: FEED_TITLES })
  })

  // --- the practice's own feed ---------------------------------------------------------------------------------------

  // Make the address, or replace it. The address is in THIS response only: it is not stored and cannot be shown again.
  app.post('/feed', async (c) => {
    const r = repo(c)
    const existing = await r.getFeed()
    const wantsRotate = c.req.query('replace') === '1'
    if (existing && !wantsRotate) return c.json({ error: 'feed_exists' }, 409)
    const { token, rotated } = await r.createOrRotateFeed(auditContext(c))
    return c.json({ ok: true, rotated, url: feedUrl(c, token), feed: await r.getFeed() }, rotated ? 200 : 201)
  })

  app.put('/feed', zValidator('json', z.object({ title: z.enum(FEED_TITLES) })), async (c) => {
    const r = repo(c)
    if (!(await r.getFeed())) return c.json({ error: 'no_feed' }, 404)
    await r.setFeedTitle(c.req.valid('json').title, auditContext(c))
    return c.json({ ok: true, feed: await r.getFeed() })
  })

  app.delete('/feed', async (c) => {
    const removed = await repo(c).revokeFeed(auditContext(c))
    return removed ? c.json({ ok: true }) : c.json({ error: 'no_feed' }, 404)
  })

  // --- her personal calendars ----------------------------------------------------------------------------------------

  app.post('/calendars', zValidator('json', addSchema), async (c) => {
    const r = repo(c)
    const body = c.req.valid('json')
    const chk = checkCalendarUrl(body.url)
    if (!chk.ok) return c.json({ error: chk.error === 'bad_url' ? 'invalid_url' : chk.error }, 422)
    // Subscribing PsyCRM to its own feed would echo appointments back as "busy" and block them.
    const base = deps.publicBaseUrl ? new URL(deps.publicBaseUrl).host : new URL(c.req.url).host
    if (chk.url.host === base && chk.url.pathname.startsWith('/cal/')) return c.json({ error: 'own_feed' }, 422)
    if ((await r.countExternal()) >= MAX_EXTERNAL_CALENDARS) return c.json({ error: 'too_many_calendars' }, 409)

    // Read it BEFORE keeping it: a typo, a wrong link or a page that is not a calendar is reported right here and nothing is
    // stored, so a failed attempt never leaves a broken entry behind. (The address is only ever opened server-side.)
    const read = await readCalendar({ db: deps.db, fetchText: deps.fetchText }, chk.url.toString(), c.get('locationId'))
    if (!read.ok) return c.json({ error: read.error }, 422)

    const calendar = await r.addExternal({ label: body.label, url: chk.url.toString(), host: chk.url.host }, deps.secret, auditContext(c))
    await recordSync(deps.db, { id: calendar.id, location_id: c.get('locationId'), last_status: null }, { ok: true, blocks: read.blocks })
    const fresh = (await r.listExternal()).find((x) => x.id === calendar.id) ?? calendar
    return c.json({ ok: true, calendar: fresh, sync: { ok: true, blocks: read.blocks.length, unsupportedRules: read.unsupportedRules, truncated: read.truncated } }, 201)
  })

  app.post('/calendars/:id/sync', async (c) => {
    const r = repo(c)
    const cal = (await r.listExternal()).find((x) => x.id === c.req.param('id'))
    if (!cal) return c.json({ error: 'not found' }, 404)
    if (!cal.enabled) return c.json({ error: 'paused' }, 409)
    if (cal.last_attempt_at && Date.now() - new Date(cal.last_attempt_at).getTime() < MANUAL_SYNC_MIN_MS) return c.json({ error: 'too_soon' }, 429)
    const sync = await syncOne({ db: deps.db, secret: deps.secret, fetchText: deps.fetchText }, (await r.syncRow(cal.id))!)
    const fresh = (await r.listExternal()).find((x) => x.id === cal.id)
    return c.json({ ok: sync.ok, calendar: fresh, ...(sync.ok ? { blocks: sync.blocks, unsupportedRules: sync.unsupportedRules, truncated: sync.truncated } : { error: sync.error }) })
  })

  app.patch('/calendars/:id', zValidator('json', patchSchema), async (c) => {
    const r = repo(c)
    const body = c.req.valid('json')
    const id = c.req.param('id')
    if (body.label !== undefined && !(await r.renameExternal(id, body.label))) return c.json({ error: 'not found' }, 404)
    if (body.enabled !== undefined) {
      const updated = await r.setExternalEnabled(id, body.enabled, auditContext(c))
      if (!updated) return c.json({ error: 'not found' }, 404)
    }
    const fresh = (await r.listExternal()).find((x) => x.id === id)
    return fresh ? c.json({ ok: true, calendar: fresh }) : c.json({ error: 'not found' }, 404)
  })

  app.delete('/calendars/:id', async (c) => {
    const removed = await repo(c).removeExternal(c.req.param('id'), auditContext(c))
    return removed ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })

  // The grey "Busy" blocks for the agenda. Start and end only.
  app.get('/busy', zValidator('query', rangeSchema), async (c) => {
    const { from, to } = c.req.valid('query')
    const f = new Date(from)
    const t = new Date(to)
    if (!(t > f) || t.getTime() - f.getTime() > 62 * DAY_MS) return c.json({ error: 'bad_range' }, 400)
    const blocks = await repo(c).busyBetween(f, t)
    return c.json({ blocks: blocks.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })) })
  })

  return app
}

/**
 * The public feed, at /cal/<token>.ics. No session: a calendar app subscribes with the address alone, so the unguessable token
 * IS the credential (256 bits; only its hash is stored). Anything wrong with it — malformed, unknown, revoked, replaced — gets
 * the same plain 404, so the response never reveals whether a token ever existed.
 */
export function calendarFeedRoute(deps: { db: Database }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const noStore = {
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
  const notFound = () => new Response('Not found', { status: 404, headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8' } })

  app.get('/:file', async (c) => {
    const file = c.req.param('file')
    const token = file.endsWith('.ics') ? file.slice(0, -4) : ''
    if (!looksLikeToken(token)) return notFound()
    const feed = await findFeedByToken(deps.db, token)
    if (!feed) return notFound()

    const now = Date.now()
    const rows = await new CalendarSyncRepo(deps.db, feed.location_id).feedAppointments(new Date(now - FEED_PAST_DAYS * DAY_MS), new Date(now + FEED_AHEAD_DAYS * DAY_MS))
    const body = buildFeed(
      rows.map((r) => ({ id: r.id, start: new Date(r.starts_at), end: new Date(r.ends_at), stamp: new Date(r.updated_at) })),
      { title: feed.title },
    )

    const ip = clientIp(c)
    await recordFeedFetch(deps.db, feed.location_id, feed.last_fetched_at, {
      actor: { type: 'system', label: 'Subscribed calendar' },
      ip: ip === 'unknown' ? null : ip,
      userAgent: c.req.header('user-agent') ?? null,
    })
    return new Response(body, { headers: { ...noStore, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="appointments.ics"' } })
  })

  return app
}

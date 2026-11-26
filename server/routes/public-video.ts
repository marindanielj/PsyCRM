import { randomBytes } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { logoUrl, normalizeBranding, readableBrand } from '../lib/branding'
import { clientIp } from '../lib/client-ip'
import { looksLikeToken } from '../lib/document-tokens'
import { SlidingWindowRateLimiter } from '../lib/rate-limit'
import { videoErrorHandler, viaProvider } from '../lib/video/errors'
import { renderVideoClosedPage, renderVideoInvalidPage, renderVideoPage, type VideoPageState } from '../lib/video-page'
import { videoTokenHash } from '../lib/video-token'
import { videoWindow } from '../lib/video-window'
import type { VideoProvider } from '../lib/video/provider'
import { LocationsRepo } from '../repos/locations-repo'
import { PracticeRepo } from '../repos/practice-repo'
import { findVideoByTokenHash, VideoMeetingsRepo, type VideoLinkContext } from '../repos/video-meetings-repo'

const waitSchema = z.object({
  location: z.string().trim().min(2).max(200),
  inPuertoRico: z.boolean(),
  privatePlace: z.boolean(),
})

/**
 * The client's video session, mounted at `/v` OUTSIDE the operator session. The link token is the
 * credential (derived from the room id; only its hash is stored). An unknown link, a cancelled
 * appointment and a room that was never made all look the same.
 *
 *   GET  /v/:token         -> the page: confirm -> wait -> enter
 *   POST /v/:token/wait    -> she is here (and where); the therapist is told
 *   GET  /v/:token/status  -> polled while waiting: admitted? ended?
 *   POST /v/:token/join    -> credentials to enter the call (only once admitted)
 *   POST /v/:token/left    -> she closed the page (a time in the log, nothing more)
 */
export function publicVideoRoute(deps: { db: Database; provider: VideoProvider; now?: () => Date }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.onError(videoErrorHandler)
  const clock = () => deps.now?.() ?? new Date()
  const perIp = new SlidingWindowRateLimiter(120, 10 * 60_000)
  // A waiting client polls every 3 s (200 per 10 min), so status has its own, higher, allowance.
  const statusPerIp = new SlidingWindowRateLimiter(400, 10 * 60_000)
  const perLinkWrites = new SlidingWindowRateLimiter(20, 10 * 60_000)

  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
    c.header('X-Robots-Tag', 'noindex, nofollow')
    // Camera and microphone for this page only.
    c.header('Permissions-Policy', 'camera=(self), microphone=(self)')
  })

  function pageHeaders(c: Context<AppEnv>): string {
    const nonce = randomBytes(16).toString('base64')
    // Chime needs its own signalling and media hosts; the SDK starts audio worklets from blob: URLs.
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self' 'nonce-${nonce}' blob:; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https://*.chime.aws wss://*.chime.aws https://*.amazonaws.com wss://*.amazonaws.com; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    )
    return nonce
  }

  /** The room behind a link, or null for "invalid link". A cancelled appointment or non-video one counts as closed, not missing. */
  async function resolve(token: string): Promise<VideoLinkContext | null> {
    if (!looksLikeToken(token)) return null
    const ctx = await findVideoByTokenHash(deps.db, videoTokenHash(token))
    if (!ctx || ctx.appointment.modality !== 'telehealth_video') return null
    return ctx
  }

  const allow = (l: SlidingWindowRateLimiter, key: string) => l.check(key, clock().getTime()).allowed
  const limited = (c: Context<AppEnv>) => !allow(perIp, clientIp(c))

  app.get('/:token', async (c) => {
    const nonce = pageHeaders(c)
    if (limited(c)) return c.html(renderVideoInvalidPage(nonce), 429)
    const ctx = await resolve(c.req.param('token'))
    if (!ctx) return c.html(renderVideoInvalidPage(nonce), 404)

    const [location, practice] = await Promise.all([new LocationsRepo(deps.db).getById(ctx.locationId), new PracticeRepo(deps.db, ctx.locationId).get()])
    const look = normalizeBranding(location?.branding)
    const base = { practice: look.name ?? practice.name ?? '', brand: look.color ? readableBrand(look.color) : undefined, logoUrl: logoUrl(ctx.locationId, look) ?? undefined, nonce }

    base.practice ||= 'Su terapeuta'
    const { appointment: a, meeting: m } = ctx
    if (a.status === 'cancelled' || a.status === 'no_show') return c.html(renderVideoClosedPage(base, 'cancelled'))
    const w = videoWindow(a.starts_at, a.ends_at, clock())
    if (m.ended_at || w.state === 'ended') return c.html(renderVideoClosedPage(base, 'ended'))
    if (w.state === 'not_yet') {
      const label = w.opensAt.toLocaleTimeString('es-PR', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Puerto_Rico' })
      return c.html(renderVideoClosedPage(base, 'not_yet', label))
    }
    const state: VideoPageState = m.admitted_at ? 'admitted' : m.waiting_since ? 'waiting' : 'lobby'
    return c.html(renderVideoPage({ ...base, token: c.req.param('token'), state }))
  })

  app.get('/:token/status', async (c) => {
    if (!allow(statusPerIp, clientIp(c))) return c.json({ error: 'slow_down' }, 429)
    const ctx = await resolve(c.req.param('token'))
    if (!ctx) return c.json({ error: 'invalid_link' }, 404)
    const w = videoWindow(ctx.appointment.starts_at, ctx.appointment.ends_at, clock())
    return c.json({
      state: ctx.appointment.status === 'cancelled' ? 'ended' : w.state,
      admitted: Boolean(ctx.meeting.admitted_at),
      ended: Boolean(ctx.meeting.ended_at),
    })
  })

  app.post('/:token/wait', zValidator('json', waitSchema), async (c) => {
    if (limited(c)) return c.json({ error: 'slow_down' }, 429)
    const ctx = await resolve(c.req.param('token'))
    if (!ctx) return c.json({ error: 'invalid_link' }, 404)
    if (!allow(perLinkWrites, ctx.meeting.id)) return c.json({ error: 'slow_down' }, 429)
    const w = videoWindow(ctx.appointment.starts_at, ctx.appointment.ends_at, clock())
    if (w.state !== 'open' || ctx.meeting.ended_at || ctx.appointment.status === 'cancelled') return c.json({ error: 'closed' }, 409)
    const repo = new VideoMeetingsRepo(deps.db, ctx.locationId)
    await repo.markWaiting(ctx.meeting.id, c.req.valid('json'))
    if (!ctx.meeting.waiting_since) await repo.addEvent(ctx.meeting.id, 'client', 'waiting')
    return c.json({ ok: true, admitted: Boolean(ctx.meeting.admitted_at) })
  })

  app.post('/:token/join', async (c) => {
    if (limited(c)) return c.json({ error: 'slow_down' }, 429)
    const ctx = await resolve(c.req.param('token'))
    if (!ctx) return c.json({ error: 'invalid_link' }, 404)
    if (!allow(perLinkWrites, ctx.meeting.id)) return c.json({ error: 'slow_down' }, 429)
    const w = videoWindow(ctx.appointment.starts_at, ctx.appointment.ends_at, clock())
    if (w.state !== 'open' || ctx.meeting.ended_at || ctx.appointment.status === 'cancelled') return c.json({ error: 'closed' }, 409)
    // Never before the therapist let her in, and never into a room the therapist has not opened.
    const chime = ctx.meeting.chime_meeting as { MeetingId?: string } | null
    if (!ctx.meeting.admitted_at || !chime?.MeetingId) return c.json({ error: 'not_admitted' }, 409)
    const attendee = await viaProvider('createAttendee', () => deps.provider.createAttendee(chime.MeetingId!, 'client'))
    await new VideoMeetingsRepo(deps.db, ctx.locationId).addEvent(ctx.meeting.id, 'client', 'joined')
    return c.json({ ok: true, meeting: chime, attendee })
  })

  app.post('/:token/left', async (c) => {
    const ctx = await resolve(c.req.param('token'))
    if (!ctx) return c.json({ error: 'invalid_link' }, 404)
    if (allow(perLinkWrites, ctx.meeting.id)) await new VideoMeetingsRepo(deps.db, ctx.locationId).addEvent(ctx.meeting.id, 'client', 'left')
    return c.json({ ok: true })
  })

  return app
}

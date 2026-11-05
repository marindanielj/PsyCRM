import { getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../app-env'
import {
  IDLE_REFRESH_AFTER_MS,
  SESSION_TTL_SECONDS,
  readSessionClaims,
  reissueSession,
} from '../lib/session'

export const SESSION_COOKIE = 'ol_session'

export interface OperatorAuthOptions {
  /** Sign out after this much inactivity. Unset = no idle limit (only the
   *  absolute session lifetime applies) — the original OpenLevel behavior. */
  idleTtlMs?: number
  /** Set Secure on the re-issued cookie (true in production over HTTPS). */
  secure?: boolean
  now?: () => number
}

/**
 * Reads the signed session from the `ol_session` cookie (web) or an
 * `Authorization: Bearer` header (mobile) and sets `operatorId`. 401 otherwise.
 * With `idleTtlMs`, a session idle for longer is rejected, and a cookie session
 * that is still valid but more than a minute stale is re-issued with a fresh
 * activity stamp (sliding window). Bearer sessions are never re-issued here —
 * the mobile client has no cookie jar — so idle limits are a web-only control.
 */
export function operatorAuth(secret: string, opts: OperatorAuthOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authHeader = c.req.header('Authorization')
    const cookieToken = getCookie(c, SESSION_COOKIE)
    let token = cookieToken
    let fromBearer = false
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice('Bearer '.length)
      fromBearer = true
    }

    const now = opts.now?.() ?? Date.now()
    const claims = readSessionClaims(token, secret, {
      now,
      // Bearer tokens cannot slide, so the idle check would sign mobile users out
      // 30 minutes after login no matter what they do. Web cookies only.
      idleTtlMs: fromBearer ? undefined : opts.idleTtlMs,
    })
    if (!claims) return c.json({ error: 'unauthorized' }, 401)
    c.set('operatorId', claims.operatorId)

    if (opts.idleTtlMs !== undefined && !fromBearer && now - claims.last > IDLE_REFRESH_AFTER_MS) {
      setCookie(c, SESSION_COOKIE, reissueSession(claims, secret, now), {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure: opts.secure ?? false,
        // Remaining absolute lifetime, so the cookie never outlives the token.
        maxAge: Math.max(1, Math.min(SESSION_TTL_SECONDS, Math.floor((claims.exp - now) / 1000))),
      })
    }
    await next()
  })
}

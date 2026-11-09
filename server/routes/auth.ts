import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { audit } from '../lib/audit'
import { clientIp } from '../lib/client-ip'
import { hashPassword, verifyPassword } from '../lib/password'
import { SlidingWindowRateLimiter } from '../lib/rate-limit'
import { SESSION_TTL_SECONDS, createSession, readSession } from '../lib/session'
import { SESSION_COOKIE, operatorAuth } from '../middleware/auth'
import { type Operator, OperatorsRepo } from '../repos/operators-repo'

/** Login throttle: at most 10 attempts per IP per minute. Argon2id already
 *  makes each guess expensive; this caps an online brute-force spray. */
const LOGIN_MAX_ATTEMPTS = 10
const LOGIN_WINDOW_MS = 60_000

/** Changing a password asks for the current one, so it is a way to guess it from a stolen session:
 *  at most 5 wrong guesses per operator per 15 minutes. */
const CHANGE_MAX_ATTEMPTS = 5
const CHANGE_WINDOW_MS = 15 * 60_000

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

export interface AuthDeps {
  db: Database
  sessionSecret: string
  /** Set Secure on the session cookie (true in production over HTTPS). */
  secure?: boolean
  /** Injectable clock for deterministic rate-limit tests. */
  now?: () => number
  /** Idle sign-out window for web sessions (PsyCRM mode). Unset = none. */
  idleTtlMs?: number
  /** Override the login throttle (tests pin small limits). */
  loginRateLimit?: { max: number; windowMs: number }
  /** Override the change-password throttle (tests pin small limits). */
  changeRateLimit?: { max: number; windowMs: number }
  /** See OperatorAuthOptions.revokedBefore: lets a password change sign out the other sessions. */
  revokedBefore?: (operatorId: string) => Promise<number | null>
}

const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) })
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
})

function publicOperator(o: Operator) {
  return { id: o.id, email: o.email, name: o.name, role: o.role }
}

export function authRoute(deps: AuthDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const operators = new OperatorsRepo(deps.db)
  const clock = () => deps.now?.() ?? Date.now()
  const loginLimiter = new SlidingWindowRateLimiter(
    deps.loginRateLimit?.max ?? LOGIN_MAX_ATTEMPTS,
    deps.loginRateLimit?.windowMs ?? LOGIN_WINDOW_MS,
  )
  const changeLimiter = new SlidingWindowRateLimiter(
    deps.changeRateLimit?.max ?? CHANGE_MAX_ATTEMPTS,
    deps.changeRateLimit?.windowMs ?? CHANGE_WINDOW_MS,
  )
  const cookieAuth = operatorAuth(deps.sessionSecret, {
    idleTtlMs: deps.idleTtlMs,
    secure: deps.secure,
    now: deps.now,
    revokedBefore: deps.revokedBefore,
  })

  /** Write one audit row per practice the operator belongs to (usually one). */
  async function auditAuth(
    c: Context,
    operatorId: string,
    action: 'auth.login' | 'auth.login_failed' | 'auth.logout' | 'auth.password_changed' | 'auth.password_change_failed',
    details: Record<string, unknown>,
    actorType: 'operator' | 'system',
  ) {
    const ip = clientIp(c)
    const locations = await operators.listLocations(operatorId)
    for (const loc of locations) {
      await audit(deps.db, loc.id, {
        action,
        entityType: 'auth',
        entityId: operatorId,
        details,
        actor: { type: actorType, id: operatorId },
        ip: ip === 'unknown' ? null : ip,
        userAgent: c.req.header('user-agent') ?? null,
      })
    }
  }

  app.post('/login', zValidator('json', loginSchema), async (c) => {
    const verdict = loginLimiter.check(clientIp(c), clock())
    if (!verdict.allowed) {
      c.header('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)))
      return c.json({ error: 'too many attempts' }, 429)
    }
    const { email, password } = c.req.valid('json')
    const operator = await operators.findByEmail(email)
    // Always run verify against a found hash; a generic 401 avoids leaking which
    // half failed (user-enumeration). verifyPassword returns false, never throws.
    if (!operator || !(await verifyPassword(operator.password_hash, password))) {
      // A failed attempt on a REAL account is recorded in each of that account's
      // practices. An unknown email has no practice to attach to; the throttle
      // above is the only record of it.
      if (operator) await auditAuth(c, operator.id, 'auth.login_failed', { reason: 'bad_password' }, 'system')
      return c.json({ error: 'invalid credentials' }, 401)
    }
    await auditAuth(c, operator.id, 'auth.login', {}, 'operator')
    const token = createSession({ operatorId: operator.id }, deps.sessionSecret)
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: deps.secure ?? false,
      maxAge: SESSION_TTL_SECONDS,
    })
    return c.json({ ok: true, operator: publicOperator(operator), passwordChangedAt: await operators.passwordChangedAt(operator.id), token })
  })

  app.post('/logout', async (c) => {
    // The route is public so a dead session can still clear its cookie; if the
    // cookie is still valid, record who signed out.
    const session = readSession(getCookie(c, SESSION_COOKIE), deps.sessionSecret)
    if (session) await auditAuth(c, session.operatorId, 'auth.logout', {}, 'operator')
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/me', cookieAuth, async (c) => {
    const operator = await operators.getById(c.get('operatorId'))
    if (!operator) return c.json({ error: 'not found' }, 404)
    // null = the password has never been changed (it is still the one the account was created with).
    return c.json({ operator: publicOperator(operator), passwordChangedAt: await operators.passwordChangedAt(operator.id) })
  })

  /**
   * Choose a new password. Needs the current one (a stolen session alone cannot take the account over),
   * is throttled, signs out every other session, and keeps this one open with a fresh cookie. The audit
   * rows say it happened, never what the passwords were.
   */
  app.post('/change-password', cookieAuth, zValidator('json', changePasswordSchema, (result, c) => {
    if (!result.success) return c.json({ error: 'invalid password', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }, 400)
  }), async (c) => {
    const operatorId = c.get('operatorId')
    const verdict = changeLimiter.check(operatorId, clock())
    if (!verdict.allowed) {
      c.header('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)))
      return c.json({ error: 'too many attempts' }, 429)
    }
    const { currentPassword, newPassword } = c.req.valid('json')
    const operator = await operators.getById(operatorId)
    if (!operator) return c.json({ error: 'not found' }, 404)
    // 403, not 401: the web app treats 401 as "signed out".
    if (!(await verifyPassword(operator.password_hash, currentPassword))) {
      await auditAuth(c, operatorId, 'auth.password_change_failed', { reason: 'bad_current_password' }, 'operator')
      return c.json({ error: 'incorrect password' }, 403)
    }
    if (newPassword === currentPassword) return c.json({ error: 'same password' }, 400)
    if (newPassword.toLowerCase() === operator.email.toLowerCase()) return c.json({ error: 'weak password' }, 400)

    const at = clock()
    await operators.changePassword(operatorId, await hashPassword(newPassword), at)
    await auditAuth(c, operatorId, 'auth.password_changed', {}, 'operator')
    // Every session issued before `at` is void now; this device gets a new one.
    const token = createSession({ operatorId }, deps.sessionSecret, { now: at })
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: deps.secure ?? false,
      maxAge: SESSION_TTL_SECONDS,
    })
    return c.json({ ok: true, token })
  })

  return app
}

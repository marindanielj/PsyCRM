import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { audit } from '../lib/audit'
import { clientIp } from '../lib/client-ip'
import { verifyPassword } from '../lib/password'
import { SlidingWindowRateLimiter } from '../lib/rate-limit'
import { SESSION_TTL_SECONDS, createSession, readSession } from '../lib/session'
import { SESSION_COOKIE, operatorAuth } from '../middleware/auth'
import { type Operator, OperatorsRepo } from '../repos/operators-repo'

/** Login throttle: at most 10 attempts per IP per minute. Argon2id already
 *  makes each guess expensive; this caps an online brute-force spray. */
const LOGIN_MAX_ATTEMPTS = 10
const LOGIN_WINDOW_MS = 60_000

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
}

const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) })

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

  /** Write one audit row per practice the operator belongs to (usually one). */
  async function auditAuth(
    c: Context,
    operatorId: string,
    action: 'auth.login' | 'auth.login_failed' | 'auth.logout',
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
    return c.json({ ok: true, operator: publicOperator(operator), token })
  })

  app.post('/logout', async (c) => {
    // The route is public so a dead session can still clear its cookie; if the
    // cookie is still valid, record who signed out.
    const session = readSession(getCookie(c, SESSION_COOKIE), deps.sessionSecret)
    if (session) await auditAuth(c, session.operatorId, 'auth.logout', {}, 'operator')
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/me', operatorAuth(deps.sessionSecret, { idleTtlMs: deps.idleTtlMs, secure: deps.secure, now: deps.now }), async (c) => {
    const operator = await operators.getById(c.get('operatorId'))
    if (!operator) return c.json({ error: 'not found' }, 404)
    return c.json({ operator: publicOperator(operator) })
  })

  return app
}

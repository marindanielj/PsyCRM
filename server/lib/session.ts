/**
 * Stateless signed session token: `base64url(payload).base64url(hmac)`.
 * HMAC-SHA256 over the payload with SESSION_SECRET; read() verifies the
 * signature in constant time and rejects anything tampered, mis-signed,
 * malformed, or expired. No server-side session store — the cookie is the
 * session. Every token carries an `exp` claim so a stolen or leaked token
 * stops working after its lifetime, even though there is no revocation store.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionData {
  operatorId: string
}

/** The full verified token, for callers that need the timing claims (the auth
 *  middleware slides the idle window with `last`). */
export interface SessionClaims extends SessionData {
  iat: number
  exp: number
  /** Last activity (epoch ms). Falls back to `iat` for tokens minted before idle
   *  tracking existed. */
  last: number
}

/** PsyCRM idle timeout: a signed-in tab untouched this long is signed out. */
export const IDLE_TTL_MS = 30 * 60_000
/** The middleware re-issues the cookie at most this often (not on every request). */
export const IDLE_REFRESH_AFTER_MS = 60_000

/** Default session lifetime. Exported so the cookie maxAge matches the token. */
export const SESSION_TTL_MS = 8 * 60 * 60_000
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000

/** The signed payload: the public data plus issued-at / expiry (epoch ms). */
interface SessionToken extends SessionData {
  iat: number
  exp: number
  /** Last activity (epoch ms), slid forward by reissueSession. Optional so older
   *  tokens still parse. */
  last?: number
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function createSession(
  data: SessionData,
  secret: string,
  opts: { ttlMs?: number; now?: number } = {},
): string {
  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? SESSION_TTL_MS
  const token: SessionToken = { operatorId: data.operatorId, iat: now, exp: now + ttl, last: now }
  const payload = Buffer.from(JSON.stringify(token), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

/**
 * Verify a token and return its claims. `idleTtlMs`, when given, also rejects a
 * token whose last activity is older than that (the sliding idle timeout). The
 * absolute expiry (`exp`) always applies. Returns null for anything tampered,
 * mis-signed, malformed or expired.
 */
export function readSessionClaims(
  token: string | null | undefined,
  secret: string,
  opts: { now?: number; idleTtlMs?: number } = {},
): SessionClaims | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const provided = token.slice(dot + 1)
  const expected = sign(payload, secret)

  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { operatorId?: unknown }).operatorId === 'string' &&
      typeof (data as { exp?: unknown }).exp === 'number'
    ) {
      const t = data as SessionToken
      const now = opts.now ?? Date.now()
      if (now > t.exp) return null
      const iat = typeof t.iat === 'number' ? t.iat : now
      const last = typeof t.last === 'number' ? t.last : iat
      if (opts.idleTtlMs !== undefined && now - last > opts.idleTtlMs) return null
      return { operatorId: t.operatorId, iat, exp: t.exp, last }
    }
    return null
  } catch {
    return null
  }
}

export function readSession(
  token: string | null | undefined,
  secret: string,
  opts: { now?: number; idleTtlMs?: number } = {},
): SessionData | null {
  const claims = readSessionClaims(token, secret, opts)
  return claims ? { operatorId: claims.operatorId } : null
}

/** Re-sign the same session with `last` moved to `now`. `iat`/`exp` are kept, so
 *  activity can slide the idle window but never extends the absolute lifetime. */
export function reissueSession(claims: SessionClaims, secret: string, now: number = Date.now()): string {
  const token: SessionToken = { operatorId: claims.operatorId, iat: claims.iat, exp: claims.exp, last: now }
  const payload = Buffer.from(JSON.stringify(token), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/** Token, one-time code and signer-session primitives for the public signing page. Pure: no I/O. */

/** A fresh link token. Only its sha256 is stored, so a database leak does not leak links. */
export const newToken = (): string => randomBytes(32).toString('base64url')
export const sha256Hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
export const hashToken = sha256Hex
/** Tokens are 43 base64url characters; anything else is rejected before touching the database. */
export const looksLikeToken = (s: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(s)

export const OTP_TTL_MS = 10 * 60_000
export const OTP_MAX_ATTEMPTS = 5
export const SIGNER_SESSION_TTL_MS = 60 * 60_000
export const COPY_WINDOW_MS = 30 * 24 * 3600_000
export const REQUEST_TTL_DAYS = 14

/** Six digits, uniformly random. */
export const newOtp = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0')

/** `salt:sha256(salt + code)`. A six-digit code has 10^6 values, so the salt and the attempt limit do the real work. */
export function hashOtp(code: string, salt: string = randomBytes(8).toString('hex')): string {
  return `${salt}:${sha256Hex(`${salt}:${code}`)}`
}

export function checkOtp(code: string, stored: string | null): boolean {
  if (!stored || !/^\d{6}$/.test(code)) return false
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const a = Buffer.from(sha256Hex(`${salt}:${code}`))
  const b = Buffer.from(hash)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** "ana.rivera@gmail.com" -> "a***@gmail.com". */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***${email.slice(at)}`
}

const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url')

/** The signer's session cookie value: HMAC over `{ s: signerId, exp }`. Stateless, like the operator session. */
export function createSignerSession(signerId: string, secret: string, opts: { now?: number; ttlMs?: number } = {}): string {
  const now = opts.now ?? Date.now()
  const payload = Buffer.from(JSON.stringify({ s: signerId, exp: now + (opts.ttlMs ?? SIGNER_SESSION_TTL_MS) }), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

/** The signer id inside a valid, unexpired session value, else null. */
export function readSignerSession(value: string | null | undefined, secret: string, now = Date.now()): string | null {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot < 1) return null
  const payload = value.slice(0, dot)
  const a = Buffer.from(value.slice(dot + 1))
  const b = Buffer.from(sign(payload, secret))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { s?: unknown; exp?: unknown }
    if (typeof claims.s !== 'string' || typeof claims.exp !== 'number' || claims.exp <= now) return null
    return claims.s
  } catch {
    return null
  }
}

/** Compare two typed names ignoring case, accents and extra spaces. */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
  return norm(a) === norm(b)
}

import { createHmac } from 'node:crypto'
import { createSession, readSession } from './session'

const secret = 'test-secret'

test('round-trips an operator session', () => {
  const token = createSession({ operatorId: 'op1' }, secret)
  expect(readSession(token, secret)).toEqual({ operatorId: 'op1' })
})

test('accepts a token within its ttl but rejects it once expired', () => {
  const t0 = 1_000_000
  const token = createSession({ operatorId: 'op1' }, secret, { ttlMs: 60_000, now: t0 })
  expect(readSession(token, secret, { now: t0 + 59_000 })).toEqual({ operatorId: 'op1' })
  expect(readSession(token, secret, { now: t0 + 60_001 })).toBeNull()
})

test('rejects a correctly-signed token that carries no expiry claim', () => {
  // A legacy / forged payload with no exp must not be honored as a perpetual session.
  const payload = Buffer.from(JSON.stringify({ operatorId: 'op1' }), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  expect(readSession(`${payload}.${sig}`, secret)).toBeNull()
})

test('rejects a tampered payload', () => {
  const token = createSession({ operatorId: 'op1' }, secret)
  const forged = Buffer.from(JSON.stringify({ operatorId: 'evil' }), 'utf8').toString('base64url')
  const tampered = token.replace(/^[^.]+/, forged)
  expect(readSession(tampered, secret)).toBeNull()
})

test('rejects a token signed with a different secret', () => {
  const token = createSession({ operatorId: 'op1' }, secret)
  expect(readSession(token, 'other-secret')).toBeNull()
})

test('rejects empty, missing, and garbage tokens', () => {
  expect(readSession(undefined, secret)).toBeNull()
  expect(readSession(null, secret)).toBeNull()
  expect(readSession('', secret)).toBeNull()
  expect(readSession('no-dot-here', secret)).toBeNull()
})

import { IDLE_TTL_MS, readSessionClaims, reissueSession } from './session'

test('rejects a session idle longer than idleTtlMs, but only when an idle limit is given', () => {
  const t0 = 1_000_000
  const token = createSession({ operatorId: 'op1' }, secret, { now: t0 })
  const later = t0 + IDLE_TTL_MS + 1
  expect(readSession(token, secret, { now: later, idleTtlMs: IDLE_TTL_MS })).toBeNull()
  expect(readSession(token, secret, { now: later - 2, idleTtlMs: IDLE_TTL_MS })).toEqual({ operatorId: 'op1' })
  // No idle limit configured (the non-PsyCRM default): only the absolute expiry applies.
  expect(readSession(token, secret, { now: later })).toEqual({ operatorId: 'op1' })
})

test('reissueSession slides the idle window but never extends the absolute expiry', () => {
  const t0 = 1_000_000
  const token = createSession({ operatorId: 'op1' }, secret, { now: t0, ttlMs: 2 * 60 * 60_000 })
  const claims = readSessionClaims(token, secret, { now: t0 })!
  const t1 = t0 + 20 * 60_000
  const renewed = reissueSession(claims, secret, t1)
  const c2 = readSessionClaims(renewed, secret, { now: t1, idleTtlMs: IDLE_TTL_MS })!
  expect(c2.last).toBe(t1)
  expect(c2.iat).toBe(claims.iat)
  expect(c2.exp).toBe(claims.exp)
  // 20 min after the renewal is fine again; the original (never renewed) would be idle by then.
  const t2 = t1 + 25 * 60_000
  expect(readSession(renewed, secret, { now: t2, idleTtlMs: IDLE_TTL_MS })).toEqual({ operatorId: 'op1' })
  expect(readSession(token, secret, { now: t2, idleTtlMs: IDLE_TTL_MS })).toBeNull()
  // Past the absolute expiry nothing helps.
  expect(readSession(renewed, secret, { now: claims.exp + 1, idleTtlMs: IDLE_TTL_MS })).toBeNull()
})

test('a token minted without a last claim falls back to iat for the idle check', () => {
  const t0 = 1_000_000
  const payload = Buffer.from(JSON.stringify({ operatorId: 'op1', iat: t0, exp: t0 + 8 * 3_600_000 }), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  const legacy = `${payload}.${sig}`
  expect(readSession(legacy, secret, { now: t0 + 1000, idleTtlMs: IDLE_TTL_MS })).toEqual({ operatorId: 'op1' })
  expect(readSession(legacy, secret, { now: t0 + IDLE_TTL_MS + 1, idleTtlMs: IDLE_TTL_MS })).toBeNull()
})

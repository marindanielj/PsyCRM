import { checkOtp, createSignerSession, hashOtp, hashToken, looksLikeToken, maskEmail, newOtp, newToken, readSignerSession, sameName } from './document-tokens'

test('tokens are long, URL-safe, unique, and only their hash is meant to be stored', () => {
  const a = newToken()
  expect(looksLikeToken(a)).toBe(true)
  expect(newToken()).not.toBe(a)
  expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/)
  expect(hashToken(a)).not.toContain(a)
  expect(looksLikeToken('short')).toBe(false)
  expect(looksLikeToken(`${a.slice(0, 42)}!`)).toBe(false)
})

test('a one-time code is six digits, salted, and checked in full', () => {
  for (let i = 0; i < 50; i++) expect(newOtp()).toMatch(/^\d{6}$/)
  const stored = hashOtp('012345')
  expect(stored).not.toContain('012345')
  expect(hashOtp('012345')).not.toBe(stored) // fresh salt each time
  expect(checkOtp('012345', stored)).toBe(true)
  expect(checkOtp('012346', stored)).toBe(false)
  expect(checkOtp('12345', stored)).toBe(false)
  expect(checkOtp('012345', null)).toBe(false)
  expect(checkOtp('012345', 'garbage')).toBe(false)
})

test('emails are masked to the first character and the domain', () => {
  expect(maskEmail('ana.rivera@gmail.com')).toBe('a***@gmail.com')
  expect(maskEmail('nonsense')).toBe('***')
})

test('the signer session is signed, bound to its signer and expires', () => {
  const now = 1_000_000
  const v = createSignerSession('sg1', 'secret', { now, ttlMs: 60_000 })
  expect(readSignerSession(v, 'secret', now + 59_000)).toBe('sg1')
  expect(readSignerSession(v, 'secret', now + 60_001)).toBeNull() // expired
  expect(readSignerSession(v, 'other-secret', now)).toBeNull() // wrong key
  const [payload, mac] = v.split('.')
  const forged = `${Buffer.from(JSON.stringify({ s: 'sg2', exp: now + 60_000 })).toString('base64url')}.${mac}`
  expect(readSignerSession(forged, 'secret', now)).toBeNull() // payload swapped
  expect(readSignerSession(`${payload}.`, 'secret', now)).toBeNull()
  expect(readSignerSession(undefined, 'secret')).toBeNull()
  expect(readSignerSession('nodot', 'secret')).toBeNull()
})

test('typed names match regardless of case, accents and spacing', () => {
  expect(sameName('María  Rivera', 'maria rivera')).toBe(true)
  expect(sameName('Ana Rivera', 'Ana Rivero')).toBe(false)
})

import { open, seal } from './secret-box'

const SECRET = 'a-session-secret-that-is-long-enough-123456'
const URL_TEXT = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123456789abcdef/basic.ics'

test('a sealed value opens with the same secret and label, and is not readable as stored', () => {
  const sealed = seal(URL_TEXT, SECRET, 'calendar-sync-url')
  expect(open(sealed, SECRET, 'calendar-sync-url')).toBe(URL_TEXT)
  expect(sealed).not.toContain('google')
  expect(sealed).not.toContain('private-')
})

test('sealing the same text twice gives different results (a fresh nonce each time)', () => {
  expect(seal(URL_TEXT, SECRET, 'x')).not.toBe(seal(URL_TEXT, SECRET, 'x'))
})

test('another secret, another label, a tampered value or garbage opens nothing', () => {
  const sealed = seal(URL_TEXT, SECRET, 'calendar-sync-url')
  expect(open(sealed, 'a-different-secret-entirely-0123456789', 'calendar-sync-url')).toBeNull()
  expect(open(sealed, SECRET, 'another-purpose')).toBeNull()
  const flipped = `${sealed.slice(0, -2)}${sealed.endsWith('A') ? 'B' : 'A'}${sealed.slice(-1)}`
  expect(open(flipped, SECRET, 'calendar-sync-url')).toBeNull()
  expect(open('', SECRET, 'x')).toBeNull()
  expect(open('v1.', SECRET, 'x')).toBeNull()
  expect(open('v2.abcd', SECRET, 'x')).toBeNull()
  expect(open('not a sealed value', SECRET, 'x')).toBeNull()
})

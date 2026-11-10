import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SYNC_MESSAGES, busyChipsForDay, syncMessage } from '../../src/lib/calendar-sync'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')

test('every error code the database can record has a message the person can read', () => {
  const list = /last_error\s+text CHECK \(last_error IN \(([^)]*)\)\)/.exec(SCHEMA)?.[1]
  expect(list).toBeTruthy()
  const codes = [...list!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
  expect(codes.length).toBeGreaterThan(5)
  for (const code of codes) expect(SYNC_MESSAGES[code], code).toBeTruthy()
})

test('every error the routes can answer with has a message too, and unknown codes get a safe fallback', () => {
  for (const code of ['invalid_url', 'not_https', 'blocked_address', 'own_feed', 'too_many_calendars', 'too_soon', 'paused']) expect(SYNC_MESSAGES[code], code).toBeTruthy()
  expect(syncMessage('something_new')).toBe('Something went wrong. Please try again.')
  expect(syncMessage(undefined)).toBe('Something went wrong. Please try again.')
})

test('no message ever echoes an address or tells the person to paste one anywhere but the form', () => {
  for (const text of Object.values(SYNC_MESSAGES)) expect(text).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\//i)
})

test('busy chips: the part of each block on that local day, with "All day" for a whole day', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()
  const day = new Date(2026, 10, 12)
  expect(busyChipsForDay([{ start: at(12, 11), end: at(12, 12) }], day)).toEqual(['11:00 AM – 12:00 PM'])
  // a block that crosses midnight shows on both days, clipped to each
  const overnight = [{ start: at(12, 22), end: at(13, 2) }]
  expect(busyChipsForDay(overnight, day)).toEqual(['10:00 PM – 12:00 AM'])
  expect(busyChipsForDay(overnight, new Date(2026, 10, 13))).toEqual(['12:00 AM – 2:00 AM'])
  expect(busyChipsForDay(overnight, new Date(2026, 10, 14))).toEqual([])
  // a whole day, and a block on another day, and several on one day
  expect(busyChipsForDay([{ start: at(12, 0), end: at(13, 0) }], day)).toEqual(['All day'])
  expect(busyChipsForDay([{ start: at(11, 9), end: at(11, 10) }], day)).toEqual([])
  expect(busyChipsForDay([{ start: at(12, 9), end: at(12, 10) }, { start: at(12, 14), end: at(12, 15, 30) }], day)).toEqual(['9:00 AM – 10:00 AM', '2:00 PM – 3:30 PM'])
})

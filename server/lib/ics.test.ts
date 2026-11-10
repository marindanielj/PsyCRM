import { buildFeed, foldLine, icsUtc, mergeBlocks, parseBusyBlocks, resolveZone, unfold } from './ics'

const PR = 'America/Puerto_Rico' // UTC-4 all year, no daylight saving
const NY = 'America/New_York'
const iso = (b: { start: Date; end: Date }) => [b.start.toISOString(), b.end.toISOString()]
const win = (from: string, to: string, tz = PR) => ({ from: new Date(from), to: new Date(to), defaultTimeZone: tz })
const cal = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`
const ev = (...props: string[]) => `BEGIN:VEVENT\r\n${props.join('\r\n')}\r\nEND:VEVENT`

// --- outbound -------------------------------------------------------------------------------------------------

test('the feed carries a generic title and times, and nothing that could name a client', () => {
  const text = buildFeed(
    [{ id: 'abc123', start: new Date('2026-11-12T14:00:00Z'), end: new Date('2026-11-12T14:50:00Z'), stamp: new Date('2026-11-10T01:00:00Z') }],
    { title: 'Cita' },
  )
  expect(text).toContain('BEGIN:VCALENDAR')
  expect(text).toContain('SUMMARY:Cita')
  expect(text).toContain('DTSTART:20261112T140000Z')
  expect(text).toContain('DTEND:20261112T145000Z')
  expect(text).toContain('UID:appt-abc123@psycrm')
  for (const forbidden of ['DESCRIPTION', 'LOCATION', 'ATTENDEE', 'ORGANIZER', 'URL', 'CONTACT']) expect(text).not.toContain(forbidden)
  expect(text.endsWith('\r\n')).toBe(true)
  expect(text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true)
})

test('the title can only be one of the two neutral words', () => {
  expect(buildFeed([{ id: 'x', start: new Date(0), end: new Date(60_000), stamp: new Date(0) }], { title: 'Ocupado' })).toContain('SUMMARY:Ocupado')
})

test('an empty feed is still a valid calendar', () => {
  const text = buildFeed([], { title: 'Cita' })
  expect(text).toContain('BEGIN:VCALENDAR')
  expect(text).toContain('END:VCALENDAR')
  expect(text).not.toContain('BEGIN:VEVENT')
})

test('long lines fold at 75 octets without splitting a character, and unfold back', () => {
  const long = `SUMMARY:${'ñ'.repeat(80)}`
  const folded = foldLine(long)
  for (const l of folded.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75)
  expect(unfold(folded)[0]).toBe(long)
  expect(icsUtc(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z')
})

// --- inbound: what comes out is only start and end ------------------------------------------------------------

test('a block is only a start and an end: the title, notes, place and people are never carried out', () => {
  const r = parseBusyBlocks(
    cal(ev('UID:1', 'DTSTART:20261112T150000Z', 'DTEND:20261112T160000Z', 'SUMMARY:Dentist - Maria Lopez', 'DESCRIPTION:call 787-555-0100', 'LOCATION:Clinic', 'ATTENDEE:mailto:m@x.com')),
    win('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
  )
  expect(r.isCalendar).toBe(true)
  expect(r.blocks).toHaveLength(1)
  expect(Object.keys(r.blocks[0]!).sort()).toEqual(['end', 'start'])
  expect(JSON.stringify(r)).not.toMatch(/Dentist|Maria|787|Clinic|mailto/)
})

test('UTC, zoned, floating and folded events all land on the right instant', () => {
  const r = parseBusyBlocks(
    cal(
      ev('UID:a', 'DTSTART:20261112T150000Z', 'DTEND:20261112T160000Z'),
      ev('UID:b', `DTSTART;TZID=${NY}:20261113T090000`, `DTEND;TZID=${NY}:20261113T100000`),
      ev('UID:c', 'DTSTART:20261114T090000', 'DTEND:20261114T100000'), // floating → default zone (PR, UTC-4)
      ev('UID:d', 'DTSTART:20261115T150000Z', 'DTEND:20261115T16', ' 0000Z'), // folded value
    ),
    win('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
  )
  expect(r.blocks.map(iso)).toEqual([
    ['2026-11-12T15:00:00.000Z', '2026-11-12T16:00:00.000Z'],
    ['2026-11-13T14:00:00.000Z', '2026-11-13T15:00:00.000Z'], // New York is UTC-5 in November
    ['2026-11-14T13:00:00.000Z', '2026-11-14T14:00:00.000Z'],
    ['2026-11-15T15:00:00.000Z', '2026-11-15T16:00:00.000Z'],
  ])
})

test('an all-day event blocks that whole day in the calendar zone; DURATION works in place of DTEND', () => {
  const r = parseBusyBlocks(
    cal(
      ev('UID:a', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261121'),
      ev('UID:b', 'DTSTART:20261122T150000Z', 'DURATION:PT90M'),
    ),
    win('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
  )
  expect(r.blocks.map(iso)).toEqual([
    ['2026-11-20T04:00:00.000Z', '2026-11-21T04:00:00.000Z'],
    ['2026-11-22T15:00:00.000Z', '2026-11-22T16:30:00.000Z'],
  ])
})

test('cancelled events, events marked free and events outside the window are ignored', () => {
  const r = parseBusyBlocks(
    cal(
      ev('UID:a', 'DTSTART:20261112T150000Z', 'DTEND:20261112T160000Z', 'STATUS:CANCELLED'),
      ev('UID:b', 'DTSTART:20261113T150000Z', 'DTEND:20261113T160000Z', 'TRANSP:TRANSPARENT'),
      ev('UID:c', 'DTSTART:20261114T150000Z', 'DTEND:20261114T160000Z', 'X-MICROSOFT-CDO-BUSYSTATUS:FREE'),
      ev('UID:d', 'DTSTART:20250101T150000Z', 'DTEND:20250101T160000Z'),
      ev('UID:e', 'DTSTART:20261116T150000Z', 'DTEND:20261116T160000Z', 'TRANSP:OPAQUE'),
    ),
    win('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
  )
  expect(r.blocks.map(iso)).toEqual([['2026-11-16T15:00:00.000Z', '2026-11-16T16:00:00.000Z']])
})

test('alarms nested inside an event do not disturb it, and junk lines are ignored', () => {
  const r = parseBusyBlocks(
    cal(ev('UID:a', 'DTSTART:20261112T150000Z', 'DTEND:20261112T160000Z', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'END:VALARM', 'GARBAGE LINE WITHOUT COLON')),
    win('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'),
  )
  expect(r.blocks).toHaveLength(1)
})

test('text that is not a calendar is reported as such', () => {
  const r = parseBusyBlocks('<html><body>Sign in to continue</body></html>', win('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))
  expect(r.isCalendar).toBe(false)
  expect(r.blocks).toEqual([])
})

// --- recurrence -----------------------------------------------------------------------------------------------

test('a weekly event on two days repeats on both, honouring COUNT', () => {
  const r = parseBusyBlocks(
    cal(ev('UID:w', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5')), // Mon Nov 2
    win('2026-11-01T00:00:00Z', '2026-12-31T00:00:00Z'),
  )
  expect(r.blocks.map((b) => b.start.toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16'])
})

test('INTERVAL and UNTIL: every other week until a date, and the UNTIL day itself still counts', () => {
  const r = parseBusyBlocks(
    cal(ev('UID:w', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261130T235959Z')),
    win('2026-11-01T00:00:00Z', '2027-03-01T00:00:00Z'),
  )
  expect(r.blocks.map((b) => b.start.toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-16', '2026-11-30'])
})

test('a recurring event that began years ago still shows up inside the window', () => {
  const r = parseBusyBlocks(
    cal(ev('UID:w', 'DTSTART:20190107T140000Z', 'DTEND:20190107T150000Z', 'RRULE:FREQ=WEEKLY')),
    win('2026-11-09T00:00:00Z', '2026-11-16T00:00:00Z'),
  )
  expect(r.blocks.map((b) => b.start.toISOString())).toEqual(['2026-11-09T14:00:00.000Z'])
})

test('EXDATE removes one occurrence; a modified instance replaces it; a cancelled instance disappears', () => {
  const r = parseBusyBlocks(
    cal(
      ev('UID:w', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE:20261109T140000Z'),
      ev('UID:m', 'DTSTART:20261102T140000Z', 'DTEND:20261102T150000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      ev('UID:m', 'RECURRENCE-ID:20261109T140000Z', 'DTSTART:20261109T180000Z', 'DTEND:20261109T190000Z'), // moved to 18:00
      ev('UID:x', 'DTSTART:20261103T200000Z', 'DTEND:20261103T210000Z', 'RRULE:FREQ=WEEKLY;COUNT=2'),
      ev('UID:x', 'RECURRENCE-ID:20261110T200000Z', 'DTSTART:20261110T200000Z', 'DTEND:20261110T210000Z', 'STATUS:CANCELLED'),
    ),
    win('2026-11-01T00:00:00Z', '2026-12-31T00:00:00Z'),
  )
  const starts = r.blocks.map((b) => b.start.toISOString())
  // UID w: Nov 2, (Nov 9 excluded), Nov 16, Nov 23   UID m: Nov 2, Nov 9 moved to 18:00, Nov 16   UID x: Nov 3 only
  expect(starts).toContain('2026-11-02T14:00:00.000Z')
  expect(starts).not.toContain('2026-11-09T14:00:00.000Z')
  expect(starts).toContain('2026-11-09T18:00:00.000Z')
  expect(starts).toContain('2026-11-23T14:00:00.000Z')
  expect(starts).toContain('2026-11-03T20:00:00.000Z')
  expect(starts).not.toContain('2026-11-10T20:00:00.000Z')
})

test('monthly rules: the second Tuesday, the last Friday, and a day that some months lack', () => {
  const win2 = win('2026-11-01T00:00:00Z', '2027-03-01T00:00:00Z')
  const second = parseBusyBlocks(cal(ev('UID:a', 'DTSTART:20261110T150000Z', 'DTEND:20261110T160000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU')), win2)
  expect(second.blocks.map((b) => b.start.toISOString().slice(0, 10))).toEqual(['2026-11-10', '2026-12-08', '2027-01-12', '2027-02-09'])
  const last = parseBusyBlocks(cal(ev('UID:b', 'DTSTART:20261127T150000Z', 'DTEND:20261127T160000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR')), win2)
  expect(last.blocks.map((b) => b.start.toISOString().slice(0, 10))).toEqual(['2026-11-27', '2026-12-25', '2027-01-29', '2027-02-26'])
  const day31 = parseBusyBlocks(cal(ev('UID:c', 'DTSTART:20261031T150000Z', 'DTEND:20261031T160000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=31')), win2)
  expect(day31.blocks.map((b) => b.start.toISOString().slice(0, 10))).toEqual(['2026-12-31', '2027-01-31']) // Nov and Feb have no 31st
})

test('a daily event keeps its wall-clock time across the daylight-saving change', () => {
  // Nov 1 2026 02:00 New York clocks go back. 09:00 local is 13:00Z before and 14:00Z after.
  const r = parseBusyBlocks(
    cal(ev('UID:d', `DTSTART;TZID=${NY}:20261030T090000`, `DTEND;TZID=${NY}:20261030T100000`, 'RRULE:FREQ=DAILY;COUNT=4')),
    win('2026-10-29T00:00:00Z', '2026-11-10T00:00:00Z', NY),
  )
  expect(r.blocks.map((b) => b.start.toISOString())).toEqual(['2026-10-30T13:00:00.000Z', '2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z'])
})

test('a rule this reader cannot expand is counted, and the event still blocks its first occurrence', () => {
  const r = parseBusyBlocks(
    cal(ev('UID:s', 'DTSTART:20261110T150000Z', 'DTEND:20261110T160000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')),
    win('2026-11-01T00:00:00Z', '2027-03-01T00:00:00Z'),
  )
  expect(r.unsupportedRules).toBe(1)
  expect(r.blocks).toHaveLength(1)
})

test('a runaway rule is bounded: a daily event from long ago with no end stays cheap and capped', () => {
  const r = parseBusyBlocks(
    cal(ev('UID:r', 'DTSTART:20000101T100000Z', 'DTEND:20000101T110000Z', 'RRULE:FREQ=DAILY')),
    { ...win('2026-11-01T00:00:00Z', '2027-02-01T00:00:00Z'), maxBlocks: 20 },
  )
  expect(r.blocks.length).toBeLessThanOrEqual(20)
  expect(r.truncated).toBe(true)
})

// --- merging --------------------------------------------------------------------------------------------------

test('overlapping and touching blocks merge, so the result does not reveal how many events there were', () => {
  const b = (a: string, z: string) => ({ start: new Date(a), end: new Date(z) })
  const merged = mergeBlocks([b('2026-11-12T15:00:00Z', '2026-11-12T16:00:00Z'), b('2026-11-12T15:30:00Z', '2026-11-12T17:00:00Z'), b('2026-11-12T17:00:00Z', '2026-11-12T18:00:00Z'), b('2026-11-12T20:00:00Z', '2026-11-12T21:00:00Z')])
  expect(merged.map(iso)).toEqual([['2026-11-12T15:00:00.000Z', '2026-11-12T18:00:00.000Z'], ['2026-11-12T20:00:00.000Z', '2026-11-12T21:00:00.000Z']])
})

test('zone names: IANA names pass, common Windows names are mapped, unknown names fall back', () => {
  expect(resolveZone('America/Puerto_Rico')).toBe('America/Puerto_Rico')
  expect(resolveZone('Eastern Standard Time')).toBe('America/New_York')
  expect(resolveZone('Nowhere/Land')).toBeNull()
  expect(resolveZone(undefined)).toBeNull()
})

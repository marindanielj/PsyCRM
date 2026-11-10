import { checkCalendarUrl, fetchCalendarText, guardedLookup, isBlockedAddress } from './ssrf'

test.each([
  '127.0.0.1', '127.8.8.8', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1',
  '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
  '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
  '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::1',
  'not-an-ip', '',
])('%s is refused', (ip) => {
  expect(isBlockedAddress(ip)).toBe(true)
})

test.each(['8.8.8.8', '142.250.80.46', '17.253.144.10', '172.15.0.1', '172.32.0.1', '2607:f8b0:4004:c1b::8a', '::ffff:8.8.8.8'])('%s is allowed', (ip) => {
  expect(isBlockedAddress(ip)).toBe(false)
})

test('webcal addresses (what iCloud gives out) become https', () => {
  const r = checkCalendarUrl('webcal://p12-caldav.icloud.com/published/2/abc')
  expect(r.ok && r.url.toString()).toBe('https://p12-caldav.icloud.com/published/2/abc')
  const s = checkCalendarUrl('  WEBCALS://example.com/x.ics  ')
  expect(s.ok && s.url.protocol).toBe('https:')
})

test('only https addresses to public hosts are accepted', () => {
  expect(checkCalendarUrl('http://calendar.google.com/x.ics')).toEqual({ ok: false, error: 'not_https' })
  expect(checkCalendarUrl('ftp://example.com/x.ics')).toEqual({ ok: false, error: 'not_https' })
  expect(checkCalendarUrl('file:///etc/passwd')).toEqual({ ok: false, error: 'not_https' })
  expect(checkCalendarUrl('javascript:alert(1)')).toEqual({ ok: false, error: 'not_https' })
  expect(checkCalendarUrl('not a url')).toEqual({ ok: false, error: 'bad_url' })
  expect(checkCalendarUrl('https://user:pass@example.com/x.ics')).toEqual({ ok: false, error: 'bad_url' })
  for (const bad of [
    'https://localhost/x.ics', 'https://app.localhost/x', 'https://printer.local/x', 'https://db.internal/x',
    'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x',
    'https://2130706433/x', // 127.0.0.1 written as one number
    'https://0x7f.1/x',
  ]) {
    expect(checkCalendarUrl(bad), bad).toEqual({ ok: false, error: 'blocked_address' })
  }
  expect(checkCalendarUrl('https://calendar.google.com/calendar/ical/x%40gmail.com/private-abc/basic.ics').ok).toBe(true)
})

// The address a socket really connects to is checked, so a name that resolves somewhere private is refused
// even though the name itself looked fine (DNS rebinding).
const resolver = (answers: { address: string; family: number }[]) =>
  ((_h: string, _o: unknown, cb: (e: null, a: typeof answers) => void) => cb(null, answers)) as unknown as Parameters<typeof guardedLookup>[0]

function lookup(answers: { address: string; family: number }[], all = false) {
  return new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
    guardedLookup(resolver(answers))('cal.example.com', { all }, (err, address) => resolve({ err, address })),
  )
}

test('a name that resolves to a private address is refused at connect time', async () => {
  const r = await lookup([{ address: '10.0.0.7', family: 4 }])
  expect(r.err?.code).toBe('EBLOCKED')
})

test('one private answer among public ones is enough to refuse', async () => {
  const r = await lookup([{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }], true)
  expect(r.err?.code).toBe('EBLOCKED')
})

test('public answers pass, in both the single and the list form', async () => {
  const one = await lookup([{ address: '142.250.80.46', family: 4 }])
  expect(one.err).toBeNull()
  expect(one.address).toBe('142.250.80.46')
  const all = await lookup([{ address: '142.250.80.46', family: 4 }], true)
  expect(all.address).toEqual([{ address: '142.250.80.46', family: 4 }])
})

test('an empty answer is refused rather than trusted', async () => {
  expect((await lookup([])).err?.code).toBe('EBLOCKED')
})

test('fetching refuses bad addresses before touching the network', async () => {
  expect(await fetchCalendarText('http://calendar.example.com/x.ics')).toEqual({ ok: false, error: 'not_https' })
  expect(await fetchCalendarText('https://127.0.0.1/x.ics')).toEqual({ ok: false, error: 'blocked_address' })
  expect(await fetchCalendarText('https://169.254.169.254/latest/meta-data/')).toEqual({ ok: false, error: 'blocked_address' })
  expect(await fetchCalendarText('https://localhost:8790/health')).toEqual({ ok: false, error: 'blocked_address' })
  expect(await fetchCalendarText('garbage')).toEqual({ ok: false, error: 'unreachable' })
  expect(await fetchCalendarText('https://calendar.example.com/x.ics', { timeoutMs: 0 })).toEqual({ ok: false, error: 'timeout' })
})

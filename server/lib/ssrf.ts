/**
 * Fetching a calendar address the user typed, from a server inside the practice's network.
 *
 * That is the classic server-side request forgery shape: without care, "my calendar address" could be
 * `https://169.254.169.254/...` (the cloud metadata service) or an internal admin URL, and the server would fetch it and
 * show or act on the answer. So:
 *
 *  - only https (an `webcal://` address, which iCloud hands out, is the same thing and is converted);
 *  - the address a connection really uses is checked AT CONNECT TIME in the socket's own `lookup`, so a hostname that
 *    resolves to a private address (or flips to one between a check and the connect — DNS rebinding) is refused;
 *  - every redirect is checked again, and there are at most 3;
 *  - a size cap and a total time cap, so a slow or endless response cannot hold a worker;
 *  - the body is only ever parsed as a calendar; nothing about the response is echoed back to the user.
 */
import { lookup as dnsLookup } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'

export type FetchError =
  | 'blocked_address'
  | 'not_https'
  | 'unreachable'
  | 'timeout'
  | 'http_error'
  | 'too_large'
  | 'too_many_redirects'

export type FetchResult = { ok: true; text: string } | { ok: false; error: FetchError }

export const MAX_CALENDAR_BYTES = 5 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

// --- addresses ---------------------------------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const p = ip.split('.')
  if (p.length !== 4) return null
  let n = 0
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]

function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true // unparseable: refuse
  return V4_BLOCKS.some(([base, bits]) => {
    const b = ipv4ToInt(base) as number
    const size = 2 ** (32 - bits)
    return Math.floor(n / size) === Math.floor(b / size)
  })
}

/** An IPv6 address as eight 16-bit groups, or null. Handles `::` and a trailing dotted IPv4. */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (dotted) {
    const n = ipv4ToInt(dotted[1]!)
    if (n === null) return null
    s = s.slice(0, s.length - dotted[1]!.length) + `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN))
  return out.some(Number.isNaN) ? null : out
}

function v6Blocked(ip: string): boolean {
  const g = expandV6(ip)
  if (!g) return true
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  if (g.every((x) => x === 0)) return true // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d): judge by the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4Blocked(embeddedV4(g[6]!, g[7]!))
  // NAT64 (64:ff9b::/96): judge by the IPv4 inside.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embeddedV4(g[6]!, g[7]!))
  // 6to4 (2002::/16) carries an IPv4 in groups 1-2.
  if (g[0] === 0x2002) return v4Blocked(embeddedV4(g[1]!, g[2]!))
  if ((g[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g[0]! & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
  return false
}

/** True when a connection to this address must be refused (loopback, private, link-local, metadata, multicast...). */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return v4Blocked(ip)
  if (v === 6) return v6Blocked(ip)
  return true // not an address at all
}

// --- the address the person typed ---------------------------------------------------------------------------------

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: 'not_https' | 'blocked_address' | 'bad_url' }

/**
 * Validate (and normalize) a calendar address. `webcal://` becomes `https://`. Credentials in the address, a non-https
 * scheme, a local-looking hostname or a literal private IP are refused here, before any network is touched.
 */
export function checkCalendarUrl(raw: string): UrlCheck {
  let text = raw.trim()
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:\/\//i, 'https://')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: 'bad_url' }
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'not_https' }
  if (url.username || url.password) return { ok: false, error: 'bad_url' }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host.length > 253) return { ok: false, error: 'bad_url' }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    return { ok: false, error: 'blocked_address' }
  }
  if (isIP(host) !== 0 && isBlockedAddress(host)) return { ok: false, error: 'blocked_address' }
  // A numeric host that is not a clean dotted address (e.g. 2130706433 or 0x7f.1) is parsed as IPv4 by URL.
  if (/^[0-9.x]+$/i.test(host) && isIP(host) === 0) return { ok: false, error: 'blocked_address' }
  return { ok: true, url }
}

// --- the fetch ---------------------------------------------------------------------------------------------------

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void

/** A `lookup` for the socket that resolves normally but refuses any answer that includes a blocked address. */
export function guardedLookup(
  resolve: typeof dnsLookup = dnsLookup,
): (hostname: string, options: { all?: boolean; family?: number }, cb: LookupCb) => void {
  return (hostname, options, cb) => {
    resolve(hostname, { all: true, family: options.family ?? 0 }, (err, addrs) => {
      if (err) return cb(err, '', 0)
      const list = addrs as { address: string; family: number }[]
      if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
        const e = new Error('blocked address') as NodeJS.ErrnoException
        e.code = 'EBLOCKED'
        return cb(e, '', 0)
      }
      if (options.all) return cb(null, list)
      return cb(null, list[0]!.address, list[0]!.family)
    })
  }
}

/** Fetch the text of a calendar address under the rules above. Never throws. */
export async function fetchCalendarText(
  raw: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? MAX_CALENDAR_BYTES
  const deadline = Date.now() + (opts.timeoutMs ?? FETCH_TIMEOUT_MS)
  let current = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const chk = checkCalendarUrl(current)
    if (!chk.ok) return { ok: false, error: chk.error === 'bad_url' ? 'unreachable' : chk.error }
    const r = await once(chk.url, maxBytes, deadline - Date.now())
    if (r.kind === 'redirect') {
      try {
        current = new URL(r.location, chk.url).toString()
      } catch {
        return { ok: false, error: 'http_error' }
      }
      continue
    }
    return r.result
  }
  return { ok: false, error: 'too_many_redirects' }
}

type Once = { kind: 'done'; result: FetchResult } | { kind: 'redirect'; location: string }

function once(url: URL, maxBytes: number, timeoutMs: number): Promise<Once> {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) return resolve({ kind: 'done', result: { ok: false, error: 'timeout' } })
    let settled = false
    const finish = (r: Once) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const fail = (error: FetchError) => finish({ kind: 'done', result: { ok: false, error } })
    const timer = setTimeout(() => {
      req.destroy()
      fail('timeout')
    }, timeoutMs)

    const req = https.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup() as unknown as https.RequestOptions['lookup'],
        headers: {
          accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'PsyCRM-calendar-sync',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          return finish({ kind: 'redirect', location: String(res.headers.location) })
        }
        if (status < 200 || status >= 300) {
          res.resume()
          return fail('http_error')
        }
        const declared = Number(res.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy()
          return fail('too_large')
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > maxBytes) {
            res.destroy()
            return fail('too_large')
          }
          chunks.push(c)
        })
        res.on('end', () => finish({ kind: 'done', result: { ok: true, text: Buffer.concat(chunks).toString('utf8') } }))
        res.on('error', () => fail('unreachable'))
      },
    )
    req.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'EBLOCKED' ? 'blocked_address' : 'unreachable'))
    req.end()
  })
}

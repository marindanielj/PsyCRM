/**
 * iCalendar (.ics) in both directions, for calendar sync (INTEGRACIONES.md §3.1).
 *
 * The golden rule is that only TIME BLOCKS cross: start and end, never a title, name, description, place or
 * attendee. The two halves enforce it differently:
 *
 *  - `buildFeed` (PsyCRM → phone) can only emit what its input type carries: an id, a start and an end. It has no
 *    parameter through which a client's name could arrive.
 *  - `parseBusyBlocks` (phone → PsyCRM) reads a calendar and returns only `{ start, end }`. SUMMARY, DESCRIPTION,
 *    LOCATION and the rest are never copied anywhere: they are not retained, not logged, not returned.
 *
 * Pure and deterministic: `now` and the window are arguments, nothing here touches the network or the database.
 */
import { addDays, parseYmd, weekdayOf, zonedWallToUtc } from './availability'

const CRLF = '\r\n'
const DAY_MS = 24 * 60 * 60_000

// --- outbound ---------------------------------------------------------------------------------------------------

export interface FeedEvent {
  /** Stable per appointment, so a phone updates the event instead of duplicating it. */
  id: string
  start: Date
  end: Date
  /** When the appointment last changed (becomes DTSTAMP). */
  stamp: Date
}

/** `20261105T150000Z` */
export function icsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Fold a content line to at most 75 octets per physical line, never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const parts: string[] = []
  let cur = ''
  let curBytes = 0
  let limit = 75
  for (const ch of line) {
    const n = enc.encode(ch).length
    if (curBytes + n > limit) {
      parts.push(cur)
      cur = ''
      curBytes = 0
      limit = 74 // a continuation line starts with one space
    }
    cur += ch
    curBytes += n
  }
  parts.push(cur)
  return parts.join(`${CRLF} `)
}

/**
 * The practice's feed: one generic block per appointment. `title` is the only text, and it is fixed by the caller to one
 * of two neutral words.
 */
export function buildFeed(events: readonly FeedEvent[], opts: { title: 'Cita' | 'Ocupado' }): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PsyCRM//Appointments feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Appointments',
    // Hints for the apps that honour them; Google ignores them and refreshes on its own schedule.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ]
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:appt-${e.id}@psycrm`,
      `DTSTAMP:${icsUtc(e.stamp)}`,
      `DTSTART:${icsUtc(e.start)}`,
      `DTEND:${icsUtc(e.end)}`,
      `SUMMARY:${escapeText(opts.title)}`,
      'TRANSP:OPAQUE',
      'STATUS:CONFIRMED',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join(CRLF) + CRLF
}

// --- inbound ----------------------------------------------------------------------------------------------------

export interface Block {
  start: Date
  end: Date
}

export interface ParseOptions {
  /** Only blocks that overlap [from, to) are returned. */
  from: Date
  to: Date
  /** Zone for floating times and all-day dates. */
  defaultTimeZone: string
  /** Safety caps, so a hostile or enormous calendar cannot exhaust memory or time. */
  maxBlocks?: number
  maxOccurrencesPerEvent?: number
}

export interface ParseResult {
  blocks: Block[]
  /** More blocks than `maxBlocks` were found; the earliest were kept. */
  truncated: boolean
  /** Recurring events whose rule uses parts this reader does not expand (kept as a single occurrence). */
  unsupportedRules: number
  /** The text was an iCalendar at all. */
  isCalendar: boolean
}

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

/** Undo line folding (RFC 5545 §3.1). */
export function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
}

function parseLine(line: string): Prop | null {
  // name *(";" param) ":" value — a ':' or ';' inside a quoted param value does not end the section.
  let i = 0
  let inQuote = false
  const params: string[] = []
  let name = ''
  let seg = ''
  let gotName = false
  for (; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') inQuote = !inQuote
    if (!inQuote && ch === ';') {
      if (!gotName) {
        name = seg
        gotName = true
      } else params.push(seg)
      seg = ''
      continue
    }
    if (!inQuote && ch === ':') {
      if (!gotName) name = seg
      else params.push(seg)
      const p: Record<string, string> = {}
      for (const x of params) {
        const eq = x.indexOf('=')
        if (eq > 0) p[x.slice(0, eq).toUpperCase()] = x.slice(eq + 1).replace(/^"|"$/g, '')
      }
      return { name: name.toUpperCase(), params: p, value: line.slice(i + 1) }
    }
    seg += ch
  }
  return null
}

const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'SA Western Standard Time': 'America/Puerto_Rico',
  'Atlantic Standard Time': 'America/Halifax',
  'UTC': 'UTC',
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The IANA zone a TZID names, or null when it names none this reader knows. */
export function resolveZone(tzid: string | undefined): string | null {
  if (!tzid) return null
  if (validZone(tzid)) return tzid
  const mapped = WINDOWS_ZONES[tzid]
  return mapped && validZone(mapped) ? mapped : null
}

interface When {
  /** The UTC instant. */
  at: Date
  /** The zone the wall-clock lives in (for recurrence), or 'UTC'. */
  zone: string
  allDay: boolean
  /** Wall-clock parts in `zone`. */
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number }
}

function parseWhen(p: Prop, defaultZone: string): When | null {
  const v = p.value.trim()
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (dateOnly) {
    const wall = { year: +dateOnly[1]!, month: +dateOnly[2]!, day: +dateOnly[3]!, hour: 0, minute: 0, second: 0 }
    return { at: zonedWallToUtc(wall, defaultZone), zone: defaultZone, allDay: true, wall }
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v)
  if (!m) return null
  const wall = { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: +m[6]! }
  if (m[7] === 'Z') {
    const at = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second))
    return { at, zone: 'UTC', allDay: false, wall }
  }
  const zone = resolveZone(p.params.TZID) ?? defaultZone
  return { at: zonedWallToUtc(wall, zone), zone, allDay: false, wall }
}

/** ISO-8601 duration (the subset iCalendar uses) in ms, or null. */
function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim())
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 24 * 3600 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000
  return sign === '-' ? -ms : ms
}

// --- recurrence -------------------------------------------------------------------------------------------------

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count: number | null
  until: Date | null
  byDay: { ord: number; wd: number }[]
  byMonthDay: number[]
  byMonth: number[]
  wkst: number
}

/** Parse an RRULE; `null` when it uses something this reader does not expand. */
function parseRule(value: string, defaultZone: string): Rule | null {
  const kv: Record<string, string> = {}
  for (const part of value.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1)
  }
  const freq = kv.FREQ
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null
  // Parts that change the meaning in ways not implemented here.
  for (const k of ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND']) if (kv[k]) return null

  const byDay: Rule['byDay'] = []
  if (kv.BYDAY) {
    for (const tok of kv.BYDAY.split(',')) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok.trim().toUpperCase())
      if (!m) return null
      byDay.push({ ord: m[1] ? parseInt(m[1], 10) : 0, wd: DAY_CODES.indexOf(m[2] as (typeof DAY_CODES)[number]) })
    }
  }
  const nums = (s: string | undefined) => (s ? s.split(',').map((x) => parseInt(x, 10)) : [])
  const byMonthDay = nums(kv.BYMONTHDAY)
  const byMonth = nums(kv.BYMONTH)
  if ([...byMonthDay, ...byMonth].some((n) => Number.isNaN(n))) return null

  let until: Date | null = null
  if (kv.UNTIL) {
    const w = parseWhen({ name: 'UNTIL', params: {}, value: kv.UNTIL }, defaultZone)
    if (!w) return null
    // A date-only UNTIL runs to the end of that day.
    until = w.allDay ? new Date(w.at.getTime() + DAY_MS - 1) : w.at
  }
  const interval = kv.INTERVAL ? parseInt(kv.INTERVAL, 10) : 1
  const count = kv.COUNT ? parseInt(kv.COUNT, 10) : null
  if (!(interval >= 1) || (count !== null && !(count >= 1))) return null
  const wkstIdx = kv.WKST ? DAY_CODES.indexOf(kv.WKST.toUpperCase() as (typeof DAY_CODES)[number]) : 1
  return { freq, interval, count, until, byDay, byMonthDay, byMonth, wkst: wkstIdx < 0 ? 1 : wkstIdx }
}

interface Ymd {
  year: number
  month: number
  day: number
}

const ymdStr = (d: Ymd) => `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const cmpYmd = (a: Ymd, b: Ymd) => a.year - b.year || a.month - b.month || a.day - b.day

/** The dates inside one month matching BYDAY (with optional ordinals) and/or BYMONTHDAY. */
function monthDates(year: number, month: number, rule: Rule, startDay: number): number[] {
  const dim = daysInMonth(year, month)
  const out = new Set<number>()
  if (rule.byMonthDay.length > 0) {
    for (const d of rule.byMonthDay) {
      const day = d > 0 ? d : dim + d + 1
      if (day >= 1 && day <= dim) out.add(day)
    }
    if (rule.byDay.length > 0) {
      // Both given: the days must satisfy both.
      const wds = new Set(rule.byDay.map((b) => b.wd))
      for (const day of [...out]) if (!wds.has(weekdayOf(year, month, day))) out.delete(day)
    }
  } else if (rule.byDay.length > 0) {
    for (const { ord, wd } of rule.byDay) {
      const matches: number[] = []
      for (let day = 1; day <= dim; day++) if (weekdayOf(year, month, day) === wd) matches.push(day)
      if (ord === 0) matches.forEach((d) => out.add(d))
      else {
        const pick = ord > 0 ? matches[ord - 1] : matches[matches.length + ord]
        if (pick !== undefined) out.add(pick)
      }
    }
  } else if (startDay <= dim) out.add(startDay)
  return [...out].sort((a, b) => a - b)
}

/**
 * Every occurrence DATE (wall-clock, in the event's zone) of a rule, in order, from DTSTART until `stopAfter`.
 * `COUNT` is honoured by counting from DTSTART, so the walk starts at the beginning even when the window is far later.
 */
function* occurrenceDates(start: Ymd, rule: Rule, stopAfter: Ymd): Generator<Ymd> {
  const MAX_PERIODS = 60_000
  let emitted = 0
  const emit = (d: Ymd): boolean => {
    if (cmpYmd(d, start) < 0) return false
    emitted++
    return rule.count !== null && emitted > rule.count
  }

  if (rule.freq === 'DAILY') {
    for (let k = 0; k < MAX_PERIODS; k++) {
      const d = parseYmd(addDays(ymdStr(start), k * rule.interval))
      if (cmpYmd(d, stopAfter) > 0) return
      if (rule.byDay.length > 0 && !rule.byDay.some((b) => b.wd === weekdayOf(d.year, d.month, d.day))) continue
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(d.month)) continue
      if (rule.byMonthDay.length > 0) {
        const dim = daysInMonth(d.year, d.month)
        if (!rule.byMonthDay.some((x) => (x > 0 ? x : dim + x + 1) === d.day)) continue
      }
      if (emit(d)) return
      yield d
    }
    return
  }

  if (rule.freq === 'WEEKLY') {
    const wds = rule.byDay.length > 0 ? rule.byDay.map((b) => b.wd) : [weekdayOf(start.year, start.month, start.day)]
    // Start of the week (per WKST) that contains DTSTART.
    const back = (weekdayOf(start.year, start.month, start.day) - rule.wkst + 7) % 7
    const week0 = addDays(ymdStr(start), -back)
    const offsets = [...new Set(wds.map((wd) => (wd - rule.wkst + 7) % 7))].sort((a, b) => a - b)
    for (let k = 0; k < MAX_PERIODS; k++) {
      const weekStart = addDays(week0, k * rule.interval * 7)
      if (cmpYmd(parseYmd(weekStart), stopAfter) > 0) return
      for (const off of offsets) {
        const d = parseYmd(addDays(weekStart, off))
        if (cmpYmd(d, start) < 0) continue
        if (cmpYmd(d, stopAfter) > 0) return
        if (rule.byMonth.length > 0 && !rule.byMonth.includes(d.month)) continue
        if (emit(d)) return
        yield d
      }
    }
    return
  }

  if (rule.freq === 'MONTHLY') {
    for (let k = 0; k < MAX_PERIODS; k++) {
      const idx = start.month - 1 + k * rule.interval
      const year = start.year + Math.floor(idx / 12)
      const month = (idx % 12) + 1
      if (cmpYmd({ year, month, day: 1 }, stopAfter) > 0) return
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) continue
      for (const day of monthDates(year, month, rule, start.day)) {
        const d = { year, month, day }
        if (cmpYmd(d, start) < 0) continue
        if (cmpYmd(d, stopAfter) > 0) return
        if (emit(d)) return
        yield d
      }
    }
    return
  }

  // YEARLY
  const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [start.month]
  for (let k = 0; k < MAX_PERIODS; k++) {
    const year = start.year + k * rule.interval
    if (cmpYmd({ year, month: 1, day: 1 }, stopAfter) > 0) return
    for (const month of months) {
      for (const day of monthDates(year, month, rule, start.day)) {
        const d = { year, month, day }
        if (cmpYmd(d, start) < 0) continue
        if (cmpYmd(d, stopAfter) > 0) return
        if (emit(d)) return
        yield d
      }
    }
  }
}

// --- the reader -------------------------------------------------------------------------------------------------

interface RawEvent {
  uid: string
  dtstart: Prop | null
  dtend: Prop | null
  duration: string | null
  rrule: string | null
  exdates: Prop[]
  rdates: Prop[]
  recurrenceId: Prop | null
  cancelled: boolean
  transparent: boolean
}

/** Collect the VEVENTs, keeping ONLY the timing properties. Everything else on the line is dropped as it is read. */
function collectEvents(lines: string[]): { events: RawEvent[]; isCalendar: boolean } {
  const events: RawEvent[] = []
  let isCalendar = false
  let cur: RawEvent | null = null
  let alarmDepth = 0
  for (const line of lines) {
    const p = parseLine(line)
    if (!p) continue
    if (p.name === 'BEGIN') {
      const what = p.value.trim().toUpperCase()
      if (what === 'VCALENDAR') isCalendar = true
      else if (what === 'VEVENT') {
        cur = { uid: '', dtstart: null, dtend: null, duration: null, rrule: null, exdates: [], rdates: [], recurrenceId: null, cancelled: false, transparent: false }
        alarmDepth = 0
      } else if (cur) alarmDepth++ // VALARM and friends nested inside an event
      continue
    }
    if (p.name === 'END') {
      const what = p.value.trim().toUpperCase()
      if (what === 'VEVENT' && cur) {
        events.push(cur)
        cur = null
      } else if (cur && alarmDepth > 0) alarmDepth--
      continue
    }
    if (!cur || alarmDepth > 0) continue
    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break
      case 'DTSTART': cur.dtstart = p; break
      case 'DTEND': cur.dtend = p; break
      case 'DURATION': cur.duration = p.value; break
      case 'RRULE': cur.rrule = p.value; break
      case 'EXDATE': cur.exdates.push(p); break
      case 'RDATE': cur.rdates.push(p); break
      case 'RECURRENCE-ID': cur.recurrenceId = p; break
      case 'STATUS': if (p.value.trim().toUpperCase() === 'CANCELLED') cur.cancelled = true; break
      case 'TRANSP': if (p.value.trim().toUpperCase() === 'TRANSPARENT') cur.transparent = true; break
      case 'X-MICROSOFT-CDO-BUSYSTATUS': if (p.value.trim().toUpperCase() === 'FREE') cur.transparent = true; break
      default: break // SUMMARY, DESCRIPTION, LOCATION, ATTENDEE, ORGANIZER, URL... never kept
    }
  }
  return { events, isCalendar }
}

function dateList(p: Prop, zone: string): When[] {
  const out: When[] = []
  for (const v of p.value.split(',')) {
    const w = parseWhen({ ...p, value: v }, zone)
    if (w) out.push(w)
  }
  return out
}

/** Merge overlapping or touching blocks, so the result says nothing about how many events there were. */
export function mergeBlocks(blocks: Block[]): Block[] {
  const sorted = [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime())
  const out: Block[] = []
  for (const b of sorted) {
    const last = out[out.length - 1]
    if (last && b.start.getTime() <= last.end.getTime()) {
      if (b.end.getTime() > last.end.getTime()) last.end = b.end
    } else out.push({ start: b.start, end: b.end })
  }
  return out
}

/**
 * Read a calendar's busy blocks that overlap the window. Returns start and end only.
 *
 * Skipped: cancelled events and events marked free (TRANSP:TRANSPARENT). Recurring events are expanded for
 * DAILY/WEEKLY/MONTHLY/YEARLY rules (INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, EXDATE, RDATE, per-instance overrides).
 */
export function parseBusyBlocks(text: string, opts: ParseOptions): ParseResult {
  const maxBlocks = opts.maxBlocks ?? 5000
  const maxPerEvent = opts.maxOccurrencesPerEvent ?? 3000
  const { events, isCalendar } = collectEvents(unfold(text))
  const wFrom = opts.from.getTime()
  const wTo = opts.to.getTime()
  const raw: Block[] = []
  let unsupportedRules = 0

  // A modified instance of a recurring event replaces that one occurrence of its master.
  const replaced = new Map<string, Set<number>>()
  for (const ev of events) {
    if (!ev.recurrenceId) continue
    const w = parseWhen(ev.recurrenceId, opts.defaultTimeZone)
    if (!w) continue
    const set = replaced.get(ev.uid) ?? new Set<number>()
    set.add(w.at.getTime())
    replaced.set(ev.uid, set)
  }

  const push = (start: Date, end: Date) => {
    if (end.getTime() > start.getTime() && end.getTime() > wFrom && start.getTime() < wTo) raw.push({ start, end })
  }

  for (const ev of events) {
    if (ev.cancelled || ev.transparent || !ev.dtstart) continue
    const s = parseWhen(ev.dtstart, opts.defaultTimeZone)
    if (!s) continue

    let durMs: number
    const e = ev.dtend ? parseWhen(ev.dtend, opts.defaultTimeZone) : null
    if (e && e.at.getTime() > s.at.getTime()) durMs = e.at.getTime() - s.at.getTime()
    else if (ev.duration && parseDuration(ev.duration) !== null && (parseDuration(ev.duration) as number) > 0) durMs = parseDuration(ev.duration) as number
    else durMs = s.allDay ? DAY_MS : 0
    if (durMs <= 0) continue // an instant with no length blocks nothing

    // The overrides the master must skip, plus its own EXDATEs.
    const skip = new Set<number>(replaced.get(ev.uid) ?? [])
    const isOverride = ev.recurrenceId !== null
    if (!isOverride) {
      for (const x of ev.exdates) for (const w of dateList(x, s.zone)) skip.add(w.at.getTime())
    }

    const startAt = (d: Ymd): Date =>
      s.zone === 'UTC' && !s.allDay
        ? new Date(Date.UTC(d.year, d.month - 1, d.day, s.wall.hour, s.wall.minute, s.wall.second))
        : zonedWallToUtc({ ...d, hour: s.wall.hour, minute: s.wall.minute }, s.zone)

    const rule = !isOverride && ev.rrule ? parseRule(ev.rrule, s.zone) : null
    if (!isOverride && ev.rrule && !rule) unsupportedRules++

    if (rule) {
      const stopAfter = parseYmd(addDays(new Date(wTo).toISOString().slice(0, 10), 1))
      let n = 0
      for (const d of occurrenceDates({ year: s.wall.year, month: s.wall.month, day: s.wall.day }, rule, stopAfter)) {
        const at = startAt(d)
        if (rule.until && at.getTime() > rule.until.getTime()) break
        if (++n > maxPerEvent * 20) break // runaway guard on the walk itself
        if (at.getTime() >= wTo) break
        if (skip.has(at.getTime())) continue
        push(at, new Date(at.getTime() + durMs))
      }
    } else if (!skip.has(s.at.getTime()) || isOverride) {
      push(s.at, new Date(s.at.getTime() + durMs))
    }

    if (!isOverride) {
      for (const r of ev.rdates) for (const w of dateList(r, s.zone)) if (!skip.has(w.at.getTime())) push(w.at, new Date(w.at.getTime() + durMs))
    }
  }

  const merged = mergeBlocks(raw)
  const truncated = merged.length > maxBlocks
  return { blocks: truncated ? merged.slice(0, maxBlocks) : merged, truncated, unsupportedRules, isCalendar }
}

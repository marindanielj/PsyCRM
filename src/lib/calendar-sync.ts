import type { BusyBlock } from './api'
import { formatTime } from './utils'

/** What the person sees for each short code the server reports. Never the address or the response. */
export const SYNC_MESSAGES: Record<string, string> = {
  invalid_url: 'That does not look like a calendar address.',
  not_https: 'The address has to start with https:// (or webcal://).',
  blocked_address: 'That address points to a private or internal place, so it cannot be read.',
  own_feed: 'That is this app’s own address. Paste the address of your personal calendar instead.',
  too_many_calendars: 'You have reached the limit of connected calendars. Remove one first.',
  unreachable: 'Could not reach that address. Check it and try again.',
  timeout: 'The calendar took too long to answer.',
  http_error: 'The calendar service refused the request. The address may have been reset: copy a fresh one.',
  too_large: 'That calendar is too large to read.',
  too_many_redirects: 'That address redirects too many times.',
  not_calendar: 'That address did not return a calendar. Make sure you copied the secret iCal address.',
  secret_unreadable: 'This saved address can no longer be opened. Remove the calendar and connect it again.',
  too_soon: 'It was just read. Try again in a minute.',
  paused: 'This calendar is paused. Resume it first.',
}

export const syncMessage = (code: string | undefined | null): string => (code && SYNC_MESSAGES[code]) || 'Something went wrong. Please try again.'

/** The part of each block that falls on this local day, as chips like "11:00 AM – 12:00 PM" (or "All day"). */
export function busyChipsForDay(blocks: BusyBlock[], day: Date): string[] {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
  const out: string[] = []
  for (const b of blocks) {
    const s = Math.max(new Date(b.start).getTime(), dayStart)
    const e = Math.min(new Date(b.end).getTime(), dayEnd)
    if (e <= s) continue
    out.push(e - s >= 23 * 3600_000 ? 'All day' : `${formatTime(new Date(s).toISOString())} – ${formatTime(new Date(e).toISOString())}`)
  }
  return out
}

/**
 * When a session's video link works: from 15 minutes before the scheduled start until 60 minutes
 * after the scheduled end (room for a session that runs long, or a client who drops and rejoins).
 * Outside it the link shows "not open yet" / "this session has ended". Pure: no I/O.
 */
export const OPENS_BEFORE_MS = 15 * 60_000
export const CLOSES_AFTER_MS = 60 * 60_000

export type VideoWindowState = 'not_yet' | 'open' | 'ended'

export function videoWindow(startsAt: string | Date, endsAt: string | Date, now: Date = new Date()): { state: VideoWindowState; opensAt: Date; closesAt: Date } {
  const opensAt = new Date(new Date(startsAt).getTime() - OPENS_BEFORE_MS)
  const closesAt = new Date(new Date(endsAt).getTime() + CLOSES_AFTER_MS)
  const t = now.getTime()
  const state: VideoWindowState = t < opensAt.getTime() ? 'not_yet' : t >= closesAt.getTime() ? 'ended' : 'open'
  return { state, opensAt, closesAt }
}

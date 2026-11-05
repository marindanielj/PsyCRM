/**
 * Age from a date of birth. Pure and calendar-exact (a birthday counts on the day
 * itself, Feb 29 birthdays count on Mar 1 in non-leap years), evaluated in the
 * practice's timezone so "today" does not flip at midnight UTC (8 pm in Puerto Rico).
 */
export const PRACTICE_TZ = 'America/Puerto_Rico'
/** In this practice an adult — able to consent for themselves — is 18 or older. */
export const ADULT_AGE = 18

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Today's calendar date (YYYY-MM-DD) in the given timezone. */
export function todayIn(tz: string = PRACTICE_TZ, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** True for a real calendar date written YYYY-MM-DD (rejects 2024-02-31, 13th month…). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = ISO_DATE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/**
 * Whole years between `dob` and `today` (both YYYY-MM-DD), or null if either is not
 * a valid date or the birth date is in the future.
 */
export function ageOn(dob: unknown, today: string = todayIn()): number | null {
  if (!isValidIsoDate(dob) || !isValidIsoDate(today)) return null
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number]
  let age = ty - by
  // Birthday not reached yet this year. A Feb 29 birthday is reached on Mar 1 in a
  // non-leap year, which "month/day not yet reached" gives naturally (3/1 >= 2/29).
  if (tm < bm || (tm === bm && td < bd)) age--
  return age < 0 ? null : age
}

/** True when the person is under 18 on `today`; null when the date of birth is unknown/invalid. */
export function isMinor(dob: unknown, today?: string): boolean | null {
  const age = ageOn(dob, today)
  return age === null ? null : age < ADULT_AGE
}

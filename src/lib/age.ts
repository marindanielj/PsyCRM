// Web copy of the age rules in server/lib/age.ts (kept here so the bundle stays
// frontend-only). server/lib/age-mirror.test.ts fails if the two drift apart.

export const PRACTICE_TZ = 'America/Puerto_Rico'
export const ADULT_AGE = 18

export function todayInPractice(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PRACTICE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/** Whole years on `today` (YYYY-MM-DD), or null for an unknown/invalid date or one in the future. */
export function ageOn(dob: unknown, today: string = todayInPractice()): number | null {
  if (!isValidIsoDate(dob) || !isValidIsoDate(today)) return null
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number]
  let age = ty - by
  if (tm < bm || (tm === bm && td < bd)) age--
  return age < 0 ? null : age
}

export function isMinor(dob: unknown, today?: string): boolean | null {
  const age = ageOn(dob, today)
  return age === null ? null : age < ADULT_AGE
}

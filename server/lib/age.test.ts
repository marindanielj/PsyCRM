import { ageOn, isMinor, isValidIsoDate, todayIn } from './age'

test('counts whole years, with the birthday counting on the day itself', () => {
  expect(ageOn('2008-11-05', '2026-11-04')).toBe(17) // turns 18 tomorrow
  expect(ageOn('2008-11-05', '2026-11-05')).toBe(18) // on the birthday
  expect(ageOn('2008-11-05', '2026-11-06')).toBe(18)
  expect(ageOn('1990-01-31', '2026-01-30')).toBe(35)
  expect(ageOn('1990-01-31', '2026-01-31')).toBe(36)
})

test('a Feb 29 birthday is reached on Mar 1 in a non-leap year, and on Feb 29 in a leap year', () => {
  expect(ageOn('2008-02-29', '2026-02-28')).toBe(17)
  expect(ageOn('2008-02-29', '2026-03-01')).toBe(18)
  expect(ageOn('2008-02-29', '2028-02-29')).toBe(20)
})

test('minor means under 18 — 17 years 364 days is a minor, 18 is an adult', () => {
  expect(isMinor('2008-11-06', '2026-11-05')).toBe(true) // 17y 364d
  expect(isMinor('2008-11-05', '2026-11-05')).toBe(false) // exactly 18
  expect(isMinor('2000-01-01', '2026-11-05')).toBe(false)
  expect(isMinor('2026-01-01', '2026-11-05')).toBe(true) // an infant
})

test('invalid, impossible or future dates give null instead of a wrong age', () => {
  expect(ageOn('2024-02-31', '2026-11-05')).toBeNull()
  expect(ageOn('not-a-date', '2026-11-05')).toBeNull()
  expect(ageOn('2008-13-01', '2026-11-05')).toBeNull()
  expect(ageOn('', '2026-11-05')).toBeNull()
  expect(ageOn(undefined, '2026-11-05')).toBeNull()
  expect(ageOn('2030-01-01', '2026-11-05')).toBeNull()
  expect(isMinor(null)).toBeNull()
  expect(isValidIsoDate('2024-02-29')).toBe(true)
  expect(isValidIsoDate('2023-02-29')).toBe(false)
})

test('"today" is the date in Puerto Rico, not in UTC (8 pm AST is already tomorrow in UTC)', () => {
  const eightPmAst = new Date('2026-11-06T00:00:00Z') // 20:00 on Nov 5 in Puerto Rico (UTC-4)
  expect(todayIn('America/Puerto_Rico', eightPmAst)).toBe('2026-11-05')
  expect(todayIn('UTC', eightPmAst)).toBe('2026-11-06')
  // so someone turning 18 on Nov 6 is still a minor at 8 pm on Nov 5, local time
  expect(isMinor('2008-11-06', todayIn('America/Puerto_Rico', eightPmAst))).toBe(true)
})

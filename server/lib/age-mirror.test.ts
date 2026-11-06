import * as web from '../../src/lib/age'
import * as server from './age'

const cases: [string, string][] = [
  ['2010-06-01', '2026-11-05'], ['2008-11-05', '2026-11-05'], ['2008-11-06', '2026-11-05'], ['2000-02-29', '2026-02-28'],
  ['2000-02-29', '2026-03-01'], ['2030-01-01', '2026-11-05'], ['2024-02-31', '2026-11-05'], ['nope', '2026-11-05'],
]

test('the web copy of the age rules agrees with the server on every case', () => {
  for (const [dob, today] of cases) {
    expect(web.ageOn(dob, today), `${dob} on ${today}`).toBe(server.ageOn(dob, today))
    expect(web.isMinor(dob, today), `${dob} on ${today}`).toBe(server.isMinor(dob, today))
  }
  expect(web.ADULT_AGE).toBe(server.ADULT_AGE)
  expect(web.isValidIsoDate('2026-02-30')).toBe(server.isValidIsoDate('2026-02-30'))
  expect(web.todayInPractice(new Date('2026-11-06T02:00:00Z'))).toBe(server.todayIn(undefined, new Date('2026-11-06T02:00:00Z')))
})

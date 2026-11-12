import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MSE_DOMAINS, PROTECTIVE_FACTORS, RISK_ACTIONS, RISK_FACTORS, RISK_HARM_OTHERS, RISK_LEVELS, RISK_SELF_HARM, RISK_SUICIDAL } from './clinical-vocab'
import { INTAKE_TEXT_KEYS, LABELS_ES, intakeChangedFields, intakeMissingForSign, isIntakeForm } from './intake-form'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('the web copy of the intake form is identical to the server file (below its banner)', () => {
  const server = read('./intake-form.ts')
  const web = read('../../src/lib/intake-form.ts')
  expect(web.endsWith(server)).toBe(true)
  const banner = web.slice(0, web.length - server.length)
  expect(banner).toMatch(/^\/\/ Web copy of server\/lib\/intake-form\.ts/)
  expect(banner.split('\n').length).toBeLessThanOrEqual(4)
})

test('every option of the mental status exam and the risk assessment has a Spanish label', () => {
  const keys = [
    ...Object.keys(MSE_DOMAINS), ...Object.values(MSE_DOMAINS).flat(),
    ...RISK_SUICIDAL, ...RISK_SELF_HARM, ...RISK_HARM_OTHERS, ...RISK_LEVELS, ...RISK_FACTORS, ...PROTECTIVE_FACTORS, ...RISK_ACTIONS,
  ]
  expect(keys.filter((k) => !LABELS_ES[k])).toEqual([])
})

test('sign rule, form detection and the changed-field names', () => {
  expect(intakeMissingForSign({})).toEqual(['presenting_problem'])
  expect(intakeMissingForSign({ texts: { presenting_problem: '  ' } })).toEqual(['presenting_problem'])
  expect(intakeMissingForSign({ texts: { presenting_problem: 'x' } })).toEqual([])
  expect(isIntakeForm({ session_type: 'intake', intake: { version: 1 } })).toBe(true)
  expect(isIntakeForm({ session_type: 'intake', intake: {} })).toBe(false)
  expect(isIntakeForm({ session_type: 'individual', intake: { version: 1 } })).toBe(false)
  expect(intakeChangedFields({ texts: { presenting_problem: 'a' } }, { texts: { presenting_problem: 'a', goals_long: 'b' }, functioning: { sleep: { marked: true, text: '' } } }).sort())
    .toEqual(['functioning.sleep', 'texts.goals_long'])
  expect(intakeChangedFields({}, { texts: { goals_long: '' } })).toEqual([])
  expect(INTAKE_TEXT_KEYS).toContain('presenting_problem')
})

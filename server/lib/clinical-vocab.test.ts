import {
  type RiskFields, ELEVATED_LEVELS, INTERVENTIONS, LABELS, MODALITIES, MSE_DOMAINS, MSE_DOMAIN_KEYS, MSE_DOMAIN_LABELS,
  PROTECTIVE_FACTORS, RISK_ACTIONS, RISK_FACTORS, RISK_HARM_OTHERS, RISK_LEVELS, RISK_SELF_HARM, RISK_SUICIDAL, SESSION_TYPES,
  hasPositiveRisk, label, mseIssues, validateRiskForSign,
} from './clinical-vocab'

const complete: RiskFields = {
  risk_suicidal: 'denied', risk_self_harm: 'denied', risk_harm_others: 'denied', risk_level: 'low', risk_actions: ['none'], risk_notes: null,
}
const check = (over: Partial<RiskFields>) => validateRiskForSign({ ...complete, ...over })

test('a fully denied, low-risk assessment can be signed with no rationale', () => {
  expect(check({})).toEqual({ ok: true, missing: [] })
  expect(check({ risk_actions: [] })).toEqual({ ok: true, missing: [] })
  expect(check({ risk_self_harm: 'history' })).toEqual({ ok: true, missing: [] }) // a past fact alone is not a positive screen
})

test('every dimension and the overall level are mandatory — there is no "not assessed"', () => {
  const none = validateRiskForSign({ risk_suicidal: null, risk_self_harm: null, risk_harm_others: null, risk_level: null, risk_actions: null, risk_notes: null })
  expect(none.ok).toBe(false)
  expect(none.missing).toEqual(['risk_suicidal', 'risk_self_harm', 'risk_harm_others', 'risk_level'])
  expect(check({ risk_suicidal: '' }).missing).toEqual(['risk_suicidal'])
  expect(check({ risk_level: '   ' }).missing).toEqual(['risk_level'])
})

test('an elevated level needs a written rationale AND a real action ("none" does not count)', () => {
  for (const level of ELEVATED_LEVELS) {
    expect(check({ risk_level: level, risk_actions: ['none'] }).missing).toEqual(['risk_notes', 'risk_actions'])
    expect(check({ risk_level: level, risk_notes: 'Reviewed safety plan', risk_actions: [] }).missing).toEqual(['risk_actions'])
    expect(check({ risk_level: level, risk_notes: '  ', risk_actions: ['safety_plan_reviewed'] }).missing).toEqual(['risk_notes'])
    expect(check({ risk_level: level, risk_notes: 'Reviewed safety plan', risk_actions: ['safety_plan_reviewed'] }).ok).toBe(true)
  }
})

test('"low" with any positive dimension needs a rationale', () => {
  expect(check({ risk_suicidal: 'passive' }).missing).toEqual(['risk_notes'])
  expect(check({ risk_harm_others: 'ideation' }).missing).toEqual(['risk_notes'])
  expect(check({ risk_self_harm: 'urges' }).missing).toEqual(['risk_notes'])
  expect(check({ risk_suicidal: 'passive', risk_notes: 'Fleeting thoughts, no plan, contracted for safety' }).ok).toBe(true)
})

test('"none" together with a real action is contradictory', () => {
  expect(check({ risk_actions: ['none', 'crisis_line_provided'] }).missing).toEqual(['risk_actions'])
  expect(check({ risk_level: 'moderate', risk_notes: 'x', risk_actions: ['none', 'consultation'] }).ok).toBe(false)
})

test('hasPositiveRisk matches the SQL CHECK: only a clear denial (or a past self-harm history) is not positive', () => {
  expect(hasPositiveRisk({ risk_suicidal: 'denied', risk_self_harm: 'denied', risk_harm_others: 'denied' })).toBe(false)
  expect(hasPositiveRisk({ risk_suicidal: 'denied', risk_self_harm: 'history', risk_harm_others: 'denied' })).toBe(false)
  for (const sh of RISK_SELF_HARM.filter((v) => v !== 'denied' && v !== 'history')) {
    expect(hasPositiveRisk({ risk_suicidal: 'denied', risk_self_harm: sh, risk_harm_others: 'denied' })).toBe(true)
  }
  expect(hasPositiveRisk({ risk_suicidal: null, risk_self_harm: 'denied', risk_harm_others: 'denied' })).toBe(true) // unknown is not a denial
})

test('MSE validation accepts the vocabulary and rejects anything else', () => {
  expect(mseIssues({})).toEqual([])
  expect(mseIssues({ mood_reported: 'I feel stuck', affect: { values: ['restricted', 'flat'], note: 'little range' }, insight: { values: ['fair'] } })).toEqual([])
  expect(mseIssues({ affect: { values: ['ecstatic'] } })).toEqual(['affect: unknown value ecstatic'])
  expect(mseIssues({ mystery: { values: [] } })).toEqual(['unknown mse domain: mystery'])
  expect(mseIssues({ affect: ['flat'] })).toEqual(['affect: values must be a list'])
  expect(mseIssues({ mood_reported: 'x'.repeat(501) })).toHaveLength(1)
  expect(mseIssues(null)).toEqual(['mse must be an object'])
  expect(mseIssues([])).toEqual(['mse must be an object'])
})

test('vocabulary hygiene: no duplicates, no empties, every domain labelled, "none" is a risk action', () => {
  const sets: Record<string, readonly string[]> = {
    MODALITIES, SESSION_TYPES, RISK_SUICIDAL, RISK_SELF_HARM, RISK_HARM_OTHERS, RISK_LEVELS, RISK_FACTORS, PROTECTIVE_FACTORS, RISK_ACTIONS, INTERVENTIONS,
    ...Object.fromEntries(MSE_DOMAIN_KEYS.map((k) => [`MSE.${k}`, MSE_DOMAINS[k]])),
  }
  for (const [name, values] of Object.entries(sets)) {
    expect(values.length, name).toBeGreaterThan(0)
    expect(new Set(values).size, `${name} has duplicates`).toBe(values.length)
  }
  expect(Object.keys(MSE_DOMAIN_LABELS).sort()).toEqual([...MSE_DOMAIN_KEYS].sort())
  expect(RISK_ACTIONS[0]).toBe('none')
  for (const k of ['denied']) expect([RISK_SUICIDAL[0], RISK_SELF_HARM[0], RISK_HARM_OTHERS[0]]).toContain(k) // explicit denial is the first choice
})

test('labels: acronyms are right, everything else is humanized', () => {
  expect(label('cbt')).toBe('CBT')
  expect(label('oriented_x4')).toBe('Oriented ×4')
  expect(label('safety_plan_reviewed')).toBe('Safety plan reviewed')
  expect(label('well_groomed')).toBe('Well groomed')
  expect(LABELS.risk_level).toBe('Overall risk level')
})

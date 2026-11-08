import type { SessionNote } from '../../src/lib/api'
import {
  applyNormalMse, changedInput, emptyForm, formFromNote, formToInput, formatLockRemaining, formatSessionDate, lockTone, mseSummary,
  reviewChecklist, riskStatus, riskStyle, todayInPractice,
} from '../../src/features/session-notes/note-utils'

const H = 3_600_000

test('lock countdown wording and tone', () => {
  expect(formatLockRemaining(2 * 24 * H + 14 * H + 5 * 60_000)).toBe('2d 14h left')
  expect(formatLockRemaining(5 * H + 20 * 60_000)).toBe('5h 20m left')
  expect(formatLockRemaining(42 * 60_000)).toBe('42m left')
  expect(formatLockRemaining(10_000)).toBe('1m left') // never "0m left" while still open
  expect(formatLockRemaining(0)).toBe('Locked')
  expect(formatLockRemaining(-5)).toBe('Locked')
  expect(lockTone(30 * H)).toBe('open')
  expect(lockTone(23 * H)).toBe('soon')
  expect(lockTone(24 * H)).toBe('open')
  expect(lockTone(0)).toBe('locked')
})

test('a session date shows the same calendar day whatever the browser timezone', () => {
  expect(formatSessionDate('2026-11-05')).toBe('Thu, Nov 5, 2026')
  expect(formatSessionDate('2026-01-01')).toBe('Thu, Jan 1, 2026')
  expect(formatSessionDate('2026-11-05T00:00:00.000Z')).toBe('Thu, Nov 5, 2026') // only the date part is used
  expect(formatSessionDate('garbage')).toBe('garbage')
  // 8 pm in Puerto Rico is already tomorrow in UTC: "today" must follow the practice
  expect(todayInPractice(new Date('2026-11-06T00:00:00Z'))).toBe('2026-11-05')
})

test('a new note form pre-fills NOTHING about risk', () => {
  const f = emptyForm('2026-11-05')
  expect([f.riskSuicidal, f.riskSelfHarm, f.riskHarmOthers, f.riskLevel]).toEqual([null, null, null, null])
  expect(f.riskActions).toEqual([])
  expect(riskStatus(f)).toMatchObject({ complete: false, missing: ['risk_suicidal', 'risk_self_harm', 'risk_harm_others', 'risk_level'], elevated: false })
})

test('riskStatus follows the same rules as the server and the database', () => {
  const f = emptyForm('2026-11-05', { riskSuicidal: 'denied', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'low' })
  expect(riskStatus(f)).toMatchObject({ complete: true, anyPositive: false })
  expect(riskStatus({ ...f, riskSuicidal: 'passive' })).toMatchObject({ complete: false, missing: ['risk_notes'], anyPositive: true })
  const moderate = { ...f, riskLevel: 'moderate' }
  expect(riskStatus(moderate)).toMatchObject({ complete: false, elevated: true, missing: ['risk_notes', 'risk_actions'] })
  expect(riskStatus({ ...moderate, riskNotes: 'Reviewed', riskActions: ['safety_plan_reviewed'] }).complete).toBe(true)
  expect(riskStatus({ ...f, riskSelfHarm: 'history' }).anyPositive).toBe(false)
})

test('the review checklist separates what blocks signing from what only reminds', () => {
  const f = emptyForm('2026-11-05')
  const items = reviewChecklist(f)
  expect(items.filter((i) => i.level === 'blocker')).toHaveLength(4)
  expect(items.filter((i) => i.level === 'warning').map((i) => i.text)).toEqual([
    'The Data section is empty', 'The Assessment is empty', 'The Plan is empty', 'No mood rating recorded',
  ])
  const done = { ...f, riskSuicidal: 'denied', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'low', dataSubjective: 'x', assessment: 'y', plan: 'z', moodRating: 6 }
  expect(reviewChecklist(done)).toEqual([])
})

test('form <-> API: blank text becomes null, empty MSE domains are dropped, codes are split, and the round trip is stable', () => {
  const f = emptyForm('2026-11-05', {
    startTime: '14:00', durationMin: '', moodReported: ' I feel stuck ', dataSubjective: '   ', assessment: 'Improving', diagnosisCodes: 'F41.1, F32.A  Z63.0',
    mse: { affect: { values: ['restricted'], note: ' little range ' }, speech: { values: [], note: '' }, insight: { values: ['fair'], note: '' } },
    riskSuicidal: 'denied', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'low',
  })
  const input = formToInput(f)
  expect(input).toMatchObject({ startTime: '14:00', durationMin: null, dataSubjective: null, assessment: 'Improving', riskNotes: null, diagnosisCodes: ['F41.1', 'F32.A', 'Z63.0'] })
  expect(input.mse).toEqual({ mood_reported: 'I feel stuck', affect: { values: ['restricted'], note: 'little range' }, insight: { values: ['fair'] } })

  const note = {
    session_date: '2026-11-05', start_time: '14:00:00', duration_min: null, modality: 'in_person', session_type: 'individual', appointment_id: null,
    mse: input.mse, mood_rating: null, risk_suicidal: 'denied', risk_self_harm: 'denied', risk_harm_others: 'denied', risk_level: 'low',
    risk_factors: [], protective_factors: [], risk_actions: [], risk_notes: null, data_subjective: null, data_objective: null, assessment: 'Improving', plan: null,
    interventions: [], diagnosis_codes: ['F41.1', 'F32.A', 'Z63.0'],
  } as unknown as SessionNote
  const back = formFromNote(note)
  expect(back.startTime).toBe('14:00')
  expect(back.moodReported).toBe('I feel stuck')
  expect(back.mse.affect).toEqual({ values: ['restricted'], note: 'little range' })
  expect(formToInput(back)).toEqual(input)
})

test('changedInput sends only what changed (autosave)', () => {
  const a = formToInput(emptyForm('2026-11-05'))
  const b = formToInput(emptyForm('2026-11-05', { assessment: 'x', riskLevel: 'low' }))
  expect(changedInput(a, a)).toEqual({})
  expect(changedInput(a, b)).toEqual({ assessment: 'x', riskLevel: 'low' })
})

test('"within normal limits" fills only the empty domains and never overwrites what was chosen', () => {
  const out = applyNormalMse({ affect: { values: ['flat'], note: 'blunted today' }, speech: { values: [], note: 'note kept' } })
  expect(out.affect).toEqual({ values: ['flat'], note: 'blunted today' }) // untouched
  expect(out.speech).toEqual({ values: ['normal'], note: 'note kept' }) // empty domain filled, its note preserved
  expect(out.cognition?.values).toEqual(['oriented_x4'])
})

test('the MSE recap and risk styling', () => {
  const f = emptyForm('2026-11-05', { moodRating: 4, riskLevel: 'moderate', mse: { affect: { values: ['restricted', 'flat'], note: '' }, judgment: { values: ['fair'], note: '' } } })
  expect(mseSummary(f)).toBe('Mood 4/10 · Affect: Restricted, Flat · Judgment: Fair · Risk: Moderate')
  expect(mseSummary(emptyForm('2026-11-05'))).toBe('Risk: Not assessed')
  expect(riskStyle('imminent').badge).toContain('bg-rose-600')
  expect(riskStyle(null).label).toBe('Not assessed')
})

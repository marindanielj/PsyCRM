import { emptyForm, formFromNote, formToInput, intakeToInput, usesIntakeForm } from '../../src/features/session-notes/note-utils'
import type { SessionNote } from '../../src/lib/api'

const note = (over: Partial<SessionNote>): SessionNote => ({
  id: 'n1', contact_id: 'c1', appointment_id: null, session_date: '2026-11-05', start_time: null, duration_min: 50, modality: 'in_person',
  session_type: 'intake', data_subjective: null, data_objective: null, assessment: null, plan: null, mse: {}, mood_rating: null,
  risk_suicidal: null, risk_self_harm: null, risk_harm_others: null, risk_level: null, risk_factors: [], protective_factors: [], risk_actions: [],
  risk_notes: null, interventions: [], diagnosis_codes: [], intake: {}, status: 'draft', signed_at: null, signed_by: null, signed_late: false,
  created_by: 'op1', created_at: '', updated_at: '', locks_at: '', deleted_at: null, lock: { locked: false, locksAt: '', msRemaining: 1 },
  ...over,
})

test('the editor uses the intake form for a new intake and for an intake-form note, never for an older DAP intake', () => {
  expect(usesIntakeForm(emptyForm('2026-11-05', { sessionType: 'intake' }))).toBe(true)
  expect(usesIntakeForm(emptyForm('2026-11-05'))).toBe(false)
  expect(usesIntakeForm(formFromNote(note({ intake: { version: 1 } })))).toBe(true)
  expect(usesIntakeForm(formFromNote(note({ intake: {} })))).toBe(false) // written as DAP before the form existed
  // an individual note that becomes an intake gets the form
  const f = formFromNote(note({ session_type: 'individual' }))
  expect(usesIntakeForm({ ...f, sessionType: 'intake' })).toBe(true)
})

test('the form is sent without empty parts and never with a version; other notes do not send it', () => {
  expect(intakeToInput({
    version: 1,
    texts: { presenting_problem: 'Ansiedad', goals_short: '  ' },
    functioning: { sleep: { marked: true, text: '' }, energy: { marked: false, text: '' } },
    telehealth: { location: '', in_pr: null, private_setting: null },
  })).toEqual({ texts: { presenting_problem: 'Ansiedad' }, functioning: { sleep: { marked: true, text: '' } } })
  const intake = emptyForm('2026-11-05', { sessionType: 'intake', intake: { texts: { presenting_problem: 'x' } } })
  expect(formToInput(intake).intake).toEqual({ texts: { presenting_problem: 'x' } })
  expect('intake' in formToInput({ ...intake, sessionType: 'individual' })).toBe(false)
})

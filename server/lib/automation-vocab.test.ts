import { ACTION_LABELS, ACTION_TYPES, TRIGGER_LABELS, TRIGGER_TYPES, matchesTriggerConfig } from './automation-vocab'

test('trigger_link_clicked is part of the closed trigger set and has a label', () => {
  // Trigger Links (slice 14) start automations: a click on an attributed link
  // fires this trigger. It must stay in the closed set so the workflows route
  // (z.enum(TRIGGER_TYPES)) accepts it and the builder lists it. The web mirror
  // in src/features/automations/automation-meta.ts must match this set.
  expect(TRIGGER_TYPES).toContain('trigger_link_clicked')
  expect(TRIGGER_LABELS.trigger_link_clicked).toBe('Trigger link clicked')
})

test('survey_submitted is part of the closed trigger set and has a label', () => {
  // Surveys (slice 15) start automations: completing a multi-step survey fires
  // this trigger so a finished survey can enroll the contact in a workflow. It
  // must stay in the closed set so the workflows route (z.enum(TRIGGER_TYPES))
  // accepts it and the builder lists it. The web mirror must match this set.
  expect(TRIGGER_TYPES).toContain('survey_submitted')
  expect(TRIGGER_LABELS.survey_submitted).toBe('Survey submitted')
})

test('proposal_signed is part of the closed trigger set and has a label', () => {
  // Proposals (slice 16) start automations: a recipient typing their name and
  // accepting a proposal on its public page fires this trigger, so an accepted
  // proposal can kick off onboarding/fulfilment. It must stay in the closed set
  // so the workflows route (z.enum(TRIGGER_TYPES)) accepts it and the builder
  // lists it. The web mirror in automation-meta.ts must match this set.
  expect(TRIGGER_TYPES).toContain('proposal_signed')
  expect(TRIGGER_LABELS.proposal_signed).toBe('Proposal signed')
})

test('every trigger type has exactly one label (no gaps, no orphans)', () => {
  expect(Object.keys(TRIGGER_LABELS).sort()).toEqual([...TRIGGER_TYPES].sort())
})

test('every action type has exactly one label, and the day-7 actions exist', () => {
  expect(Object.keys(ACTION_LABELS).sort()).toEqual([...ACTION_TYPES].sort())
  for (const a of ['move_to_stage', 'send_document_packet', 'create_task']) expect(ACTION_TYPES).toContain(a)
  for (const t of ['documents_completed', 'document_signed', 'appointment_checked_in', 'session_note_signed', 'pipeline_stage_changed']) expect(TRIGGER_TYPES).toContain(t)
})

test('a trigger filter must match the payload; an empty filter lets everything through', () => {
  expect(matchesTriggerConfig({}, { a: 1 })).toBe(true)
  expect(matchesTriggerConfig(undefined, undefined)).toBe(true)
  expect(matchesTriggerConfig({ packetId: 'p1' }, { packetId: 'p1', other: 'x' })).toBe(true)
  expect(matchesTriggerConfig({ packetId: 'p1' }, { packetId: 'p2' })).toBe(false)
  expect(matchesTriggerConfig({ packetId: 'p1' }, {})).toBe(false)
  expect(matchesTriggerConfig({ packetId: 'p1' }, undefined)).toBe(false)
  expect(matchesTriggerConfig({ pipelineId: 'a', toStageId: 'b' }, { pipelineId: 'a', toStageId: 'c' })).toBe(false)
  // blank values are "no filter" (a half-filled form)
  expect(matchesTriggerConfig({ packetId: '', calendarId: null }, {})).toBe(true)
})

test('"first signed note only" filters on isFirst; switched off it filters nothing', () => {
  expect(matchesTriggerConfig({ firstOnly: true }, { isFirst: true })).toBe(true)
  expect(matchesTriggerConfig({ firstOnly: true }, { isFirst: false })).toBe(false)
  expect(matchesTriggerConfig({ firstOnly: true }, {})).toBe(false)
  expect(matchesTriggerConfig({ firstOnly: false }, { isFirst: false })).toBe(true)
  expect(matchesTriggerConfig({ firstOnly: false }, { isFirst: true })).toBe(true)
})

test('a boolean filter treats an absent flag as false (skipOnboarding)', () => {
  expect(matchesTriggerConfig({ skipOnboarding: false }, {})).toBe(true)
  expect(matchesTriggerConfig({ skipOnboarding: false }, { skipOnboarding: false })).toBe(true)
  expect(matchesTriggerConfig({ skipOnboarding: false }, { skipOnboarding: true })).toBe(false)
})

test('the web builder offers exactly the server\'s triggers, and every action except texting', async () => {
  const { TRIGGERS, ACTIONS } = await import('../../src/features/automations/automation-meta')
  expect([...TRIGGERS].sort()).toEqual([...TRIGGER_TYPES].sort())
  expect([...ACTIONS].sort()).toEqual(ACTION_TYPES.filter((a) => a !== 'send_sms').sort())
})

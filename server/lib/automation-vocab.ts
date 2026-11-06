// Shared automation vocabulary: the closed set of triggers that can start a
// workflow and the actions a step can take. Kept as plain string unions (not a
// DB enum) so the vocab can grow without a migration; the route validates
// against these arrays with Zod and the web UI mirrors the labels.

export const TRIGGER_TYPES = [
  'contact_created',
  'inbound_message',
  'appointment_booked',
  'opportunity_created',
  'trigger_link_clicked',
  'survey_submitted',
  'proposal_signed',
  'pipeline_stage_changed',
  'session_note_signed',
  'appointment_checked_in',
  'documents_completed',
  'document_signed',
] as const

export const ACTION_TYPES = ['send_sms', 'send_email', 'add_tag', 'wait', 'move_to_stage', 'send_document_packet', 'create_task'] as const

export type TriggerType = (typeof TRIGGER_TYPES)[number]
export type ActionType = (typeof ACTION_TYPES)[number]

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  contact_created: 'New contact created',
  inbound_message: 'Inbound message received',
  appointment_booked: 'Appointment booked',
  opportunity_created: 'Opportunity created',
  trigger_link_clicked: 'Trigger link clicked',
  survey_submitted: 'Survey submitted',
  proposal_signed: 'Proposal signed',
  pipeline_stage_changed: 'Pipeline stage changed',
  session_note_signed: 'Session note signed',
  appointment_checked_in: 'Client checked in',
  documents_completed: 'Onboarding documents completed',
  document_signed: 'Document signed',
}

export const ACTION_LABELS: Record<ActionType, string> = {
  send_sms: 'Send SMS',
  send_email: 'Send email',
  add_tag: 'Add tag',
  wait: 'Wait',
  move_to_stage: 'Move to pipeline stage',
  send_document_packet: 'Send document packet',
  create_task: 'Create task',
}

/**
 * What an event carries, so a workflow can react to "which stage", "which packet",
 * "the first signed note". Plain, non-clinical facts: ids, flags, an origin.
 */
export type EventPayload = Record<string, unknown>

/** A trigger-config key that is named differently in the payload. */
const CONFIG_ALIASES: Record<string, string> = { firstOnly: 'isFirst' }
/** A flag that only filters when it is switched ON ("first signed note only"). */
const ONLY_WHEN_TRUE = new Set(['firstOnly'])

/**
 * Does an event's payload satisfy a workflow's trigger filter? Every key in the config
 * must match the payload; an empty config lets everything through. Blank values mean
 * "no filter". A boolean filter compares with `=== true`, so an absent flag counts as
 * false (`{ skipOnboarding: false }` passes unless the payload says it is true).
 */
export function matchesTriggerConfig(config: Record<string, unknown> | null | undefined, payload: EventPayload | null | undefined): boolean {
  for (const [key, want] of Object.entries(config ?? {})) {
    if (want === undefined || want === null || want === '') continue
    const actual = payload?.[CONFIG_ALIASES[key] ?? key]
    if (typeof want === 'boolean') {
      if (!want && ONLY_WHEN_TRUE.has(key)) continue
      if ((actual === true) !== want) return false
      continue
    }
    if (actual !== want) return false
  }
  return true
}

/** How many workflow-caused events may chain before the dispatcher stops them. */
export const MAX_EVENT_DEPTH = 3

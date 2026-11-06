import type { Database } from '../db/database'
import { WorkflowActionsRepo } from '../repos/workflow-actions-repo'
import { type WorkflowActionInput, WorkflowsRepo } from '../repos/workflows-repo'
import type { TriggerType } from './automation-vocab'
import { seedFamilyId } from './document-seed'
import { SEED_PACKETS } from './document-seed-content'

export interface OnboardingIds {
  pipelineId: string
  stages: Record<string, string>
}

interface Starter {
  name: string
  triggerType: TriggerType
  triggerConfig: Record<string, unknown>
  actions: WorkflowActionInput[]
}

/** The four workflows that move a new client through the Onboarding pipeline by themselves. */
export function onboardingStarters(ids: OnboardingIds, adultPacketId: string, adolescentPacketId: string): Starter[] {
  const move = (stage: string, extra: Record<string, unknown> = {}): WorkflowActionInput => ({
    type: 'move_to_stage',
    config: { pipelineId: ids.pipelineId, stageId: ids.stages[stage], createIfMissing: true, onlyForward: true, ...extra },
  })
  return [
    {
      name: 'Onboarding: new client',
      triggerType: 'contact_created',
      // "Send onboarding packet now" unticked in Add contact sets skipOnboarding.
      triggerConfig: { skipOnboarding: false },
      actions: [
        move('new'),
        // An adult gets the adult packet; a minor gets the adolescent packet, sent to the guardian recorded at registration.
        { type: 'send_document_packet', config: { packetId: adultPacketId, adolescentPacketId } },
        // Only if the packet really went out: a minor or a client with no date of birth stays at "New contact".
        move('sent', { requirePreviousDone: true }),
      ],
    },
    {
      name: 'Onboarding: documents signed',
      triggerType: 'documents_completed',
      triggerConfig: {},
      actions: [move('signed'), { type: 'create_task', config: { title: 'Schedule first appointment with {{contact.first_name}}', dueInDays: 2 } }],
    },
    { name: 'Onboarding: first appointment', triggerType: 'appointment_booked', triggerConfig: {}, actions: [move('booked')] },
    { name: 'Onboarding: active client', triggerType: 'session_note_signed', triggerConfig: { firstOnly: true }, actions: [move('active')] },
  ]
}

/**
 * Create the onboarding workflows for a practice (idempotent by name: an existing workflow, edited
 * or not, is never touched). They go live only when every document of the adult packet is in force;
 * until then they are drafts, and the therapist turns them on in Automations once her documents are ready.
 */
export async function seedOnboardingWorkflows(db: Database, locationId: string, ids: OnboardingIds): Promise<{ created: number; live: boolean }> {
  const adult = SEED_PACKETS.find((p) => p.audience === 'adult')!
  const packetId = `seed_packet_${adult.slug}_${locationId}`
  const teen = SEED_PACKETS.find((p) => p.audience === 'adolescent')!
  const families = adult.slugs.map(seedFamilyId)
  const active = await db.query<{ family_id: string }>(
    `SELECT family_id FROM document_templates WHERE location_id = $1 AND status = 'active' AND family_id = ANY($2::text[])`,
    [locationId, families],
  )
  const live = families.every((f) => active.some((a) => a.family_id === f))

  const workflows = new WorkflowsRepo(db, locationId)
  const actions = new WorkflowActionsRepo(db, locationId)
  let created = 0
  for (const w of onboardingStarters(ids, packetId, `seed_packet_${teen.slug}_${locationId}`)) {
    const exists = await db.query('SELECT 1 FROM workflows WHERE location_id = $1 AND name = $2', [locationId, w.name])
    if (exists.length > 0) continue
    const wf = await workflows.create({ name: w.name, triggerType: w.triggerType, triggerConfig: w.triggerConfig })
    await actions.replaceAll(wf.id, w.actions)
    if (live) await workflows.update(wf.id, { status: 'live' })
    created++
  }
  return { created, live }
}

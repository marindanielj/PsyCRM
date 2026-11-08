import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { OpportunitiesRepo } from '../repos/opportunities-repo'
import { PipelinesRepo } from '../repos/pipelines-repo'
import { type AuditEntry, audit } from './audit'
import { moveOpportunityToStage } from './pipeline-moves'

/** What an automation step did, in the words the run log shows. */
export interface StepOutcome {
  status: 'done' | 'skipped' | 'failed'
  detail: string
}

type AuditCtx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

/**
 * Move a client's card to a stage of a pipeline — the body of the `move_to_stage` step.
 * Finds the client's OPEN card there (creating it on the first stage if asked), then moves
 * it through the same function the board uses, so the audit entry and the client's timeline
 * look identical to a hand move. With `onlyForward`, a card already at or past the target is
 * left alone: an automation never drags someone backwards.
 */
export async function moveContactToStage(
  db: Database,
  locationId: string,
  input: {
    contactId: string
    contactName: string
    pipelineId: string
    stageId: string
    createIfMissing: boolean
    onlyForward: boolean
    audit: AuditCtx
    dispatch?: WorkflowDispatch
    /** Hops of automation that led to this step (the moves it makes carry depth + 1). */
    depth: number
  },
): Promise<StepOutcome> {
  const pipelines = new PipelinesRepo(db, locationId)
  const target = await pipelines.getStage(input.stageId)
  if (!target || target.pipeline_id !== input.pipelineId) return { status: 'failed', detail: 'The stage no longer exists in that pipeline' }

  const opportunities = new OpportunitiesRepo(db, locationId)
  let card = await opportunities.findOpenByContact(input.contactId, input.pipelineId)
  let created = false
  if (!card) {
    if (!input.createIfMissing) return { status: 'skipped', detail: 'The client has no open card in this pipeline' }
    const stages = await pipelines.listStages(input.pipelineId)
    const first = stages[0]
    if (!first) return { status: 'failed', detail: 'The pipeline has no stages' }
    card = await db.transaction(async (tx) => {
      const c = await new OpportunitiesRepo(tx, locationId).create({ pipelineId: input.pipelineId, stageId: first.id, name: input.contactName, contactId: input.contactId, source: 'workflow' })
      await audit(tx, locationId, { action: 'opportunity.created', entityType: 'opportunity', entityId: c.id, contactId: input.contactId, details: { pipelineId: input.pipelineId, stageId: first.id, via: 'workflow' }, ...input.audit })
      return c
    })
    created = true
  } else if (input.onlyForward) {
    const current = await pipelines.getStage(card.stage_id)
    if (current && target.position <= current.position) {
      return { status: 'skipped', detail: target.position === current.position ? `Already in "${target.name}"` : `Already further along ("${current.name}")` }
    }
  }

  const moved = await moveOpportunityToStage(db, locationId, {
    opportunityId: card.id,
    stageId: target.id,
    origin: 'workflow',
    audit: input.audit,
    dispatch: input.dispatch,
    depth: input.depth + 1,
  })
  if (!moved.ok) return { status: 'failed', detail: moved.error }
  if (!moved.changed) return { status: created ? 'done' : 'skipped', detail: created ? `Created the card in "${target.name}"` : `Already in "${target.name}"` }
  return { status: 'done', detail: `${created ? 'Created the card and moved' : 'Moved'} to "${target.name}"` }
}

/** Add an open task for a client unless one with the same title is already open. Returns whether it was created. */
export async function createTaskOnce(
  db: Database,
  locationId: string,
  input: { contactId: string; title: string; body?: string | null; dueAt?: Date | null },
): Promise<boolean> {
  const dup = await db.query('SELECT 1 FROM contact_tasks WHERE location_id = $1 AND contact_id = $2 AND title = $3 AND completed_at IS NULL LIMIT 1', [locationId, input.contactId, input.title])
  if (dup.length > 0) return false
  await db.query('INSERT INTO contact_tasks (id, location_id, contact_id, title, body, due_at) VALUES ($1,$2,$3,$4,$5,$6)', [
    nanoid(), locationId, input.contactId, input.title, input.body ?? null, input.dueAt ? input.dueAt.toISOString() : null,
  ])
  return true
}

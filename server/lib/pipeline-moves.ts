import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { OpportunitiesRepo, type Opportunity } from '../repos/opportunities-repo'
import { PipelinesRepo } from '../repos/pipelines-repo'
import { TimelineRepo } from '../repos/timeline-repo'
import { type AuditEntry, audit } from './audit'

export type MoveOrigin = 'operator' | 'workflow'

export type MoveResult =
  | { ok: true; opportunity: Opportunity; changed: boolean }
  | { ok: false; status: 404 | 400; error: string }

/**
 * Move a pipeline card to another stage of ITS OWN pipeline. The one place a card
 * changes stage — the board's drag-and-drop, the assistant tool and (day 7) the
 * `move_to_stage` automation action all go through it, so every move is recorded
 * the same way:
 *
 *   - the move, the audit row (`pipeline.stage_changed`) and the client's timeline
 *     event commit together or not at all;
 *   - the `pipeline_stage_changed` workflow trigger fires only AFTER the commit, so
 *     an automation never reacts to a move that was rolled back.
 *
 * Moving a card to the stage it is already in is a no-op (nothing written, no
 * trigger), which also keeps an automation from looping on itself.
 */
export async function moveOpportunityToStage(
  db: Database,
  locationId: string,
  input: {
    opportunityId: string
    stageId: string
    origin: MoveOrigin
    audit: Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>
    dispatch?: WorkflowDispatch
  },
): Promise<MoveResult> {
  const result = await db.transaction(async (tx): Promise<MoveResult & { dispatchContactId?: string | null }> => {
    const opportunities = new OpportunitiesRepo(tx, locationId)
    const existing = await opportunities.get(input.opportunityId)
    if (!existing) return { ok: false, status: 404, error: 'not found' }

    // The card stays in its own pipeline: the target must be in this location AND
    // belong to the same pipeline (blocks a foreign id and a sideways move).
    const stage = await new PipelinesRepo(tx, locationId).getStage(input.stageId)
    if (!stage || stage.pipeline_id !== existing.pipeline_id) {
      return { ok: false, status: 400, error: 'unknown stage' }
    }
    if (existing.stage_id === input.stageId) return { ok: true, opportunity: existing, changed: false }

    const moved = await opportunities.move(input.opportunityId, input.stageId)
    if (!moved) return { ok: false, status: 404, error: 'not found' }

    const contactId = moved.contact_id ?? null
    if (contactId) {
      await new TimelineRepo(tx, locationId).add({
        contactId,
        type: 'stage_changed',
        refTable: 'opportunities',
        refId: moved.id,
        payload: { pipelineId: stage.pipeline_id, fromStageId: existing.stage_id, toStageId: stage.id, toStage: stage.name, origin: input.origin },
      })
    }
    await audit(tx, locationId, {
      action: 'pipeline.stage_changed',
      entityType: 'opportunity',
      entityId: moved.id,
      contactId,
      details: { pipelineId: stage.pipeline_id, fromStageId: existing.stage_id, toStageId: stage.id, toStage: stage.name, origin: input.origin },
      ...input.audit,
    })
    return { ok: true, opportunity: moved, changed: true, dispatchContactId: contactId }
  })

  if (result.ok && result.changed) {
    await input.dispatch?.({
      locationId,
      triggerType: 'pipeline_stage_changed',
      contactId: (result as { dispatchContactId?: string | null }).dispatchContactId ?? null,
    })
  }
  if (result.ok) return { ok: true, opportunity: result.opportunity, changed: result.changed }
  return result
}

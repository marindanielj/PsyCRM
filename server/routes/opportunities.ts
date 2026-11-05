import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { audit, auditContext } from '../lib/audit'
import { moveOpportunityToStage } from '../lib/pipeline-moves'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { OpportunitiesRepo } from '../repos/opportunities-repo'
import { PipelinesRepo } from '../repos/pipelines-repo'

const createSchema = z.object({
  pipelineId: z.string().min(1),
  stageId: z.string().min(1),
  name: z.string().min(1),
  contactId: z.string().nullable().optional(),
  valueCents: z.number().int().nonnegative().optional(),
  source: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
})

const patchSchema = z.object({
  stageId: z.string().min(1).optional(),
  status: z.enum(['open', 'won', 'lost', 'abandoned']).optional(),
  name: z.string().min(1).optional(),
  valueCents: z.number().int().nonnegative().optional(),
  contactId: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
})

/**
 * Opportunities + pipelines for the current location. Mounted behind
 * operatorAuth + locationAccess. The kanban board reads GET /pipelines (stages
 * nested) and GET /?pipelineId=; drag-drop PATCHes {stageId}; won/lost PATCHes
 * {status}. `/pipelines` is registered before `/:id` so it isn't matched as one.
 */
export function opportunitiesRoute(deps: {
  db: Database
  /** Fired after a new opportunity so live workflows can enroll the contact. */
  dispatch?: WorkflowDispatch
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/pipelines', async (c) => {
    const loc = c.get('locationId')
    const pipelines = await new PipelinesRepo(deps.db, loc).listWithStages()
    return c.json({ pipelines })
  })

  app.get('/', async (c) => {
    const loc = c.get('locationId')
    const pipelineId = c.req.query('pipelineId')
    if (!pipelineId) return c.json({ error: 'pipelineId is required' }, 400)
    const opportunities = await new OpportunitiesRepo(deps.db, loc).listByPipeline(pipelineId)
    return c.json({ opportunities })
  })

  app.post('/', zValidator('json', createSchema), async (c) => {
    const loc = c.get('locationId')
    const input = c.req.valid('json')
    // A new card may only reference a pipeline and stage that belong to this
    // location, and the stage must belong to that pipeline. Both lookups are
    // location-scoped, so a foreign id resolves to undefined and is rejected
    // rather than landing a card under another tenant's pipeline.
    const pipelines = new PipelinesRepo(deps.db, loc)
    const pipeline = await pipelines.get(input.pipelineId)
    const stage = await pipelines.getStage(input.stageId)
    if (!pipeline || !stage || stage.pipeline_id !== pipeline.id) {
      return c.json({ error: 'unknown pipeline or stage' }, 400)
    }
    const opportunity = await deps.db.transaction(async (tx) => {
      const created = await new OpportunitiesRepo(tx, loc).create(input)
      await audit(tx, loc, {
        action: 'opportunity.created',
        entityType: 'opportunity',
        entityId: created.id,
        contactId: created.contact_id ?? null,
        details: { pipelineId: input.pipelineId, stageId: input.stageId },
        ...auditContext(c),
      })
      return created
    })
    await deps.dispatch?.({
      locationId: loc,
      triggerType: 'opportunity_created',
      contactId: opportunity.contact_id ?? null,
    })
    return c.json({ ok: true, opportunity }, 201)
  })

  app.patch('/:id', zValidator('json', patchSchema), async (c) => {
    const loc = c.get('locationId')
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const repo = new OpportunitiesRepo(deps.db, loc)

    // One concern per call: move (drag-drop) > status (won/lost) > field edit.
    let opportunity
    if (body.stageId !== undefined) {
      const moved = await moveOpportunityToStage(deps.db, loc, {
        opportunityId: id,
        stageId: body.stageId,
        origin: 'operator',
        audit: auditContext(c),
        dispatch: deps.dispatch,
      })
      if (!moved.ok) return c.json({ error: moved.error }, moved.status)
      opportunity = moved.opportunity
    } else if (body.status !== undefined) {
      const status = body.status
      opportunity = await deps.db.transaction(async (tx) => {
        const updated = await new OpportunitiesRepo(tx, loc).setStatus(id, status)
        if (updated) {
          await audit(tx, loc, {
            action: 'opportunity.status_changed',
            entityType: 'opportunity',
            entityId: updated.id,
            contactId: updated.contact_id ?? null,
            details: { to: status },
            ...auditContext(c),
          })
        }
        return updated
      })
    } else {
      const patch = {
        name: body.name,
        valueCents: body.valueCents,
        contactId: body.contactId,
        source: body.source,
        assignee: body.assignee,
      }
      opportunity = await deps.db.transaction(async (tx) => {
        const updated = await new OpportunitiesRepo(tx, loc).update(id, patch)
        if (updated) {
          await audit(tx, loc, {
            action: 'opportunity.updated',
            entityType: 'opportunity',
            entityId: updated.id,
            contactId: updated.contact_id ?? null,
            details: { fields: Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => k) },
            ...auditContext(c),
          })
        }
        return updated
      })
    }
    if (!opportunity) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true, opportunity })
  })

  app.get('/:id', async (c) => {
    const loc = c.get('locationId')
    const opportunity = await new OpportunitiesRepo(deps.db, loc).get(c.req.param('id'))
    if (!opportunity) return c.json({ error: 'not found' }, 404)
    return c.json({ opportunity })
  })

  return app
}

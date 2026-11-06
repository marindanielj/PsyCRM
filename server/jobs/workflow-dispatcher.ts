import { audit } from '../lib/audit'
import { type EventPayload, MAX_EVENT_DEPTH, type TriggerType, matchesTriggerConfig } from '../lib/automation-vocab'
import type { WorkflowRun } from '../repos/workflow-runs-repo'
import { WorkflowsRepo } from '../repos/workflows-repo'
import { type WorkflowRunnerDeps, runWorkflow } from './workflow-runner'

/**
 * A real thing that happened in a location — a contact was created, a message
 * came in, an opportunity opened. The dispatcher turns it into workflow runs.
 */
export interface WorkflowEvent {
  locationId: string
  triggerType: TriggerType
  contactId: string | null
  /** Plain facts about what happened (ids, flags) — what a workflow's trigger filter reads. */
  payload?: EventPayload
  /** 0 for a human or client action; +1 for each hop an automation caused. */
  depth?: number
  /** Set when the event is queued: makes a retried job pick its runs back up instead of repeating them. */
  eventId?: string
}

/**
 * What a route calls when something happens that workflows can trigger on. In
 * prod this enqueues a `workflow.dispatch` pg-boss job (durable, off the request
 * path); in dev/tests it runs the dispatch in-process. Routes depend on this
 * shape, not on pg-boss, so they stay pure.
 */
export type WorkflowDispatch = (event: WorkflowEvent) => void | Promise<void>

/**
 * Fan one event out to every live workflow wired to that trigger, starting an
 * honest run for each. Draft workflows are ignored (only `status = 'live'`
 * fires). Returns the runs it started so callers/tests can inspect them; an
 * event with no matching live workflow is a no-op that returns `[]`.
 *
 * Runs are started sequentially to keep ordering deterministic and avoid a
 * thundering herd on the shared DB; each run is itself cheap (a handful of
 * scoped queries) and a `wait` step defers via the scheduler rather than
 * blocking here.
 */
export async function dispatchWorkflowEvent(
  deps: WorkflowRunnerDeps,
  event: WorkflowEvent,
): Promise<WorkflowRun[]> {
  // A chain of automations that keep triggering each other stops here, loudly.
  if ((event.depth ?? 0) > MAX_EVENT_DEPTH) {
    await audit(deps.db, event.locationId, {
      action: 'workflow.loop_prevented',
      entityType: 'workflow_event',
      contactId: event.contactId,
      details: { trigger: event.triggerType, depth: event.depth },
      actor: { type: 'system', label: 'Automation engine' },
    }).catch((err) => console.error('loop audit write failed', (err as { code?: string } | null)?.code ?? 'unknown'))
    return []
  }

  const live = await new WorkflowsRepo(deps.db, event.locationId).listLiveByTrigger(
    event.triggerType,
  )

  const runs: WorkflowRun[] = []
  for (const workflow of live) {
    if (!matchesTriggerConfig(workflow.trigger_config, event.payload)) continue
    runs.push(
      await runWorkflow(deps, {
        locationId: event.locationId,
        workflowId: workflow.id,
        contactId: event.contactId,
        triggerType: event.triggerType,
        event: { payload: event.payload ?? {}, depth: event.depth ?? 0 },
        // The same event + workflow always maps to the same run, so a retried job resumes it.
        runId: event.eventId ? `run_${event.eventId}_${workflow.id}` : undefined,
      }),
    )
  }
  return runs
}

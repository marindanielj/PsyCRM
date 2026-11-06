import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'
import { type Contact, ContactsRepo } from '../repos/contacts-repo'
import { CustomValuesRepo } from '../repos/custom-values-repo'
import { WorkflowActionsRepo } from '../repos/workflow-actions-repo'
import {
  type WorkflowRun,
  type WorkflowRunStep,
  WorkflowRunsRepo,
} from '../repos/workflow-runs-repo'
import { WorkflowsRepo } from '../repos/workflows-repo'
import { type ActionDeps, executeAction } from './workflow-actions'

export interface WorkflowRunPayload {
  locationId: string
  workflowId: string
  contactId: string | null
  triggerType: string
  /** What triggered it: the payload the actions can read and how many automation hops led here. */
  event?: { payload: Record<string, unknown>; depth: number }
  /** A deterministic run id (queued events): a retried job finds its run and carries on. */
  runId?: string
}

/** Defers the steps after a `wait`. The thunk returns the resume promise so a
 *  caller (a test, or a future pg-boss adapter) can await completion; the default
 *  uses setTimeout and ignores the promise (fire-and-forget). */
export type Scheduler = (thunk: () => Promise<unknown>, ms: number) => void

/**
 * setTimeout stores its delay in a 32-bit signed int. A value above this ceiling
 * (~24.8 days) silently clamps to 1ms and fires almost immediately — so a naive
 * `setTimeout(resume, waitMs({ days: 30 }))` would run the rest of a month-long
 * drip the instant it was scheduled. MAX_TIMEOUT_MS is that ceiling.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Split a delay into setTimeout-safe chunks. A short wait is returned as a single
 * chunk; a multi-week wait becomes several chunks each at or under the ceiling,
 * summing to the exact original duration so the scheduler can re-arm until the
 * full time elapses without losing or inventing time.
 */
export function timeoutChunks(ms: number): number[] {
  if (!(ms > 0)) return [0]
  const chunks: number[] = []
  let remaining = ms
  while (remaining > MAX_TIMEOUT_MS) {
    chunks.push(MAX_TIMEOUT_MS)
    remaining -= MAX_TIMEOUT_MS
  }
  chunks.push(remaining)
  return chunks
}

const defaultSchedule: Scheduler = (thunk, ms) => {
  const chunks = timeoutChunks(ms)
  const arm = (i: number) => {
    const t = setTimeout(() => {
      if (i + 1 < chunks.length) arm(i + 1)
      else void thunk()
    }, chunks[i] ?? 0)
    // Don't keep the dev process alive just for a pending wait.
    ;(t as { unref?: () => void }).unref?.()
  }
  arm(0)
}

export interface WorkflowRunnerDeps extends ActionDeps {
  db: Database
  schedule?: Scheduler
}

/** Translate a wait step's config into milliseconds. Sums any supported units;
 *  ignores zero/negative/non-numeric values so a delay is never negative. */
export function waitMs(config: Record<string, unknown>): number {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const secs = n(config.seconds) + n(config.minutes) * 60 + n(config.hours) * 3600 + n(config.days) * 86_400
  return secs * 1000
}

function describeWait(config: Record<string, unknown>): string {
  const units: [string, unknown][] = [
    ['day', config.days],
    ['hour', config.hours],
    ['minute', config.minutes],
    ['second', config.seconds],
  ]
  const parts = units
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([label, v]) => `${v as number} ${label}${(v as number) === 1 ? '' : 's'}`)
  return parts.length ? `Waiting ${parts.join(' ')}` : 'Waiting'
}

/**
 * Record a workflow event in the audit log WITHOUT letting a logging failure break
 * the run. The job queue retries a failed job, and a retry would repeat steps that
 * already had real effects (a tag added, an email sent). The run's own record
 * (workflow_runs.steps) is the durable execution log and is written regardless; the
 * effects that matter clinically (a stage change, an appointment) are audited
 * where they happen, in the same transaction as the change. So this is best-effort
 * by design — the failure is reported by code only, never with client data.
 */
async function auditRun(
  db: Database,
  locationId: string,
  entry: Pick<AuditEntry, 'action' | 'entityId' | 'contactId' | 'details'> & { workflowId: string; workflowName: string },
): Promise<void> {
  try {
    await audit(db, locationId, {
      action: entry.action,
      entityType: 'workflow_run',
      entityId: entry.entityId,
      contactId: entry.contactId,
      details: { workflowId: entry.workflowId, ...entry.details },
      actor: { type: 'workflow', id: entry.workflowId, label: `Workflow: ${entry.workflowName}` },
    })
  } catch (err) {
    console.error('workflow audit write failed', (err as { code?: string } | null)?.code ?? 'unknown')
  }
}

/**
 * Run a workflow's steps for one contact, recording an honest execution record in
 * workflow_runs. Status-agnostic: the dispatcher decides which workflows are live;
 * a manual test run drives a draft too. On a `wait`, the run is left `waiting` and
 * the remaining steps are scheduled (default setTimeout) — `opts.runId` +
 * `opts.fromPosition` carry the resume so no step is lost or repeated.
 */
export async function runWorkflow(
  deps: WorkflowRunnerDeps,
  payload: WorkflowRunPayload,
  givenOpts: { runId?: string; fromPosition?: number } = {},
): Promise<WorkflowRun> {
  let opts = givenOpts
  const { db } = deps
  const { locationId } = payload
  const schedule = deps.schedule ?? defaultSchedule

  const runsRepo = new WorkflowRunsRepo(db, locationId)

  const workflow = await new WorkflowsRepo(db, locationId).get(payload.workflowId)
  if (!workflow) {
    // A fresh run pointed at a missing workflow is a caller error — surface it
    // synchronously so the dispatcher sees it.
    if (!opts.runId) throw new Error(`workflow ${payload.workflowId} not found in ${locationId}`)
    // A resume whose workflow was deleted during the wait must NOT throw: this
    // path runs inside a fire-and-forget scheduled callback, so a throw becomes an
    // unhandled rejection and the run is stranded 'waiting' forever. Close it out
    // honestly as failed instead.
    const failedStep: WorkflowRunStep = {
      position: opts.fromPosition ?? 0,
      type: 'wait',
      status: 'failed',
      detail: 'Workflow was deleted during the wait',
    }
    await runsRepo.appendStep(opts.runId, failedStep, 'failed')
    return (await runsRepo.finish(opts.runId, 'failed')) ?? ((await runsRepo.get(opts.runId)) as WorkflowRun)
  }

  // A retried queue job finds the run its first attempt started: a finished or waiting run is
  // returned as it is, and an interrupted one carries on after the steps already recorded.
  if (!opts.runId && payload.runId) {
    const earlier = await runsRepo.get(payload.runId)
    if (earlier) {
      if (earlier.status !== 'running') return earlier
      opts = { runId: earlier.id, fromPosition: earlier.steps.length }
    }
  }

  const actions = await new WorkflowActionsRepo(db, locationId).listByWorkflow(payload.workflowId)
  const contact = payload.contactId
    ? ((await new ContactsRepo(db, locationId).get(payload.contactId)) ?? null)
    : null
  // The location's custom values feed {{custom_values.<key>}} merge tags in
  // message bodies. Fetched once per run (and again on a resume, so an edit made
  // during a wait is picked up).
  const customValues = await new CustomValuesRepo(db, locationId).map()

  let run = opts.runId
    ? ((await runsRepo.get(opts.runId)) as WorkflowRun)
    : await runsRepo.create({
        workflowId: payload.workflowId,
        contactId: payload.contactId,
        triggerType: payload.triggerType,
        id: payload.runId,
      })

  const auditCtx = { workflowId: workflow.id, workflowName: workflow.name }
  if (!opts.runId) {
    await auditRun(db, locationId, {
      ...auditCtx,
      action: 'workflow.run_started',
      entityId: run.id,
      contactId: payload.contactId,
      details: { trigger: payload.triggerType },
    })
  }

  for (let i = opts.fromPosition ?? 0; i < actions.length; i++) {
    const action = actions[i]!

    if (action.type === 'wait') {
      const waiting: WorkflowRunStep = {
        position: i,
        type: 'wait',
        status: 'waiting',
        detail: describeWait(action.config),
      }
      run = (await runsRepo.appendStep(run.id, waiting, 'waiting')) ?? run
      await auditRun(db, locationId, {
        ...auditCtx,
        action: 'workflow.step_executed',
        entityId: run.id,
        contactId: payload.contactId,
        details: { position: i, type: 'wait', status: 'waiting' },
      })
      const resumeId = run.id
      const next = i + 1
      schedule(() => runWorkflow(deps, payload, { runId: resumeId, fromPosition: next }), waitMs(action.config))
      return run
    }

    // "Only if the step before really did its job" (a card must not claim "documents sent" when none went out).
    if (action.config.requirePreviousDone === true && i > 0 && run.steps.find((x) => x.position === i - 1)?.status !== 'done') {
      const skipped: WorkflowRunStep = { position: i, type: action.type, status: 'skipped', detail: 'The step before did not complete' }
      run = (await runsRepo.appendStep(run.id, skipped, 'running')) ?? run
      await auditRun(db, locationId, { ...auditCtx, action: 'workflow.step_executed', entityId: run.id, contactId: payload.contactId, details: { position: i, type: action.type, status: 'skipped' } })
      continue
    }

    // A step that throws (a database fault) is recorded as failed and ends the run, so the
    // queue's retry resumes after the steps that really finished instead of repeating them.
    let step: WorkflowRunStep
    try {
      step = await executeAction({ db, locationId, workflow, contact, customValues, event: payload.event ?? { payload: {}, depth: 0 }, deps }, action, i)
    } catch (err) {
      console.error('workflow step failed', (err as { code?: string } | null)?.code ?? 'unknown')
      step = { position: i, type: action.type, status: 'failed', detail: 'Unexpected error while running this step' }
    }
    run = (await runsRepo.appendStep(run.id, step, step.status === 'failed' ? 'failed' : 'running')) ?? run
    await auditRun(db, locationId, {
      ...auditCtx,
      action: 'workflow.step_executed',
      entityId: run.id,
      contactId: payload.contactId,
      // Type and outcome only: the step's `detail` can quote message text.
      details: { position: i, type: action.type, status: step.status },
    })
    // Nothing after a failed step pretends the earlier work succeeded.
    if (step.status === 'failed') {
      const stopped = (await runsRepo.finish(run.id, 'failed')) ?? run
      await auditRun(db, locationId, { ...auditCtx, action: 'workflow.run_finished', entityId: run.id, contactId: payload.contactId, details: { status: stopped.status } })
      return stopped
    }
  }

  const finished = (await runsRepo.finish(run.id, 'completed')) ?? run
  await auditRun(db, locationId, {
    ...auditCtx,
    action: 'workflow.run_finished',
    entityId: run.id,
    contactId: payload.contactId,
    details: { status: finished.status },
  })
  return finished
}

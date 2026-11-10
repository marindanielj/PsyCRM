import { nanoid } from 'nanoid'
import { PgBoss } from 'pg-boss'
import { type AgentReplyDeps, type AgentReplyPayload, handleAgentReply } from './agent-reply'
import { type SyncDeps, syncDue } from '../lib/calendar-sync'
import { type WorkflowEvent, dispatchWorkflowEvent } from './workflow-dispatcher'
import type { WorkflowRunnerDeps } from './workflow-runner'

export const AGENT_REPLY_QUEUE = 'agent.reply.dispatch'
export const WORKFLOW_DISPATCH_QUEUE = 'workflow.dispatch'
export const CALENDAR_SYNC_QUEUE = 'calendar.sync'
/** Every five minutes; a calendar is only re-read once its last attempt is older than SYNC_MIN_AGE_MS, so a pass is cheap. */
export const CALENDAR_SYNC_CRON = '*/5 * * * *'

// Where a job lands once it has exhausted every retry. pg-boss copies the failed
// job's payload here instead of letting it vanish, so a reply or automation that
// could not be delivered is preserved for an operator to inspect and requeue —
// the opposite of GoHighLevel quietly dropping a failed AI action.
export const AGENT_REPLY_DLQ = 'agent.reply.dead'
export const WORKFLOW_DISPATCH_DLQ = 'workflow.dispatch.dead'

/**
 * Retry policy for jobs that call out to a flaky dependency — the Anthropic API,
 * Chatwoot, our own database. pg-boss defaults to retryLimit 2 with retryDelay 0,
 * i.e. an *immediate* retry. That is exactly wrong for a 429 (rate limited) or 529
 * (overloaded) from the model API: an instant retry re-hits the same limit within
 * milliseconds and burns both attempts, so a momentary hiccup loses the customer's
 * reply. Exponential backoff with jitter (retryBackoff) spaces the attempts out so
 * a transient blip recovers; retryDelayMax caps the wait so a reply is never
 * delayed by more than a few minutes; and the queue's dead-letter target keeps the
 * payload if every attempt still fails.
 */
export const RESILIENT_RETRY = {
  retryLimit: 4,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
} as const

// One job per fetch. With a batch, a single throw fails the whole batch in
// pg-boss; at batchSize 1 a throw fails *only* that job, which then retries with
// the backoff policy above and never takes its neighbours down with it. Kept
// explicit so the invariant cannot silently drift if a default changes.
export const SINGLE_JOB = { batchSize: 1 } as const

/**
 * Create every queue this app uses, each with its durability policy. The
 * dead-letter queues are created first because a queue's `deadLetter` must name a
 * queue that already exists. Split out from `startBoss` so the wiring (does the
 * backoff policy actually reach createQueue?) is unit-testable against a fake boss.
 */
export async function ensureQueues(boss: Pick<PgBoss, 'createQueue'>): Promise<void> {
  await boss.createQueue(AGENT_REPLY_DLQ)
  await boss.createQueue(WORKFLOW_DISPATCH_DLQ)
  await boss.createQueue(AGENT_REPLY_QUEUE, { ...RESILIENT_RETRY, deadLetter: AGENT_REPLY_DLQ })
  await boss.createQueue(WORKFLOW_DISPATCH_QUEUE, { ...RESILIENT_RETRY, deadLetter: WORKFLOW_DISPATCH_DLQ })
}

/**
 * Start pg-boss against DATABASE_URL and ensure our queues exist.
 *
 * `createSchema: false` is for production, where the app's database role cannot
 * create schemas (it would need CREATE on the whole database): db/roles.sql
 * creates the `pgboss` schema for it, and pg-boss then only fills it.
 */
export async function startBoss(connectionString: string, opts: { createSchema?: boolean } = {}): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, createSchema: opts.createSchema ?? true })
  await boss.start()
  await ensureQueues(boss)
  return boss
}

/** Register the worker that runs handleAgentReply for each queued job. A throw
 *  from the handler (a model/DB failure) fails just this one job, which pg-boss
 *  then retries with backoff; handleAgentReply turns its *expected* dead ends
 *  (no key, unknown location) into a `skipped` return so they complete cleanly
 *  rather than burning retries. */
export async function registerAgentReplyWorker(boss: PgBoss, deps: AgentReplyDeps): Promise<void> {
  await boss.work<AgentReplyPayload>(AGENT_REPLY_QUEUE, SINGLE_JOB, async (jobs) => {
    for (const job of jobs) {
      await handleAgentReply(deps, job.data)
    }
  })
}

/** Enqueue an agent-reply job — called by the webhook's onInbound hook. */
export async function enqueueAgentReply(boss: PgBoss, payload: AgentReplyPayload): Promise<void> {
  await boss.send(AGENT_REPLY_QUEUE, payload)
}

/**
 * Register the worker that fans a workflow event out to its live workflows. Each
 * job runs `dispatchWorkflowEvent`, which starts one run per matching workflow.
 * Runs use the runner's default scheduler for `wait` steps (in-process timers);
 * making long waits survive a restart is a later refinement (the runner already
 * supports resume via runId + fromPosition — it's a scheduler swap, not a rewrite).
 */
export async function registerWorkflowDispatchWorker(
  boss: PgBoss,
  deps: WorkflowRunnerDeps,
): Promise<void> {
  await boss.work<WorkflowEvent>(WORKFLOW_DISPATCH_QUEUE, SINGLE_JOB, async (jobs) => {
    for (const job of jobs) {
      await dispatchWorkflowEvent(deps, job.data)
    }
  })
}

/** Enqueue a workflow event — called by routes/webhooks when a trigger fires. */
export async function enqueueWorkflowEvent(boss: PgBoss, event: WorkflowEvent): Promise<void> {
  // The id lets a retried job pick its runs back up instead of repeating their steps.
  await boss.send(WORKFLOW_DISPATCH_QUEUE, { ...event, eventId: event.eventId ?? nanoid() })
}

/**
 * Start the calendar-sync poller: a scheduled tick that reads every personal calendar that is due. Only registered when the
 * `calendar_sync` integration is on. A tick that fails is simply the next tick's work (no retries needed: the data is
 * re-read from scratch each time), so the queue keeps pg-boss's default policy.
 */
export async function registerCalendarSyncWorker(boss: PgBoss, deps: SyncDeps): Promise<void> {
  await boss.createQueue(CALENDAR_SYNC_QUEUE)
  await boss.schedule(CALENDAR_SYNC_QUEUE, CALENDAR_SYNC_CRON)
  await boss.work(CALENDAR_SYNC_QUEUE, SINGLE_JOB, async () => {
    await syncDue(deps)
  })
}

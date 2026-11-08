import type { Database } from '../db/database'
import { isMinor, isValidIsoDate, todayIn } from '../lib/age'
import { maskEmail } from '../lib/document-tokens'
import { sendDocumentPacket } from '../lib/document-send'
import { renderTemplate } from '../lib/merge-fields'
import { createTaskOnce, moveContactToStage } from '../lib/onboarding'
import { type ResolvedEmailSender, resolveEmailSender } from '../lib/sending/resolve'
import { type Contact, ContactsRepo } from '../repos/contacts-repo'
import { DocumentPacketsRepo } from '../repos/document-packets-repo'
import { DocumentRequestsRepo } from '../repos/document-requests-repo'
import { TimelineRepo } from '../repos/timeline-repo'
import type { WorkflowRunStep } from '../repos/workflow-runs-repo'
import type { WorkflowAction } from '../repos/workflows-repo'
import type { WorkflowDispatch } from './workflow-dispatcher'

/** What the actions need beyond the database. All optional: a missing one makes that action fail honestly. */
export interface ActionDeps {
  dispatch?: WorkflowDispatch
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  /** Origin of the signing links in emails (PUBLIC_BASE_URL). */
  publicBaseUrl?: string
  now?: () => Date
}

export interface ActionContext {
  db: Database
  locationId: string
  workflow: { id: string; name: string }
  contact: Contact | null
  customValues: Record<string, string>
  /** The trigger's payload and how many automation hops preceded this run. */
  event: { payload: Record<string, unknown>; depth: number }
  deps: ActionDeps
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const eventStrings = (p: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]))

function contactName(c: Contact): string {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.emails[0] || 'Client'
}

/**
 * Execute one action and say honestly what happened. `done` = it took effect, `skipped` = it
 * had nothing to do (and why), `failed` = it could not do its job. A failed step stops the run:
 * nothing after it pretends the earlier work succeeded.
 */
export async function executeAction(ctx: ActionContext, action: WorkflowAction, position: number): Promise<WorkflowRunStep> {
  const { db, locationId, contact, customValues, workflow, deps } = ctx
  const base = { position, type: action.type }
  const cfg = action.config
  const auditCtx = { actor: { type: 'workflow' as const, id: workflow.id, label: `Workflow: ${workflow.name}` } }
  const merge = (text: string) => renderTemplate(text, contact, customValues, eventStrings(ctx.event.payload))

  switch (action.type) {
    case 'add_tag': {
      const tag = str(cfg.tag).trim()
      if (!tag) return { ...base, status: 'skipped', detail: 'No tag configured' }
      if (!contact) return { ...base, status: 'skipped', detail: 'No contact to tag' }
      await new ContactsRepo(db, locationId).addTag(contact.id, tag)
      return { ...base, status: 'done', detail: `Added tag "${tag}"` }
    }

    case 'send_sms': {
      // Texting stays a log entry until there is an SMS provider with a BAA: never claim "sent".
      if (!contact) return { ...base, status: 'skipped', detail: 'No contact to send SMS' }
      const body = merge(str(cfg.body))
      await new TimelineRepo(db, locationId).add({ contactId: contact.id, type: 'automation_action', refTable: 'workflows', payload: { action: 'send_sms', channel: 'sms', subject: null, body, status: 'logged' } })
      return { ...base, status: 'done', detail: `SMS logged: "${body.length > 60 ? `${body.slice(0, 60)}…` : body}"` }
    }

    case 'send_email': {
      if (!contact) return { ...base, status: 'skipped', detail: 'No contact to send email' }
      const to = contact.emails[0]
      if (!to) return { ...base, status: 'skipped', detail: 'The contact has no email' }
      const subject = merge(str(cfg.subject))
      const body = merge(str(cfg.body))
      const sender = await (deps.resolveEmail ?? resolveEmailSender)(db, locationId)
      const timeline = new TimelineRepo(db, locationId)
      if (!sender.ok) {
        await timeline.add({ contactId: contact.id, type: 'automation_action', refTable: 'workflows', payload: { action: 'send_email', channel: 'email', subject, status: 'failed' } })
        return { ...base, status: 'failed', detail: 'Email provider not configured' }
      }
      try {
        const sent = await sender.sender.sendEmail({ to, toName: contact.name ?? undefined, subject, text: body })
        await timeline.add({ contactId: contact.id, type: 'automation_action', refTable: 'workflows', payload: { action: 'send_email', channel: 'email', subject, body, status: 'sent', externalId: sent.externalId } })
        return { ...base, status: 'done', detail: `Email sent to ${maskEmail(to)}` }
      } catch {
        // The provider's error can echo the address or the text: keep it out of the log.
        await timeline.add({ contactId: contact.id, type: 'automation_action', refTable: 'workflows', payload: { action: 'send_email', channel: 'email', subject, status: 'failed' } })
        return { ...base, status: 'failed', detail: 'The email provider rejected the message' }
      }
    }

    case 'move_to_stage': {
      if (!contact) return { ...base, status: 'skipped', detail: 'No contact to move' }
      const pipelineId = str(cfg.pipelineId)
      const stageId = str(cfg.stageId)
      if (!pipelineId || !stageId) return { ...base, status: 'skipped', detail: 'No pipeline stage configured' }
      const r = await moveContactToStage(db, locationId, {
        contactId: contact.id,
        contactName: contactName(contact),
        pipelineId,
        stageId,
        createIfMissing: cfg.createIfMissing !== false,
        onlyForward: cfg.onlyForward !== false,
        audit: auditCtx,
        dispatch: deps.dispatch,
        depth: ctx.event.depth,
      })
      return { ...base, ...r }
    }

    case 'send_document_packet': {
      if (!contact) return { ...base, status: 'skipped', detail: 'No contact to send to' }
      const adultId = str(cfg.packetId)
      const teenId = str(cfg.adolescentPacketId)
      if (!adultId && !teenId) return { ...base, status: 'skipped', detail: 'No packet configured' }
      const task = (title: string, body: string) => createTaskOnce(db, locationId, { contactId: contact.id, title, body })
      const today = deps.now ? todayIn(undefined, deps.now()) : undefined

      // The packet follows the client's age; with no date of birth nothing is sent (never the adult packet by default).
      const dob = contact.custom_fields?.date_of_birth
      if (!isValidIsoDate(dob)) {
        await task('Add date of birth to send the onboarding packet', 'The date of birth decides which packet is sent. Add it to the record, then send the packet from the Documents tab.')
        return { ...base, status: 'skipped', detail: 'No date of birth on the record' }
      }
      const minor = isMinor(dob, today) === true
      const packetId = minor ? teenId : adultId
      if (!packetId) {
        // No adolescent packet is configured: a person sends it (it needs a guardian).
        if (minor) await task('Send adolescent onboarding packet (guardian required)', 'This client is under 18: send the adolescent packet from the Documents tab, with a parent or guardian as signer.')
        return { ...base, status: 'skipped', detail: minor ? 'The client is under 18: the adult packet was not sent' : 'No adult packet configured' }
      }
      const packet = await new DocumentPacketsRepo(db, locationId).get(packetId)
      if (!packet || packet.archivedAt) return { ...base, status: 'failed', detail: 'The packet no longer exists' }
      if (packet.audience !== (minor ? 'adolescent' : 'adult')) return { ...base, status: 'skipped', detail: 'The packet does not fit the client\'s age' }

      // Who signs: the client for an adult; the parent or guardian (recorded at registration) for a minor.
      let signer: { role: 'client' | 'guardian'; name: string; email: string }
      if (minor) {
        const gName = str(contact.custom_fields?.guardian_name).trim()
        const gEmail = str(contact.custom_fields?.guardian_email).trim()
        if (!gName || !gEmail) {
          await task('Add the guardian\'s name and email to send the adolescent packet', 'The adolescent packet is signed by a parent or guardian. Add their name and email to the record (Guardian fields), then send the packet from the Documents tab.')
          return { ...base, status: 'skipped', detail: 'No guardian name and email on the record' }
        }
        signer = { role: 'guardian', name: gName, email: gEmail }
      } else {
        const email = contact.emails[0]
        if (!email) {
          await task('Add an email to send the onboarding packet', 'The client has no email on record, so the packet could not be sent.')
          return { ...base, status: 'skipped', detail: 'The contact has no email' }
        }
        signer = { role: 'client', name: contactName(contact), email }
      }
      if (await new DocumentRequestsRepo(db, locationId).hasLiveRequest(contact.id, packetId)) {
        return { ...base, status: 'skipped', detail: 'This packet was already sent' }
      }

      const sent = await sendDocumentPacket(
        { db, locationId, today: deps.now ? () => todayIn(undefined, deps.now!()) : undefined, resolveEmail: deps.resolveEmail, baseUrl: deps.publicBaseUrl ?? null },
        { contactId: contact.id, packetId, excludeFamilyIds: [], signers: [signer] },
        { sentBy: `workflow:${workflow.id}`, audit: auditCtx },
      )
      if (!sent.ok) {
        const e = String(sent.body.error ?? 'error')
        return { ...base, status: 'failed', detail: e === 'template_not_active' ? 'A document in the packet has no version in force yet' : e === 'base_url_missing' ? 'PUBLIC_BASE_URL is not configured' : `Could not send the packet (${e})` }
      }
      const s = sent.signers[0]!
      return s.emailed
        ? { ...base, status: 'done', detail: `Packet sent to ${maskEmail(s.email)}` }
        : { ...base, status: 'failed', detail: `The packet was created but the email was not sent (${s.emailIssue ?? 'unknown'}): resend it from the Documents tab` }
    }

    case 'create_task': {
      if (!contact) return { ...base, status: 'skipped', detail: 'No contact for the task' }
      const title = merge(str(cfg.title)).trim()
      if (!title) return { ...base, status: 'skipped', detail: 'No task title configured' }
      const days = typeof cfg.dueInDays === 'number' && Number.isFinite(cfg.dueInDays) && cfg.dueInDays >= 0 ? cfg.dueInDays : null
      const now = deps.now?.() ?? new Date()
      const made = await createTaskOnce(db, locationId, { contactId: contact.id, title, body: str(cfg.body) ? merge(str(cfg.body)) : null, dueAt: days === null ? null : new Date(now.getTime() + days * 86_400_000) })
      return made ? { ...base, status: 'done', detail: `Created task "${title}"` } : { ...base, status: 'skipped', detail: 'That task is already open' }
    }

    default:
      return { ...base, status: 'skipped', detail: `Unsupported action: ${action.type}` }
  }
}

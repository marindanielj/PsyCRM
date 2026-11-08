import {
  CalendarCheck,
  ClipboardCheck,
  Clock,
  FileSignature,
  FileText,
  ListTodo,
  MoveRight,
  NotebookPen,
  Send,
  UserCheck,
  type LucideIcon,
  Mail,
  MessageSquare,
  MousePointerClick,
  Tag,
  Target,
  UserPlus,
} from 'lucide-react'
import type { ActionType, TriggerType } from '../../lib/api'

// Web mirror of server/lib/automation-vocab.ts. Kept here (not imported from the
// server) so the bundle stays frontend-only; the union types come from api.ts.

export const TRIGGERS: TriggerType[] = [
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
]
// Texting stays out of the list: there is no SMS provider with a BAA yet, so it only logs.
// (An existing send_sms step still shows in a workflow; it just cannot be added.)
export const ACTIONS: ActionType[] = ['send_email', 'add_tag', 'wait', 'move_to_stage', 'send_document_packet', 'create_task']

interface TriggerMeta {
  label: string
  icon: LucideIcon
}
const DEFAULT_TRIGGER: TriggerMeta = { label: 'New contact created', icon: UserPlus }
const TRIGGER_META: Record<TriggerType, TriggerMeta> = {
  contact_created: DEFAULT_TRIGGER,
  inbound_message: { label: 'Inbound message received', icon: MessageSquare },
  appointment_booked: { label: 'Appointment booked', icon: CalendarCheck },
  opportunity_created: { label: 'Opportunity created', icon: Target },
  trigger_link_clicked: { label: 'Trigger link clicked', icon: MousePointerClick },
  survey_submitted: { label: 'Survey submitted', icon: ClipboardCheck },
  proposal_signed: { label: 'Proposal signed', icon: FileSignature },
  pipeline_stage_changed: { label: 'Pipeline stage changed', icon: MoveRight },
  session_note_signed: { label: 'Session note signed', icon: NotebookPen },
  appointment_checked_in: { label: 'Client checked in', icon: UserCheck },
  documents_completed: { label: 'Onboarding documents completed', icon: FileSignature },
  document_signed: { label: 'Document signed', icon: FileText },
}
export const triggerMeta = (t: string): TriggerMeta =>
  TRIGGER_META[t as TriggerType] ?? DEFAULT_TRIGGER

interface ActionMeta {
  label: string
  icon: LucideIcon
  // Full static class strings (no interpolation) so Tailwind keeps them on purge.
  tile: string
}
const DEFAULT_ACTION: ActionMeta = {
  label: 'Send SMS',
  icon: MessageSquare,
  tile: 'bg-brand-50 text-brand-600',
}
const ACTION_META: Record<ActionType, ActionMeta> = {
  send_sms: DEFAULT_ACTION,
  send_email: { label: 'Send email', icon: Mail, tile: 'bg-violet-50 text-violet-600' },
  add_tag: { label: 'Add tag', icon: Tag, tile: 'bg-emerald-50 text-emerald-600' },
  wait: { label: 'Wait', icon: Clock, tile: 'bg-amber-50 text-amber-600' },
  move_to_stage: { label: 'Move to pipeline stage', icon: MoveRight, tile: 'bg-sky-50 text-sky-600' },
  send_document_packet: { label: 'Send document packet', icon: Send, tile: 'bg-indigo-50 text-indigo-600' },
  create_task: { label: 'Create task', icon: ListTodo, tile: 'bg-rose-50 text-rose-600' },
}
export const actionMeta = (t: string): ActionMeta => ACTION_META[t as ActionType] ?? DEFAULT_ACTION

/** A one-line human summary of a step's config for the builder canvas. */
export function actionSummary(type: string, config: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
  switch (type) {
    case 'send_sms':
      return str(config.body) || 'No message yet'
    case 'send_email':
      return str(config.subject) || str(config.body) || 'No subject yet'
    case 'add_tag': {
      const tag = str(config.tag)
      return tag ? `Tag “${tag}”` : 'No tag yet'
    }
    case 'move_to_stage':
      return `${config.onlyForward === false ? 'Move' : 'Move forward'} to a stage${config.createIfMissing === false ? '' : ' (creates the card if missing)'}`
    case 'send_document_packet':
      return 'Sends the packet by email (adults only)'
    case 'create_task':
      return str(config.title) || 'No title yet'
    case 'wait': {
      const m = num(config.minutes)
      return `${m} ${m === 1 ? 'minute' : 'minutes'}`
    }
    default:
      return ''
  }
}

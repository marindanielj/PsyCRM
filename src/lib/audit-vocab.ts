// Web mirror of server/lib/audit-vocab.ts (kept here so the bundle stays
// frontend-only). server/lib/audit-vocab.test.ts fails if the two drift apart.

export const AUDIT_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in attempt',
  'auth.logout': 'Signed out',
  'contact.created': 'Client created',
  'contact.updated': 'Client details changed',
  'contact.viewed': 'Client record opened',
  'contact.archived': 'Client archived',
  'contact.restored': 'Client restored',
  'contact.tag_added': 'Tag added',
  'contact.tag_removed': 'Tag removed',
  'contact.custom_fields_updated': 'Custom fields changed',
  'contact.updated_from_intake': 'Client details updated from intake form',
  'contact.note_added': 'Client record note added',
  'contact.note_updated': 'Client record note edited',
  'contact.note_deleted': 'Client record note deleted',
  'task.created': 'Task created',
  'task.completed': 'Task completed',
  'appointment.booked': 'Appointment booked by client',
  'appointment.created': 'Appointment created',
  'appointment.rescheduled': 'Appointment rescheduled',
  'appointment.status_changed': 'Appointment status changed',
  'appointment.checked_in': 'Client checked in',
  'appointment.deleted': 'Appointment deleted',
  'opportunity.created': 'Pipeline card created',
  'opportunity.updated': 'Pipeline card edited',
  'opportunity.status_changed': 'Pipeline card status changed',
  'opportunity.deleted': 'Pipeline card deleted',
  'pipeline.stage_changed': 'Moved to another pipeline stage',
  'workflow.run_started': 'Automation started',
  'workflow.step_executed': 'Automation step executed',
  'workflow.run_finished': 'Automation finished',
  'workflow.loop_prevented': 'Automation loop prevented',
  'note.created': 'Session note created',
  'note.updated': 'Session note edited',
  'note.autosaved': 'Session note autosaved',
  'note.signed': 'Session note signed',
  'note.signed_late': 'Session note signed after the edit window',
  'note.viewed': 'Session note opened',
  'note.printed': 'Session note printed',
  'note.deleted': 'Session note deleted',
  'note.addendum_added': 'Addendum added to session note',
  'note.revision_viewed': 'Session note revision opened',
  'note.edit_rejected_locked': 'Edit of a locked session note rejected',
  'risk.level_changed': 'Risk level changed',
  'template.created': 'Document template created',
  'template.updated': 'Document template edited',
  'template.version_created': 'Document template version created',
  'template.activated': 'Document template activated',
  'template.retired': 'Document template retired',
  'packet.created': 'Document packet created',
  'packet.updated': 'Document packet edited',
  'packet.sent': 'Document packet sent',
  'packet.completed': 'Document packet completed',
  'packet.age_mismatch': 'Packet audience does not match client age',
  'packet.voided': 'Document packet voided',
  'packet.expired': 'Document packet expired',
  'packet.resent': 'Document link re-sent',
  'signer.locked': 'Signer locked after failed verification attempts',
  'invite.sent': 'Client invitation sent',
  'invite.resent': 'Client invitation re-sent',
  'invite.voided': 'Client invitation cancelled',
  'invite.completed': 'Client completed their registration',
  'invite.expired': 'Client invitation expired',
  'document.viewed': 'Document opened by client',
  'document.signed': 'Document signed',
  'document.downloaded': 'Signed documents downloaded',
  'document.viewed_by_operator': 'Signed document opened',
  'signer.completed': 'Signer completed all documents',
  'audit.exported': 'Audit log exported',
}

export const AUDIT_CATEGORIES: { key: string; label: string; prefixes: string[] }[] = [
  { key: 'auth', label: 'Sign-ins', prefixes: ['auth.'] },
  { key: 'contacts', label: 'Clients', prefixes: ['contact.', 'invite.'] },
  { key: 'notes', label: 'Session notes', prefixes: ['note.', 'risk.'] },
  { key: 'documents', label: 'Documents', prefixes: ['template.', 'packet.', 'document.', 'signer.'] },
  { key: 'pipeline', label: 'Pipeline', prefixes: ['pipeline.', 'opportunity.'] },
  { key: 'appointments', label: 'Appointments', prefixes: ['appointment.'] },
  { key: 'workflows', label: 'Automations', prefixes: ['workflow.'] },
  { key: 'tasks', label: 'Tasks', prefixes: ['task.'] },
  { key: 'audit', label: 'Audit log', prefixes: ['audit.'] },
]

export const auditLabel = (action: string): string => AUDIT_LABELS[action] ?? action

/** One-line, human summary of an entry's details (field names, from→to), no PHI values. */
export function auditSummary(action: string, details: Record<string, unknown>): string {
  const fields = Array.isArray(details.fields) ? (details.fields as unknown[]).join(', ') : null
  const fromTo = 'from' in details || 'to' in details ? `${fmt(details.from)} → ${fmt(details.to)}` : null
  switch (action) {
    case 'pipeline.stage_changed':
      return `to “${fmt(details.toStage)}”${details.origin === 'workflow' ? ' (by automation)' : ''}`
    case 'contact.tag_added':
    case 'contact.tag_removed':
      return `“${fmt(details.tag)}”`
    case 'workflow.step_executed':
      return `step ${Number(details.position ?? 0) + 1}: ${fmt(details.type)} — ${fmt(details.status)}`
    case 'workflow.run_started':
      return `trigger: ${fmt(details.trigger)}`
    case 'workflow.run_finished':
      return fmt(details.status)
    case 'appointment.status_changed':
    case 'appointment.rescheduled':
      return fromTo ?? ''
    default:
      return fields ? `fields: ${fields}` : (fromTo ?? (typeof details.to === 'string' ? `to ${details.to}` : ''))
  }
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/**
 * Every action the audit log can record, with the label the UI shows. One
 * vocabulary shared by the server (validation) and the web (filters, labels —
 * src/lib/audit-vocab.ts mirrors the labels). Actions for later days (notes,
 * documents) are listed now so their labels and categories already exist.
 *
 * Naming: `<entity>.<verb>`; the prefix before the dot is the category filter.
 */
export const AUDIT_ACTIONS = {
  // auth
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in attempt',
  'auth.logout': 'Signed out',
  // contacts
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
  // tasks
  'task.created': 'Task created',
  'task.completed': 'Task completed',
  // appointments
  'appointment.booked': 'Appointment booked by client',
  'appointment.created': 'Appointment created',
  'appointment.rescheduled': 'Appointment rescheduled',
  'appointment.status_changed': 'Appointment status changed',
  'appointment.checked_in': 'Client checked in',
  'appointment.deleted': 'Appointment deleted',
  // pipeline
  'opportunity.created': 'Pipeline card created',
  'opportunity.status_changed': 'Pipeline card status changed',
  'opportunity.deleted': 'Pipeline card deleted',
  'pipeline.stage_changed': 'Moved to another pipeline stage',
  // workflows
  'workflow.run_started': 'Automation started',
  'workflow.step_executed': 'Automation step executed',
  'workflow.run_finished': 'Automation finished',
  'workflow.loop_prevented': 'Automation loop prevented',
  // session notes (day 3)
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
  // documents (days 5-6)
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
  'document.viewed': 'Document opened by client',
  'document.signed': 'Document signed',
  'document.downloaded': 'Signed documents downloaded',
  'document.viewed_by_operator': 'Signed document opened',
  'signer.completed': 'Signer completed all documents',
  // the audit log itself
  'audit.exported': 'Audit log exported',
} as const

export type AuditAction = keyof typeof AUDIT_ACTIONS

export const AUDIT_CATEGORIES = [
  { key: 'auth', label: 'Sign-ins', prefixes: ['auth.'] },
  { key: 'contacts', label: 'Clients', prefixes: ['contact.'] },
  { key: 'notes', label: 'Session notes', prefixes: ['note.', 'risk.'] },
  { key: 'documents', label: 'Documents', prefixes: ['template.', 'packet.', 'document.', 'signer.'] },
  { key: 'pipeline', label: 'Pipeline', prefixes: ['pipeline.', 'opportunity.'] },
  { key: 'appointments', label: 'Appointments', prefixes: ['appointment.'] },
  { key: 'workflows', label: 'Automations', prefixes: ['workflow.'] },
  { key: 'tasks', label: 'Tasks', prefixes: ['task.'] },
  { key: 'audit', label: 'Audit log', prefixes: ['audit.'] },
] as const

export type AuditCategoryKey = (typeof AUDIT_CATEGORIES)[number]['key']

export function auditLabel(action: string): string {
  return (AUDIT_ACTIONS as Record<string, string>)[action] ?? action
}

/** Action prefixes (like `contact.`) for a category key, or [] if unknown. */
export function categoryPrefixes(key: string): readonly string[] {
  return AUDIT_CATEGORIES.find((c) => c.key === key)?.prefixes ?? []
}

export const ACTOR_TYPES = ['operator', 'client', 'system', 'workflow'] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

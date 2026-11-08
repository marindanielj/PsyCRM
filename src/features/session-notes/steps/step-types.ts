import type { Appointment } from '../../../lib/api'
import type { NoteForm } from '../note-utils'

export interface StepProps {
  form: NoteForm
  patch: (p: Partial<NoteForm>) => void
  /** The note is locked or being viewed: nothing can be changed. */
  readOnly?: boolean
  /** Mark unanswered required fields in red (after the clinician tried to move on). */
  showErrors?: boolean
}

export interface ContextStepProps extends StepProps {
  appointments: Appointment[]
  /** Called when an appointment is chosen so date/time/duration can follow it. */
  onPickAppointment: (id: string | null) => void
}

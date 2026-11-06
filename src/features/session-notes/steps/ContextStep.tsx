import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { MODALITIES, SESSION_TYPES } from '../../../lib/clinical-vocab'
import { ChoiceGroup } from '../ChipGroup'
import { formatSessionDate, todayInPractice } from '../note-utils'
import type { ContextStepProps } from './step-types'

const apptLabel = (a: { starts_at: string; title: string }) =>
  `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(a.starts_at))} — ${a.title}`

/** Step 1: which session is this note about. */
export function ContextStep({ form, patch, readOnly, appointments, onPickAppointment }: ContextStepProps) {
  return (
    <div className="space-y-5">
      <div>
        <Label htmlFor="note-appt">Linked appointment</Label>
        <select
          id="note-appt"
          disabled={readOnly}
          value={form.appointmentId ?? ''}
          onChange={(e) => onPickAppointment(e.target.value || null)}
          className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm disabled:opacity-60"
        >
          <option value="">No appointment (walk-in or past session)</option>
          {appointments.map((a) => (
            <option key={a.id} value={a.id}>
              {apptLabel(a)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">Signing the note marks the appointment as completed.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="note-date">Session date</Label>
          <Input id="note-date" type="date" disabled={readOnly} max={todayInPractice()} value={form.sessionDate} onChange={(e) => patch({ sessionDate: e.target.value })} />
          {form.sessionDate ? <p className="mt-1 text-xs text-slate-500">{formatSessionDate(form.sessionDate)}</p> : null}
        </div>
        <div>
          <Label htmlFor="note-time">Start time</Label>
          <Input id="note-time" type="time" disabled={readOnly} value={form.startTime} onChange={(e) => patch({ startTime: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="note-duration">Duration (minutes)</Label>
          <Input id="note-duration" type="number" min={1} max={600} disabled={readOnly} value={form.durationMin} onChange={(e) => patch({ durationMin: e.target.value })} />
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700">Modality</p>
        <ChoiceGroup ariaLabel="Modality" options={MODALITIES} value={form.modality} onChange={(v) => patch({ modality: v })} disabled={readOnly} />
      </div>
      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700">Session type</p>
        <ChoiceGroup ariaLabel="Session type" options={SESSION_TYPES} value={form.sessionType} onChange={(v) => patch({ sessionType: v })} disabled={readOnly} />
      </div>
    </div>
  )
}

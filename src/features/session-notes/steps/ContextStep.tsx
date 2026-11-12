import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { MODALITIES, SESSION_TYPES, label } from '../../../lib/clinical-vocab'
import { formatDateEs } from '../../../lib/billing'
import { labelEs } from '../../../lib/intake-form'
import { ChoiceGroup } from '../ChipGroup'
import { formatSessionDate, todayInPractice } from '../note-utils'
import type { ContextStepProps } from './step-types'

const apptLabel = (a: { starts_at: string; title: string }, lang: 'en' | 'es' = 'en') =>
  `${new Intl.DateTimeFormat(lang === 'es' ? 'es-PR' : 'en-US', { timeZone: 'America/Puerto_Rico', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(a.starts_at))} — ${a.title}`

const TEXT = {
  en: { appt: 'Linked appointment', noAppt: 'No appointment (walk-in or past session)', apptHint: 'Signing the note marks the appointment as completed.', date: 'Session date', time: 'Start time', duration: 'Duration (minutes)', modality: 'Modality', type: 'Session type' },
  es: { appt: 'Cita', noAppt: 'Sin cita (sesión sin agendar o pasada)', apptHint: 'Al firmar la nota, la cita queda como completada.', date: 'Fecha de la sesión', time: 'Hora de inicio', duration: 'Duración (minutos)', modality: 'Modalidad', type: 'Tipo de sesión' },
}
const SESSION_TYPE_ES: Record<string, string> = { intake: 'Entrevista inicial', individual: 'Individual', couple: 'Pareja', family: 'Familia', crisis: 'Crisis', collateral: 'Colateral' }

/** Step 1: which session is this note about. */
export function ContextStep({ form, patch, readOnly, appointments, onPickAppointment, lang = 'en' }: ContextStepProps) {
  const t = TEXT[lang]
  const remote = form.modality !== 'in_person'
  const tele = form.intake.telehealth ?? { location: '', in_pr: null, private_setting: null }
  const setTele = (p: Partial<typeof tele>) => patch({ intake: { ...form.intake, telehealth: { ...tele, ...p } } })
  const yesNo = (v: boolean | null) => (v === null ? null : v ? 'yes' : 'no')
  return (
    <div className="space-y-5">
      <div>
        <Label htmlFor="note-appt">{t.appt}</Label>
        <select
          id="note-appt"
          disabled={readOnly}
          value={form.appointmentId ?? ''}
          onChange={(e) => onPickAppointment(e.target.value || null)}
          className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm disabled:opacity-60"
        >
          <option value="">{t.noAppt}</option>
          {appointments.map((a) => (
            <option key={a.id} value={a.id}>
              {apptLabel(a, lang)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">{t.apptHint}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="note-date">{t.date}</Label>
          <Input id="note-date" type="date" disabled={readOnly} max={todayInPractice()} value={form.sessionDate} onChange={(e) => patch({ sessionDate: e.target.value })} />
          {form.sessionDate ? <p className="mt-1 text-xs text-slate-500">{lang === 'es' ? formatDateEs(form.sessionDate) : formatSessionDate(form.sessionDate)}</p> : null}
        </div>
        <div>
          <Label htmlFor="note-time">{t.time}</Label>
          <Input id="note-time" type="time" disabled={readOnly} value={form.startTime} onChange={(e) => patch({ startTime: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="note-duration">{t.duration}</Label>
          <Input id="note-duration" type="number" min={1} max={600} disabled={readOnly} value={form.durationMin} onChange={(e) => patch({ durationMin: e.target.value })} />
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700">{t.modality}</p>
        <ChoiceGroup labelOf={lang === 'es' ? labelEs : label} ariaLabel={t.modality} options={MODALITIES} value={form.modality} onChange={(v) => patch({ modality: v })} disabled={readOnly} />
      </div>
      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700">{t.type}</p>
        <ChoiceGroup labelOf={lang === 'es' ? (v) => SESSION_TYPE_ES[v] ?? v : label} ariaLabel={t.type} options={SESSION_TYPES} value={form.sessionType} onChange={(v) => patch({ sessionType: v })} disabled={readOnly} />
      </div>

      {lang === 'es' && remote ? (
        <fieldset className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <legend className="px-1 text-sm font-semibold text-slate-900">Sesión a distancia</legend>
          <div>
            <Label htmlFor="tele-loc">¿Dónde se encuentra físicamente el cliente?</Label>
            <Input id="tele-loc" disabled={readOnly} maxLength={300} placeholder="Municipio o dirección" value={tele.location} onChange={(e) => setTele({ location: e.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">¿Está en Puerto Rico?</p>
              <ChoiceGroup ariaLabel="¿Está en Puerto Rico?" options={['yes', 'no']} labelOf={(v) => (v === 'yes' ? 'Sí' : 'No')} value={yesNo(tele.in_pr)} onChange={(v) => setTele({ in_pr: v === 'yes' })} disabled={readOnly} />
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">¿Está en un lugar privado?</p>
              <ChoiceGroup ariaLabel="¿Está en un lugar privado?" options={['yes', 'no']} labelOf={(v) => (v === 'yes' ? 'Sí' : 'No')} value={yesNo(tele.private_setting)} onChange={(v) => setTele({ private_setting: v === 'yes' })} disabled={readOnly} />
            </div>
          </div>
          {tele.in_pr === false ? <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">El cliente no está en Puerto Rico: confirme que su licencia le permite atenderle donde se encuentra.</p> : null}
        </fieldset>
      ) : null}
    </div>
  )
}

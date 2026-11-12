import { AlertTriangle, CheckCircle2, Info, Quote } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import type { IntakeClientAnswers } from '../../../lib/api'
import {
  CLIENT_ANSWER_TARGETS, FUNCTIONING_ROWS, INTAKE_TEXTS, INTAKE_TEXT_MAX, type IntakeForm, type IntakeRow, type IntakeTextKey, MH_HISTORY_ROWS,
  PERSONAL_HISTORY_ROWS,
} from '../../../lib/intake-form'
import { cn } from '../../../lib/utils'
import { IntakeReport, type IntakeReportData } from '../IntakeReport'
import { riskStatus } from '../note-utils'
import { RISK_ISSUE_TEXT_ES, RiskStep } from './RiskStep'
import type { StepProps } from './step-types'

/**
 * The intake note's own steps (B11): her printed form, in her order and with her words, in Spanish. No box has the size of
 * the paper: every text grows with what she writes. Next to a section, what the client answered in the admission
 * questionnaire, with a button to bring it in.
 */

type Group = 'functioning' | 'mh_history' | 'personal_history'
export interface IntakeStepProps extends StepProps {
  answers: IntakeClientAnswers | null
}

/** A textarea that grows with its text (never a fixed box). */
export function GrowingTextarea({ value, onChange, minRows = 3, className, ...rest }: {
  value: string
  onChange: (v: string) => void
  minRows?: number
  className?: string
  id?: string
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
  invalid?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [value])
  const { invalid, ...props } = rest
  return (
    <Textarea
      ref={ref}
      rows={minRows}
      maxLength={INTAKE_TEXT_MAX}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn('overflow-hidden leading-relaxed', invalid && 'border-rose-400 ring-2 ring-rose-200', className)}
      {...props}
    />
  )
}

/** What the client wrote in the questionnaire for this part, and a button that brings it into the note as a quote. */
function ClientAnswer({ text, onUse, disabled }: { text: string | undefined; onUse: (quoted: string) => void; disabled?: boolean }) {
  if (!text) return null
  return (
    <div className="mt-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950">
      <p className="flex items-center gap-1.5 text-xs font-medium text-sky-800">
        <Quote className="h-3.5 w-3.5" /> El cliente escribió en el cuestionario de admisión:
      </p>
      <p className="mt-0.5 whitespace-pre-wrap">{text}</p>
      {!disabled ? (
        <button type="button" className="mt-1 text-xs font-medium text-sky-800 underline hover:text-sky-950" onClick={() => onUse(`Según el cliente: “${text}”`)}>
          Usar respuesta del cliente
        </button>
      ) : null}
    </div>
  )
}

/** Append a quote to a text, on its own line. */
const withQuote = (current: string, quoted: string) => (current.trim() ? `${current.replace(/\s+$/, '')}\n${quoted}` : quoted)

/** The client's answer meant for a place in the note (`texts.x` or `group.row`). */
function answerFor(answers: IntakeClientAnswers | null, target: string): string | undefined {
  if (!answers) return undefined
  const key = (Object.entries(CLIENT_ANSWER_TARGETS).find(([, t]) => t === target) ?? [])[0] as keyof typeof CLIENT_ANSWER_TARGETS | undefined
  return key ? answers.answers[key] : undefined
}

function useIntake({ form, patch }: StepProps) {
  const intake = form.intake
  const setText = (key: IntakeTextKey, v: string) => patch({ intake: { ...intake, texts: { ...(intake.texts ?? {}), [key]: v } } })
  const setRow = (group: Group, key: string, next: Partial<IntakeRow>) => {
    const rows = (intake[group] ?? {}) as Record<string, IntakeRow>
    const cur = rows[key] ?? { marked: false, text: '' }
    patch({ intake: { ...intake, [group]: { ...rows, [key]: { ...cur, ...next } } } as IntakeForm })
  }
  const text = (key: IntakeTextKey) => intake.texts?.[key] ?? ''
  const row = (group: Group, key: string): IntakeRow => ((intake[group] ?? {}) as Record<string, IntakeRow>)[key] ?? { marked: false, text: '' }
  return { setText, setRow, text, row }
}

/** One free-text section of her form: its title, its helper line, the text, and the client's answer when there is one. */
function TextSection({ k, props, required, invalid, minRows = 4 }: { k: IntakeTextKey; props: IntakeStepProps; required?: boolean; invalid?: boolean; minRows?: number }) {
  const { text, setText } = useIntake(props)
  const [title, helper] = INTAKE_TEXTS[k]
  const id = `intake-${k}`
  return (
    <section>
      <Label htmlFor={id} className="text-sm font-semibold text-slate-900">
        {title} {required ? <span className="font-normal text-rose-600">(obligatorio para firmar)</span> : null}
      </Label>
      {helper ? <p className="mb-1 text-xs text-slate-500">{helper}</p> : null}
      <GrowingTextarea id={id} minRows={minRows} disabled={props.readOnly} value={text(k)} onChange={(v) => setText(k, v)} invalid={invalid} />
      <ClientAnswer text={answerFor(props.answers, `texts.${k}`)} disabled={props.readOnly} onUse={(q) => setText(k, withQuote(text(k), q))} />
    </section>
  )
}

/** Rows of her form with a checkbox and a text that always fits what she writes (full width, under the label). */
function RowSection({ title, hint, group, rows, check, props }: {
  title: string
  hint?: string
  group: Group
  rows: readonly (readonly [string, string])[]
  /** What the checkbox means for this section. */
  check: string
  props: IntakeStepProps
}) {
  const { row, setRow } = useIntake(props)
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {hint ? <p className="mb-2 text-xs text-slate-500">{hint}</p> : null}
      <div className="space-y-3">
        {rows.map(([key, name]) => {
          const r = row(group, key)
          const id = `intake-${group}-${key}`
          return (
            <div key={key} className={cn('rounded-lg border p-3', r.marked ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200 bg-white')}>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <Label htmlFor={id} className="text-sm font-medium text-slate-800">{name}</Label>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" className="h-4 w-4 accent-brand-600" disabled={props.readOnly} checked={r.marked} onChange={(e) => setRow(group, key, { marked: e.target.checked })} />
                  {check}
                </label>
              </div>
              <GrowingTextarea id={id} minRows={group === 'mh_history' ? 3 : 2} disabled={props.readOnly} value={r.text} onChange={(v) => setRow(group, key, { text: v })} />
              <ClientAnswer text={answerFor(props.answers, `${group}.${key}`)} disabled={props.readOnly} onUse={(q) => setRow(group, key, { text: withQuote(r.text, q) })} />
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function IntakeProblemStep(props: IntakeStepProps) {
  const missing = !(props.form.intake.texts?.presenting_problem ?? '').trim()
  return (
    <div className="space-y-6">
      <TextSection k="presenting_problem" props={props} required invalid={props.showErrors && missing} minRows={5} />
      <TextSection k="problem_history" props={props} minRows={6} />
    </div>
  )
}

export function IntakeFunctioningStep(props: IntakeStepProps) {
  return (
    <RowSection
      title="Funcionamiento actual (por áreas)"
      hint="En cada área, el dato y cómo se ha afectado. Marque las áreas afectadas."
      group="functioning"
      rows={FUNCTIONING_ROWS}
      check="Afectada"
      props={props}
    />
  )
}

export function IntakeHistoryStep(props: IntakeStepProps) {
  return (
    <div className="space-y-7">
      <RowSection
        title="Historial de salud mental"
        hint="Cada renglón crece con lo que escriba: aquí no hay límite de espacio."
        group="mh_history"
        rows={MH_HISTORY_ROWS}
        check="Aplica"
        props={props}
      />
      <TextSection k="family_mh_history" props={props} />
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-slate-900">Historial de salud física</h3>
        <TextSection k="physical_personal" props={props} minRows={3} />
        <TextSection k="physical_family" props={props} minRows={3} />
      </div>
      <RowSection title="Historial personal" group="personal_history" rows={PERSONAL_HISTORY_ROWS} check="Aplica" props={props} />
    </div>
  )
}

export function IntakeDangerStep(props: IntakeStepProps & { previous?: { level: string; date: string } | null }) {
  return (
    <div className="space-y-6">
      <TextSection k="dangerousness" props={props} minRows={5} />
      <div className="rounded-xl border border-slate-200 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Evaluación de riesgo</h3>
        <RiskStep form={props.form} patch={props.patch} readOnly={props.readOnly} showErrors={props.showErrors} previous={props.previous} lang="es" />
      </div>
      <TextSection k="protective" props={props} minRows={4} />
    </div>
  )
}

export function IntakeGoalsStep(props: IntakeStepProps) {
  const { form, patch, readOnly } = props
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-slate-900">Metas y objetivos del tratamiento</h3>
        <TextSection k="goals_short" props={props} />
        <TextSection k="goals_long" props={props} />
      </div>
      <TextSection k="expectations" props={props} />
      <section>
        <Label htmlFor="intake-dx" className="text-sm font-semibold text-slate-900">
          Impresión diagnóstica <span className="font-normal text-slate-400">(opcional)</span>
        </Label>
        <Input id="intake-dx" disabled={readOnly} placeholder="F41.1, F32.A" value={form.diagnosisCodes} onChange={(e) => patch({ diagnosisCodes: e.target.value })} />
        <p className="mt-1 text-xs text-slate-500">Códigos ICD-10-CM separados por coma. No hace falta para firmar; la superbill de esta sesión sí lo pide.</p>
      </section>
    </div>
  )
}

/** The intake's pre-sign checklist: blockers stop "Firmar", warnings only remind. */
export function intakeChecklist(form: StepProps['form'], opts: { informedConsentSigned: boolean | null }): { level: 'blocker' | 'warning'; text: string }[] {
  const items: { level: 'blocker' | 'warning'; text: string }[] = []
  if (!(form.intake.texts?.presenting_problem ?? '').trim()) items.push({ level: 'blocker', text: 'Escriba la queja / problema que presenta' })
  for (const m of riskStatus(form).missing) items.push({ level: 'blocker', text: RISK_ISSUE_TEXT_ES[m] })
  if (opts.informedConsentSigned === false) items.push({ level: 'warning', text: 'El cliente aún no ha firmado el consentimiento informado' })
  if (Object.keys(form.mse).length === 0 && form.moodRating === null) items.push({ level: 'warning', text: 'No se anotó el estado mental' })
  if (form.modality !== 'in_person' && !(form.intake.telehealth?.location ?? '').trim()) items.push({ level: 'warning', text: 'No se anotó dónde estaba el cliente durante la sesión a distancia' })
  return items
}

export function IntakeReviewStep({ form, data, signed, changeReason, onChangeReason, showReasonError, informedConsentSigned }: {
  form: StepProps['form']
  data: IntakeReportData
  signed: boolean
  changeReason: string
  onChangeReason: (v: string) => void
  showReasonError?: boolean
  informedConsentSigned: boolean | null
}) {
  const items = intakeChecklist(form, { informedConsentSigned })
  const blockers = items.filter((i) => i.level === 'blocker')
  const warnings = items.filter((i) => i.level === 'warning')
  return (
    <div className="space-y-5">
      {blockers.length > 0 ? (
        <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-900" role="alert">
          <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Esta nota todavía no se puede firmar</p>
          <ul className="mt-1 list-disc pl-6">{blockers.map((b) => <li key={b.text}>{b.text}</li>)}</ul>
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800"><CheckCircle2 className="h-4 w-4" /> Lista para firmar.</p>
      )}
      {warnings.length > 0 ? (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="flex items-center gap-2 font-medium"><Info className="h-4 w-4" /> Para revisar (no impide firmar)</p>
          <ul className="mt-1 list-disc pl-6">{warnings.map((w) => <li key={w.text}>{w.text}</li>)}</ul>
        </div>
      ) : null}
      {signed ? (
        <div>
          <Label htmlFor="change-reason">Motivo del cambio <span className="text-rose-600">(obligatorio)</span></Label>
          <Textarea
            id="change-reason"
            rows={2}
            maxLength={500}
            value={changeReason}
            onChange={(e) => onChangeReason(e.target.value)}
            placeholder="¿Por qué enmienda una nota firmada?"
            className={showReasonError && !changeReason.trim() ? 'border-rose-400 ring-2 ring-rose-200' : undefined}
          />
          <p className="mt-1 text-xs text-slate-500">El motivo queda en el historial de la nota y aparece bajo la firma.</p>
        </div>
      ) : null}
      <IntakeReport data={data} />
    </div>
  )
}

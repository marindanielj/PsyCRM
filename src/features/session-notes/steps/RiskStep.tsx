import { AlertTriangle, CheckCircle2, Phone } from 'lucide-react'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import {
  PROTECTIVE_FACTORS, RISK_ACTIONS, RISK_FACTORS, RISK_HARM_OTHERS, RISK_LEVELS, RISK_SELF_HARM, RISK_SUICIDAL, label,
} from '../../../lib/clinical-vocab'
import { cn } from '../../../lib/utils'
import { ChipGroup, ChoiceGroup } from '../ChipGroup'
import { RISK_ISSUE_TEXT, formatSessionDate, riskStatus, riskStyle } from '../note-utils'
import type { StepProps } from './step-types'

/** Local crisis lines. VERIFY these numbers before the first real client (docs/psycrm/RESULTADOS_DIA_4.md). */
export const CRISIS_RESOURCES = [
  { name: '988 Suicide & Crisis Lifeline', detail: 'Call or text 988' },
  { name: 'Línea PAS (ASSMCA)', detail: '1-800-981-0023' },
  { name: 'Emergency', detail: '911' },
] as const

/**
 * Step 3: the risk assessment — REQUIRED in every session. Nothing is pre-filled (not
 * even from the last visit: a copied-forward "denied" would claim an assessment that
 * did not happen); the previous level is shown only as a reference.
 */
export function RiskStep({ form, patch, readOnly, showErrors, previous }: StepProps & { previous?: { level: string; date: string } | null }) {
  const status = riskStatus(form)
  const bad = (issue: keyof typeof RISK_ISSUE_TEXT) => !!showErrors && status.missing.includes(issue)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5">
        <p className="text-sm font-semibold text-slate-900">Required every session</p>
        {previous ? (
          <p className="text-xs text-slate-600">
            Last signed assessment ({formatSessionDate(previous.date)}): <b>{riskStyle(previous.level).label}</b> — for reference only
          </p>
        ) : (
          <p className="text-xs text-slate-500">No previous risk assessment on record.</p>
        )}
      </div>

      <fieldset className="space-y-4">
        <legend className="mb-1 text-sm font-semibold text-slate-900">Harm to self</legend>
        <div>
          <Label>Suicidal ideation</Label>
          <ChoiceGroup ariaLabel="Suicidal ideation" options={RISK_SUICIDAL} value={form.riskSuicidal} onChange={(v) => patch({ riskSuicidal: v })} disabled={readOnly} invalid={bad('risk_suicidal')} />
        </div>
        <div>
          <Label>Self-harm</Label>
          <ChoiceGroup ariaLabel="Self-harm" options={RISK_SELF_HARM} value={form.riskSelfHarm} onChange={(v) => patch({ riskSelfHarm: v })} disabled={readOnly} invalid={bad('risk_self_harm')} />
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-semibold text-slate-900">Harm to others</legend>
        <Label>Homicidal or violent ideation</Label>
        <ChoiceGroup ariaLabel="Harm to others" options={RISK_HARM_OTHERS} value={form.riskHarmOthers} onChange={(v) => patch({ riskHarmOthers: v })} disabled={readOnly} invalid={bad('risk_harm_others')} />
      </fieldset>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <Label>Risk factors</Label>
          <ChipGroup ariaLabel="Risk factors" options={RISK_FACTORS} value={form.riskFactors} onChange={(v) => patch({ riskFactors: v })} disabled={readOnly} />
        </div>
        <div>
          <Label>Protective factors</Label>
          <ChipGroup ariaLabel="Protective factors" options={PROTECTIVE_FACTORS} value={form.protectiveFactors} onChange={(v) => patch({ protectiveFactors: v })} disabled={readOnly} />
        </div>
      </div>

      <div>
        <Label>Overall risk level</Label>
        <ChoiceGroup
          ariaLabel="Overall risk level"
          options={RISK_LEVELS}
          value={form.riskLevel}
          onChange={(v) => patch({ riskLevel: v })}
          disabled={readOnly}
          invalid={bad('risk_level')}
          tone={(o) => cn('border-2', o === 'low' && 'border-emerald-700 bg-emerald-700 text-white', o === 'moderate' && 'border-amber-500 bg-amber-400 text-slate-900', o === 'high' && 'border-rose-600 bg-rose-600 text-white', o === 'imminent' && 'border-rose-900 bg-rose-800 text-white')}
        />
      </div>

      <div>
        <Label>Actions taken</Label>
        <ChipGroup ariaLabel="Actions taken" options={RISK_ACTIONS} exclusive={['none']} value={form.riskActions} onChange={(v) => patch({ riskActions: v })} disabled={readOnly} invalid={bad('risk_actions')} />
        <p className="mt-1 text-xs text-slate-500">Choose “None” only if no action was needed; it cannot be combined with another action.</p>
      </div>

      <div>
        <Label htmlFor="risk-notes">
          Clinical rationale {status.elevated || status.anyPositive ? <span className="text-rose-600">(required)</span> : <span className="text-slate-400">(optional)</span>}
        </Label>
        <Textarea
          id="risk-notes"
          rows={4}
          disabled={readOnly}
          maxLength={5000}
          value={form.riskNotes}
          onChange={(e) => patch({ riskNotes: e.target.value })}
          className={cn(bad('risk_notes') && 'border-rose-400 ring-2 ring-rose-200')}
          placeholder="Why this level? What was discussed, agreed or arranged?"
        />
      </div>

      {status.elevated || status.anyPositive ? (
        <aside role="note" className="rounded-xl border-2 border-rose-300 bg-rose-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-rose-800">
            <AlertTriangle className="h-4 w-4" /> Follow your crisis protocol
          </p>
          <ul className="mt-2 space-y-1 text-sm text-rose-900">
            {CRISIS_RESOURCES.map((r) => (
              <li key={r.name} className="flex items-center gap-2">
                <Phone className="h-3.5 w-3.5 shrink-0" />
                <span>
                  <b>{r.name}:</b> {r.detail}
                </span>
              </li>
            ))}
          </ul>
          {status.elevated ? <p className="mt-2 text-xs text-rose-800">A rationale and at least one action are required to sign. Signing creates a follow-up task.</p> : null}
        </aside>
      ) : null}

      <div className={cn('flex items-start gap-2 rounded-lg px-4 py-3 text-sm', status.complete ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900')}>
        {status.complete ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
        <div>
          {status.complete ? (
            <p>
              Risk assessment complete: <b>{label(form.riskLevel ?? '')}</b>.
            </p>
          ) : (
            <>
              <p className="font-medium">Still needed before you can sign:</p>
              <ul className="list-disc pl-5">
                {status.missing.map((m) => (
                  <li key={m}>{RISK_ISSUE_TEXT[m]}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

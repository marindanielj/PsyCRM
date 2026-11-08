import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import { INTERVENTIONS } from '../../../lib/clinical-vocab'
import { ChipGroup } from '../ChipGroup'
import { mseSummary } from '../note-utils'
import type { StepProps } from './step-types'

const GUIDE = {
  data: ['What themes did the client bring today?', 'Any events since the last session?', 'What did you observe (behavior, presentation, engagement)?'],
  assessment: ['How does this relate to the treatment goals?', 'Progress, stalling or regression?', 'Any change in risk or functioning?'],
  plan: ['Homework and interventions for next session', 'Frequency and next appointment', 'Referrals, coordination of care'],
}

function Guide({ items }: { items: string[] }) {
  return (
    <details className="mb-2 text-xs text-slate-600">
      <summary className="cursor-pointer select-none text-brand-700">Guiding questions</summary>
      <ul className="mt-1 list-disc pl-5">
        {items.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ul>
    </details>
  )
}

/** Step 4: the DAP note itself, plus the interventions used and optional diagnosis codes. */
export function DapStep({ form, patch, readOnly }: StepProps) {
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-slate-900">Data</h3>
        <Guide items={GUIDE.data} />
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <Label htmlFor="dap-s">Subjective — what the client reports</Label>
            <Textarea id="dap-s" rows={7} disabled={readOnly} maxLength={20000} value={form.dataSubjective} onChange={(e) => patch({ dataSubjective: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="dap-o">Objective — what you observed</Label>
            <Textarea id="dap-o" rows={7} disabled={readOnly} maxLength={20000} value={form.dataObjective} onChange={(e) => patch({ dataObjective: e.target.value })} />
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-slate-900">Assessment</h3>
        <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700" aria-label="Recap of mental status and risk">
          {mseSummary(form)}
        </p>
        <Guide items={GUIDE.assessment} />
        <Textarea id="dap-a" rows={6} disabled={readOnly} maxLength={20000} value={form.assessment} onChange={(e) => patch({ assessment: e.target.value })} aria-label="Assessment" />
      </section>

      <section>
        <h3 className="text-sm font-semibold text-slate-900">Plan</h3>
        <Guide items={GUIDE.plan} />
        <Textarea id="dap-p" rows={5} disabled={readOnly} maxLength={20000} value={form.plan} onChange={(e) => patch({ plan: e.target.value })} aria-label="Plan" />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div>
          <Label>Interventions used</Label>
          <ChipGroup ariaLabel="Interventions" options={INTERVENTIONS} value={form.interventions} onChange={(v) => patch({ interventions: v })} disabled={readOnly} />
        </div>
        <div>
          <Label htmlFor="dap-dx">Diagnosis codes (optional)</Label>
          <Input id="dap-dx" disabled={readOnly} placeholder="F41.1, F32.A" value={form.diagnosisCodes} onChange={(e) => patch({ diagnosisCodes: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">ICD-10 / DSM-5-TR codes separated by commas.</p>
        </div>
      </section>
    </div>
  )
}

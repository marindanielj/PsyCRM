import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import { NoteReport } from '../NoteReport'
import { type NoteForm, reviewChecklist } from '../note-utils'
import type { ReportModel } from '../report-model'

/** Step 5: the checklist, the report preview and — for an already-signed note — the reason for the change. */
export function ReviewStep({
  form,
  model,
  signed,
  changeReason,
  onChangeReason,
  showReasonError,
}: {
  form: NoteForm
  model: ReportModel
  /** Editing a note that is already signed: a reason is mandatory. */
  signed: boolean
  changeReason: string
  onChangeReason: (v: string) => void
  showReasonError?: boolean
}) {
  const items = reviewChecklist(form)
  const blockers = items.filter((i) => i.level === 'blocker')
  const warnings = items.filter((i) => i.level === 'warning')
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        {blockers.length > 0 ? (
          <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-900" role="alert">
            <p className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" /> This note can’t be signed yet
            </p>
            <ul className="mt-1 list-disc pl-6">
              {blockers.map((b) => (
                <li key={b.text}>{b.text}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            <CheckCircle2 className="h-4 w-4" /> The risk assessment is complete — ready to sign.
          </p>
        )}
        {warnings.length > 0 ? (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="flex items-center gap-2 font-medium">
              <Info className="h-4 w-4" /> Worth a look (won’t stop you)
            </p>
            <ul className="mt-1 list-disc pl-6">
              {warnings.map((w) => (
                <li key={w.text}>{w.text}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {signed ? (
        <div>
          <Label htmlFor="change-reason">
            Reason for this change <span className="text-rose-600">(required)</span>
          </Label>
          <Textarea
            id="change-reason"
            rows={2}
            maxLength={500}
            value={changeReason}
            onChange={(e) => onChangeReason(e.target.value)}
            placeholder="Why are you amending a signed note?"
            className={showReasonError && !changeReason.trim() ? 'border-rose-400 ring-2 ring-rose-200' : undefined}
          />
          <p className="mt-1 text-xs text-slate-500">The reason is kept in the note’s history and shown under the signature.</p>
        </div>
      ) : null}

      <NoteReport model={model} />
    </div>
  )
}

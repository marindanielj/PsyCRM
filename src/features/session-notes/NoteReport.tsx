import { label } from '../../lib/clinical-vocab'
import { cn } from '../../lib/utils'
import './note-print.css'
import type { ReportModel } from './report-model'
import { riskStyle } from './note-utils'

/**
 * The session note as a report: what the clinician reads when she "opens" a note and what
 * she prints or saves as a PDF. Read-only by design; editing happens in the wizard.
 * `model.preview` marks the on-screen preview of an unsaved note (step 5).
 */
export function NoteReport({ model, printedBy, className }: { model: ReportModel; printedBy?: string | null; className?: string }) {
  const { practice: p, client, session, risk } = model
  const style = riskStyle(risk.level)
  return (
    <article className={cn('note-report mx-auto max-w-[8.5in] rounded-xl border border-slate-200 bg-white p-8 text-slate-900 shadow-sm', className)} aria-label="Session note report">
      <div className="note-body">
        {/* Letterhead */}
        <header className="note-keep border-b-2 border-slate-800 pb-3 text-center">
          <h1 className="text-xl font-bold tracking-wide">{p.name || 'Practice name'}</h1>
          <p className="text-sm">{[p.therapist, p.license && `Lic. ${p.license}`].filter(Boolean).join(' · ')}</p>
          <p className="text-xs text-slate-600">{[p.address, p.phone, p.email].filter(Boolean).join(' · ')}</p>
        </header>
        <p className="mt-2 border-y border-slate-300 bg-slate-100 py-1 text-center text-[11px] font-bold uppercase tracking-widest text-slate-700">
          Confidential – Protected Health Information
        </p>

        {model.preview ? (
          <p className="ol-noprint mt-3 rounded bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-800">
            Preview of an unsigned note — this is how it will read once signed.
          </p>
        ) : null}

        {/* Client + session */}
        <section className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <Field k="Client" v={client.name} />
          <Field k="Date of birth" v={client.dob ?? '—'} />
          <Field k="Session date" v={session.date} />
          <Field k="Time" v={[session.time, session.duration].filter(Boolean).join(' · ') || '—'} />
          <Field k="Session type" v={session.type} />
          <Field k="Modality" v={session.modality} />
          <Field k="Client ID" v={client.shortId} />
          <Field k="Status" v={model.status === 'signed' ? 'Signed' : 'Draft (not signed)'} />
        </section>

        {/* Mental status */}
        <section className="mt-5">
          <H>Mental status</H>
          <p className="text-sm">
            <b>Mood (client’s words):</b> {model.mood.reported ?? '—'} &nbsp;·&nbsp; <b>Mood rating:</b> {model.mood.rating === null ? '—' : `${model.mood.rating}/10`}
          </p>
          {model.mseRows.length > 0 ? (
            <table className="mt-2 w-full border-collapse text-sm">
              <tbody>
                {model.mseRows.map((r) => (
                  <tr key={r.domain} className="border-b border-slate-200 align-top">
                    <th className="w-44 py-1 pr-3 text-left font-semibold">{r.domain}</th>
                    <td className="py-1">
                      {r.values}
                      {r.note ? <span className="text-slate-600"> — {r.note}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-1 text-sm text-slate-500">No mental status findings recorded.</p>
          )}
        </section>

        {/* Risk: ALWAYS present */}
        <section className={cn('mt-5 rounded-md border-2 p-3', style.box)}>
          <H>Risk assessment</H>
          <p className="text-sm">
            <b>Overall level:</b>{' '}
            <span className={cn('rounded px-1.5 py-0.5 font-semibold ring-1', style.badge)}>{style.label}</span>
          </p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-sm">
            <dt className="font-semibold">Suicidal ideation</dt>
            <dd>{risk.suicidal ? label(risk.suicidal) : <Missing />}</dd>
            <dt className="font-semibold">Self-harm</dt>
            <dd>{risk.selfHarm ? label(risk.selfHarm) : <Missing />}</dd>
            <dt className="font-semibold">Harm to others</dt>
            <dd>{risk.harmOthers ? label(risk.harmOthers) : <Missing />}</dd>
            <dt className="font-semibold">Risk factors</dt>
            <dd>{list(risk.factors)}</dd>
            <dt className="font-semibold">Protective factors</dt>
            <dd>{list(risk.protective)}</dd>
            <dt className="font-semibold">Actions taken</dt>
            <dd>{list(risk.actions)}</dd>
            <dt className="font-semibold">Clinical rationale</dt>
            <dd className="whitespace-pre-wrap">{risk.rationale ?? '—'}</dd>
          </dl>
        </section>

        {/* DAP */}
        <section className="mt-5">
          <H>Data</H>
          <Sub k="Subjective (client report)" v={model.dap.subjective} />
          <Sub k="Objective (clinician observations)" v={model.dap.objective} />
        </section>
        <section className="mt-4">
          <H>Assessment</H>
          <Text v={model.dap.assessment} />
        </section>
        <section className="mt-4">
          <H>Plan</H>
          <Text v={model.dap.plan} />
        </section>

        {model.interventions.length > 0 || model.diagnoses.length > 0 ? (
          <section className="mt-4 text-sm">
            {model.interventions.length > 0 ? (
              <p>
                <b>Interventions:</b> {list(model.interventions)}
              </p>
            ) : null}
            {model.diagnoses.length > 0 ? (
              <p>
                <b>Diagnosis codes:</b> {model.diagnoses.join(', ')}
              </p>
            ) : null}
          </section>
        ) : null}

        {/* Signature */}
        <section className="note-keep note-sign mt-6 border-t border-slate-400 pt-3 text-sm">
          {model.signature ? (
            <>
              <p className="font-semibold">{model.signature.line}</p>
              {model.signature.late ? <p className="text-xs italic text-slate-600">(Signed after the 72-hour editing window.)</p> : null}
              {model.amended ? <p className="text-xs text-slate-600">{model.amended}</p> : null}
            </>
          ) : (
            <p className="italic text-slate-500">Not signed.</p>
          )}
        </section>

        {/* Addenda */}
        {model.addenda.length > 0 ? (
          <section className="mt-5">
            <H>Addenda</H>
            {model.addenda.map((a, i) => (
              <div key={i} className="note-keep mb-2 border-l-2 border-slate-300 pl-3 text-sm">
                <p className="whitespace-pre-wrap">{a.body}</p>
                <p className="text-xs text-slate-500">
                  Added by {a.by} on {a.when}
                </p>
              </div>
            ))}
          </section>
        ) : null}
      </div>

      <footer className="note-footer mt-6 text-center text-[10px] text-slate-500">
        {model.noteId ? `Note ${model.noteId}` : 'Unsaved note'} · Client {client.shortId}
        {printedBy ? ` · Printed ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Puerto_Rico' }).format(new Date())} by ${printedBy}` : ''}
      </footer>
    </article>
  )
}

const list = (items: readonly string[]) => (items.length ? items.map(label).join(', ') : '—')
const H = ({ children }: { children: React.ReactNode }) => <h2 className="mb-1 border-b border-slate-300 text-[13px] font-bold uppercase tracking-wide">{children}</h2>
const Field = ({ k, v }: { k: string; v: string }) => (
  <p>
    <span className="font-semibold">{k}:</span> {v}
  </p>
)
const Missing = () => <span className="font-semibold text-rose-700">Not answered</span>
const Text = ({ v }: { v: string | null }) => (v ? <p className="whitespace-pre-wrap text-sm">{v}</p> : <p className="text-sm text-slate-500">—</p>)
const Sub = ({ k, v }: { k: string; v: string | null }) => (
  <div className="mb-1">
    <p className="text-xs font-semibold uppercase text-slate-500">{k}</p>
    <Text v={v} />
  </div>
)

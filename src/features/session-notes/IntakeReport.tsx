import type { PracticeProfile } from '../../lib/api'
import { MSE_DOMAIN_KEYS } from '../../lib/clinical-vocab'
import {
  FUNCTIONING_ROWS, INTAKE_TEXTS, type IntakeForm, type IntakeRow, type IntakeTextKey, MH_HISTORY_ROWS, PERSONAL_HISTORY_ROWS, labelEs,
} from '../../lib/intake-form'
import { PracticeLogo } from '../billing/PracticeLogo'
import { cn } from '../../lib/utils'
import './note-print.css'
import { riskStyle } from './note-utils'

/** What the intake report shows, from a saved note or from the form on screen. */
export interface IntakeReportData {
  loc: string
  practice: PracticeProfile
  client: { id: string; name: string; dateOfBirth: string | null }
  noteId: string | null
  status: 'draft' | 'signed'
  preview?: boolean
  sessionDate: string
  startTime: string | null
  durationMin: number | null
  modality: string
  intake: IntakeForm
  mse: Record<string, unknown>
  moodRating: number | null
  risk: {
    level: string | null
    suicidal: string | null
    selfHarm: string | null
    harmOthers: string | null
    factors: string[]
    protective: string[]
    actions: string[]
    rationale: string | null
  }
  diagnoses: string[]
  signature: { name: string; license: string; at: string; late: boolean } | null
  amended: { at: string; reason: string } | null
  addenda: { body: string; author: string; at: string }[]
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
/** `2026-11-05` -> `5 de noviembre de 2026`, read from the text so no time zone moves the day. */
export function fechaEs(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '')
  return m ? `${Number(m[3])} de ${MONTHS[Number(m[2]) - 1]} de ${m[1]}` : (ymd ?? '')
}
const sello = (iso: string) =>
  new Intl.DateTimeFormat('es-PR', { timeZone: 'America/Puerto_Rico', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))

/**
 * The intake note as she reads and prints it: her letterhead and logo, "Nota de Entrevista Inicial", and the sections of her
 * paper form in the same order. Texts take the room they need (a long history runs onto the next page); empty rows are
 * left out. The risk assessment is always printed.
 */
export function IntakeReport({ data, printedBy, className }: { data: IntakeReportData; printedBy?: string | null; className?: string }) {
  const { practice: p, intake, risk } = data
  const text = (k: IntakeTextKey) => (intake.texts?.[k] ?? '').trim()
  const tele = intake.telehealth
  const style = riskStyle(risk.level)
  const mse = data.mse as Record<string, { values?: string[]; note?: string } | string | undefined>
  const mseRows = MSE_DOMAIN_KEYS.flatMap((key) => {
    const e = mse[key]
    if (!e || typeof e !== 'object' || ((e.values?.length ?? 0) === 0 && !e.note)) return []
    return [{ key, values: (e.values ?? []).map(labelEs).join(', ') || '—', note: e.note?.trim() || null }]
  })
  const moodReported = typeof mse.mood_reported === 'string' ? mse.mood_reported : null

  return (
    <article lang="es" className={cn('note-report intake-report mx-auto max-w-[8.5in] rounded-xl border border-slate-200 bg-white p-8 text-slate-900 shadow-sm', className)} aria-label="Nota de Entrevista Inicial">
      <div className="note-body">
        <header className="note-keep flex items-start justify-between gap-4 border-b border-slate-300 pb-3">
          <div className="flex items-center gap-3">
            <PracticeLogo loc={data.loc} />
            <div>
              <p className="text-lg font-semibold text-slate-800">{p.therapist || p.name}</p>
              {p.therapist && p.name ? <p className="text-xs uppercase tracking-widest text-slate-500">{p.name}</p> : null}
              {p.license ? <p className="text-xs text-slate-500">Lic. {p.license}</p> : null}
            </div>
          </div>
          <div className="text-right">
            <h1 className="text-lg font-bold text-slate-800">Nota de Entrevista Inicial</h1>
            <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Confidencial</p>
          </div>
        </header>

        {data.preview ? (
          <p className="ol-noprint mt-3 rounded bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-800">Vista previa de una nota sin firmar: así se leerá una vez firmada.</p>
        ) : null}

        <section className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <F k="Cliente" v={data.client.name} />
          <F k="Fecha de nacimiento" v={data.client.dateOfBirth ? fechaEs(data.client.dateOfBirth) : '—'} />
          <F k="Fecha" v={fechaEs(data.sessionDate)} />
          <F k="Hora" v={[data.startTime?.slice(0, 5), data.durationMin ? `${data.durationMin} min` : null].filter(Boolean).join(' · ') || '—'} />
          <F k="Modalidad" v={labelEs(data.modality)} />
          <F k="Estado" v={data.status === 'signed' ? 'Firmada' : 'Borrador (sin firmar)'} />
          {data.modality !== 'in_person' && tele ? (
            <p className="col-span-2">
              <b>Sesión a distancia:</b> {tele.location || 'ubicación no anotada'}
              {tele.in_pr !== null ? ` · ${tele.in_pr ? 'en Puerto Rico' : 'fuera de Puerto Rico'}` : ''}
              {tele.private_setting !== null ? ` · ${tele.private_setting ? 'lugar privado' : 'lugar no privado'}` : ''}
            </p>
          ) : null}
        </section>

        <TextBlock title={INTAKE_TEXTS.presenting_problem[0]} sub={INTAKE_TEXTS.presenting_problem[1]} v={text('presenting_problem')} always />
        <TextBlock title={INTAKE_TEXTS.problem_history[0]} sub={INTAKE_TEXTS.problem_history[1]} v={text('problem_history')} />
        <Rows title="Funcionamiento actual (por áreas)" rows={FUNCTIONING_ROWS} values={intake.functioning} mark="afectada" />
        <Rows title="Historial de salud mental" rows={MH_HISTORY_ROWS} values={intake.mh_history} />
        <TextBlock title={INTAKE_TEXTS.family_mh_history[0]} sub={INTAKE_TEXTS.family_mh_history[1]} v={text('family_mh_history')} />
        {text('physical_personal') || text('physical_family') ? (
          <section className="mt-5">
            <H>Historial de salud física</H>
            {text('physical_personal') ? <Sub k="Personal" v={text('physical_personal')} /> : null}
            {text('physical_family') ? <Sub k="Familiar" v={text('physical_family')} /> : null}
          </section>
        ) : null}
        <Rows title="Historial personal" rows={PERSONAL_HISTORY_ROWS} values={intake.personal_history} />

        {mseRows.length > 0 || moodReported || data.moodRating !== null ? (
          <section className="mt-5">
            <H>Estado mental</H>
            <p className="text-sm">
              <b>Ánimo (palabras del cliente):</b> {moodReported ?? '—'} &nbsp;·&nbsp; <b>Escala de ánimo:</b> {data.moodRating === null ? '—' : `${data.moodRating}/10`}
            </p>
            {mseRows.length > 0 ? (
              <table className="mt-2 w-full border-collapse text-sm">
                <tbody>
                  {mseRows.map((r) => (
                    <tr key={r.key} className="border-b border-slate-200 align-top">
                      <th className="w-48 py-1 pr-3 text-left font-semibold">{labelEs(r.key)}</th>
                      <td className="py-1">
                        {r.values}
                        {r.note ? <span className="text-slate-600"> — {r.note}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>
        ) : null}

        <TextBlock title={INTAKE_TEXTS.dangerousness[0]} sub={INTAKE_TEXTS.dangerousness[1]} v={text('dangerousness')} />
        {/* The structured risk assessment is always printed. */}
        <section className={cn('note-keep mt-4 rounded-md border-2 p-3', style.box)}>
          <H>Evaluación de riesgo</H>
          <p className="text-sm">
            <b>Nivel global:</b> <span className={cn('rounded px-1.5 py-0.5 font-semibold ring-1', style.badge)}>{risk.level ? labelEs(risk.level) : 'Sin evaluar'}</span>
          </p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-sm">
            <dt className="font-semibold">Ideación suicida</dt>
            <dd>{risk.suicidal ? labelEs(risk.suicidal) : <Missing />}</dd>
            <dt className="font-semibold">Autolesión</dt>
            <dd>{risk.selfHarm ? labelEs(risk.selfHarm) : <Missing />}</dd>
            <dt className="font-semibold">Daño a otros</dt>
            <dd>{risk.harmOthers ? labelEs(risk.harmOthers) : <Missing />}</dd>
            <dt className="font-semibold">Factores de riesgo</dt>
            <dd>{list(risk.factors)}</dd>
            <dt className="font-semibold">Factores protectores</dt>
            <dd>{list(risk.protective)}</dd>
            <dt className="font-semibold">Acciones tomadas</dt>
            <dd>{list(risk.actions)}</dd>
            <dt className="font-semibold">Fundamento clínico</dt>
            <dd className="whitespace-pre-wrap">{risk.rationale ?? '—'}</dd>
          </dl>
        </section>
        <TextBlock title={INTAKE_TEXTS.protective[0]} sub={INTAKE_TEXTS.protective[1]} v={text('protective')} />

        {text('goals_short') || text('goals_long') ? (
          <section className="mt-5">
            <H>Metas y objetivos del tratamiento</H>
            {text('goals_short') ? <Sub k="Corto plazo (3 meses)" v={text('goals_short')} /> : null}
            {text('goals_long') ? <Sub k="Largo plazo (6 meses)" v={text('goals_long')} /> : null}
          </section>
        ) : null}
        <TextBlock title={INTAKE_TEXTS.expectations[0]} v={text('expectations')} />
        {data.diagnoses.length > 0 ? (
          <section className="mt-5 text-sm">
            <H>Impresión diagnóstica</H>
            <p className="font-mono">{data.diagnoses.join(', ')}</p>
          </section>
        ) : null}

        <section className="note-keep note-sign mt-6 border-t border-slate-400 pt-3 text-sm">
          {data.signature ? (
            <>
              <p className="font-semibold">
                Firmado electrónicamente por {data.signature.name}
                {data.signature.license ? `, ${data.signature.license}` : ''}, el {sello(data.signature.at)}
              </p>
              {data.signature.late ? <p className="text-xs italic text-slate-600">(Firmada después de las 72 horas de edición.)</p> : null}
              {data.amended ? <p className="text-xs text-slate-600">Última enmienda {sello(data.amended.at)}. Motivo: {data.amended.reason}</p> : null}
            </>
          ) : (
            <p className="italic text-slate-500">Sin firmar.</p>
          )}
        </section>

        {data.addenda.length > 0 ? (
          <section className="mt-5">
            <H>Anexos</H>
            {data.addenda.map((a, i) => (
              <div key={i} className="note-keep mb-2 border-l-2 border-slate-300 pl-3 text-sm">
                <p className="whitespace-pre-wrap">{a.body}</p>
                <p className="text-xs text-slate-500">
                  Añadido por {a.author} el {sello(a.at)}
                </p>
              </div>
            ))}
          </section>
        ) : null}
      </div>

      <footer className="note-footer mt-6 text-center text-[10px] text-slate-500">
        Confidencial · {data.noteId ? `Nota ${data.noteId}` : 'Nota sin guardar'} · Cliente {data.client.id.slice(0, 8)}
        {printedBy ? ` · Impresa el ${sello(new Date().toISOString())} por ${printedBy}` : ''}
      </footer>
    </article>
  )
}

const list = (items: readonly string[]) => (items.length ? items.map(labelEs).join(', ') : '—')
const H = ({ children }: { children: React.ReactNode }) => <h2 className="mb-1 border-b border-slate-300 text-[13px] font-bold uppercase tracking-wide text-slate-800">{children}</h2>
const F = ({ k, v }: { k: string; v: string }) => (
  <p>
    <span className="font-semibold">{k}:</span> {v}
  </p>
)
const Missing = () => <span className="font-semibold text-rose-700">Sin contestar</span>
const Sub = ({ k, v }: { k: string; v: string }) => (
  <div className="mb-2">
    <p className="text-xs font-semibold uppercase text-slate-500">{k}</p>
    <p className="whitespace-pre-wrap text-sm">{v}</p>
  </div>
)

/** A free-text section; left out when empty unless `always`. */
function TextBlock({ title, sub, v, always }: { title: string; sub?: string; v: string; always?: boolean }) {
  if (!v && !always) return null
  return (
    <section className="mt-5">
      <H>{title}</H>
      {sub ? <p className="mb-1 text-xs text-slate-500">{sub}</p> : null}
      {v ? <p className="whitespace-pre-wrap text-sm">{v}</p> : <p className="text-sm text-slate-500">—</p>}
    </section>
  )
}

/** Rows with a checkbox; only the rows with content are printed. */
function Rows({ title, rows, values, mark }: { title: string; rows: readonly (readonly [string, string])[]; values?: Partial<Record<string, IntakeRow>>; mark?: string }) {
  const filled = rows.filter(([k]) => {
    const r = values?.[k]
    return r && (r.marked || r.text.trim())
  })
  if (filled.length === 0) return null
  return (
    <section className="mt-5">
      <H>{title}</H>
      <div className="space-y-2">
        {filled.map(([k, name]) => {
          const r = values![k]!
          return (
            <div key={k} className="text-sm">
              <p className="font-semibold">
                {r.marked ? '☑' : '☐'} {name}
                {r.marked && mark ? <span className="font-normal text-slate-500"> ({mark})</span> : null}
              </p>
              {r.text.trim() ? <p className="whitespace-pre-wrap pl-5">{r.text}</p> : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

import type { NoteAddendum, NoteRevisionMeta, PracticeProfile, SessionNote } from '../../lib/api'
import { MSE_DOMAIN_KEYS, MSE_DOMAIN_LABELS, label } from '../../lib/clinical-vocab'
import { type NoteForm, formToInput, formatSessionDate, formatStamp } from './note-utils'

/** The fields of a note the report shows, in one neutral shape (from a saved note OR from the unsaved form). */
export interface ReportFields {
  sessionDate: string
  startTime: string | null
  durationMin: number | null
  modality: string
  sessionType: string
  mse: Record<string, unknown>
  moodRating: number | null
  riskSuicidal: string | null
  riskSelfHarm: string | null
  riskHarmOthers: string | null
  riskLevel: string | null
  riskFactors: string[]
  protectiveFactors: string[]
  riskActions: string[]
  riskNotes: string | null
  dataSubjective: string | null
  dataObjective: string | null
  assessment: string | null
  plan: string | null
  interventions: string[]
  diagnosisCodes: string[]
}

export function fieldsFromNote(n: SessionNote): ReportFields {
  return {
    sessionDate: n.session_date, startTime: n.start_time, durationMin: n.duration_min, modality: n.modality, sessionType: n.session_type,
    mse: n.mse as Record<string, unknown>, moodRating: n.mood_rating,
    riskSuicidal: n.risk_suicidal, riskSelfHarm: n.risk_self_harm, riskHarmOthers: n.risk_harm_others, riskLevel: n.risk_level,
    riskFactors: n.risk_factors, protectiveFactors: n.protective_factors, riskActions: n.risk_actions, riskNotes: n.risk_notes,
    dataSubjective: n.data_subjective, dataObjective: n.data_objective, assessment: n.assessment, plan: n.plan,
    interventions: n.interventions, diagnosisCodes: n.diagnosis_codes,
  }
}

export function fieldsFromForm(f: NoteForm): ReportFields {
  const i = formToInput(f)
  return {
    sessionDate: f.sessionDate, startTime: i.startTime ?? null, durationMin: i.durationMin ?? null, modality: f.modality, sessionType: f.sessionType,
    mse: i.mse ?? {}, moodRating: f.moodRating,
    riskSuicidal: f.riskSuicidal, riskSelfHarm: f.riskSelfHarm, riskHarmOthers: f.riskHarmOthers, riskLevel: f.riskLevel,
    riskFactors: f.riskFactors, protectiveFactors: f.protectiveFactors, riskActions: f.riskActions, riskNotes: i.riskNotes ?? null,
    dataSubjective: i.dataSubjective ?? null, dataObjective: i.dataObjective ?? null, assessment: i.assessment ?? null, plan: i.plan ?? null,
    interventions: f.interventions, diagnosisCodes: i.diagnosisCodes ?? [],
  }
}

export interface ReportContext {
  practice: PracticeProfile
  client: { id: string; name: string; dateOfBirth: string | null }
  noteId: string | null
  status: 'draft' | 'signed'
  /** Who signed and when (the signer's display name is resolved by the caller). */
  signature: { name: string; license: string; at: string; late: boolean } | null
  /** The last reason given for editing the note after it was signed. */
  amended: { at: string; reason: string } | null
  addenda: { body: string; author: string; at: string }[]
  /** An unsaved on-screen preview rather than the record itself. */
  preview?: boolean
}

export interface ReportModel {
  practice: PracticeProfile
  client: { id: string; name: string; dob: string | null; shortId: string }
  noteId: string | null
  status: 'draft' | 'signed'
  preview: boolean
  session: { date: string; time: string | null; duration: string | null; modality: string; type: string }
  mood: { reported: string | null; rating: number | null }
  mseRows: { domain: string; values: string; note: string | null }[]
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
  dap: { subjective: string | null; objective: string | null; assessment: string | null; plan: string | null }
  interventions: string[]
  diagnoses: string[]
  signature: { line: string; late: boolean } | null
  amended: string | null
  addenda: { body: string; by: string; when: string }[]
}

const orNull = (s: string | null | undefined) => (s && s.trim() ? s : null)

export function buildReport(f: ReportFields, ctx: ReportContext): ReportModel {
  const mse = f.mse as Record<string, { values?: string[]; note?: string } | string | undefined>
  const rows: ReportModel['mseRows'] = []
  for (const key of MSE_DOMAIN_KEYS) {
    const e = mse[key]
    if (e && typeof e === 'object' && ((e.values?.length ?? 0) > 0 || e.note)) {
      rows.push({ domain: MSE_DOMAIN_LABELS[key], values: (e.values ?? []).map(label).join(', ') || '—', note: orNull(e.note) })
    }
  }
  return {
    practice: ctx.practice,
    client: { id: ctx.client.id, name: ctx.client.name, dob: ctx.client.dateOfBirth ? formatSessionDate(ctx.client.dateOfBirth) : null, shortId: ctx.client.id.slice(0, 8) },
    noteId: ctx.noteId,
    status: ctx.status,
    preview: ctx.preview === true,
    session: {
      date: formatSessionDate(f.sessionDate),
      time: f.startTime ? f.startTime.slice(0, 5) : null,
      duration: f.durationMin ? `${f.durationMin} min` : null,
      modality: label(f.modality),
      type: label(f.sessionType),
    },
    mood: { reported: typeof mse.mood_reported === 'string' ? orNull(mse.mood_reported) : null, rating: f.moodRating },
    mseRows: rows,
    risk: {
      level: f.riskLevel, suicidal: f.riskSuicidal, selfHarm: f.riskSelfHarm, harmOthers: f.riskHarmOthers,
      factors: f.riskFactors, protective: f.protectiveFactors, actions: f.riskActions, rationale: orNull(f.riskNotes),
    },
    dap: { subjective: orNull(f.dataSubjective), objective: orNull(f.dataObjective), assessment: orNull(f.assessment), plan: orNull(f.plan) },
    interventions: f.interventions,
    diagnoses: f.diagnosisCodes,
    signature: ctx.signature
      ? {
          line: `Electronically signed by ${ctx.signature.name}${ctx.signature.license ? `, ${ctx.signature.license}` : ''}, on ${formatStamp(ctx.signature.at)}`,
          late: ctx.signature.late,
        }
      : null,
    amended: ctx.amended ? `Last amended ${formatStamp(ctx.amended.at)} — reason: ${ctx.amended.reason}` : null,
    addenda: ctx.addenda.map((a) => ({ body: a.body, by: a.author, when: formatStamp(a.at) })),
  }
}

/** The most recent reason recorded for editing a note, if any (shown under the signature). */
export function lastAmendment(revisions: NoteRevisionMeta[]): { at: string; reason: string } | null {
  for (let i = revisions.length - 1; i >= 0; i--) {
    const r = revisions[i]!
    if (r.kind === 'update' && r.change_reason) return { at: r.changed_at, reason: r.change_reason }
  }
  return null
}

export function addendaForReport(addenda: NoteAddendum[]): ReportContext['addenda'] {
  return addenda.map((a) => ({ body: a.body, author: a.author_name ?? 'Staff', at: a.created_at }))
}

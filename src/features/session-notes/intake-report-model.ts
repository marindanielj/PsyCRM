import type { PracticeProfile, SessionNote } from '../../lib/api'
import type { IntakeReportData } from './IntakeReport'
import { type NoteForm, formToInput, intakeToInput } from './note-utils'
import type { ReportContext } from './report-model'

type Ctx = Pick<ReportContext, 'noteId' | 'status' | 'signature' | 'amended' | 'addenda' | 'preview'> & {
  loc: string
  practice: PracticeProfile
  client: { id: string; name: string; dateOfBirth: string | null }
}

/** The intake report from a saved note. */
export function intakeDataFromNote(n: SessionNote, ctx: Ctx): IntakeReportData {
  return {
    ...ctx,
    sessionDate: n.session_date, startTime: n.start_time, durationMin: n.duration_min, modality: n.modality,
    intake: n.intake ?? {}, mse: n.mse as Record<string, unknown>, moodRating: n.mood_rating,
    risk: {
      level: n.risk_level, suicidal: n.risk_suicidal, selfHarm: n.risk_self_harm, harmOthers: n.risk_harm_others,
      factors: n.risk_factors, protective: n.protective_factors, actions: n.risk_actions, rationale: n.risk_notes,
    },
    diagnoses: n.diagnosis_codes,
  }
}

/** The intake report from the form on screen (the preview before signing). */
export function intakeDataFromForm(f: NoteForm, ctx: Ctx): IntakeReportData {
  const i = formToInput(f)
  return {
    ...ctx,
    sessionDate: f.sessionDate, startTime: i.startTime ?? null, durationMin: i.durationMin ?? null, modality: f.modality,
    intake: intakeToInput(f.intake), mse: i.mse ?? {}, moodRating: f.moodRating,
    risk: {
      level: f.riskLevel, suicidal: f.riskSuicidal, selfHarm: f.riskSelfHarm, harmOthers: f.riskHarmOthers,
      factors: f.riskFactors, protective: f.protectiveFactors, actions: f.riskActions, rationale: i.riskNotes ?? null,
    },
    diagnoses: i.diagnosisCodes ?? [],
  }
}

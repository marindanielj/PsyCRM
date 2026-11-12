import type { SessionNote, SessionNoteInput } from '../../lib/api'
import {
  MSE_DOMAIN_KEYS, MSE_DOMAIN_LABELS, type MseDomain, type RiskIssue, label, validateRiskForSign,
} from '../../lib/clinical-vocab'
import { PRACTICE_TZ, todayInPractice } from '../../lib/age'
import type { IntakeForm } from '../../lib/intake-form'

/** Everything in this file is pure (no React, no network): the rules the wizard and the report share. */

// ---- the 72 h window -----------------------------------------------------------------

const HOUR = 3_600_000
const MINUTE = 60_000

/** "2d 14h left", "5h 20m left", "42m left", "Locked". */
export function formatLockRemaining(ms: number): string {
  if (ms <= 0) return 'Locked'
  const days = Math.floor(ms / (24 * HOUR))
  const hours = Math.floor((ms % (24 * HOUR)) / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  if (days > 0) return `${days}d ${hours}h left`
  if (hours > 0) return `${hours}h ${minutes}m left`
  return `${Math.max(1, minutes)}m left`
}

export type LockTone = 'open' | 'soon' | 'locked'
/** Amber once less than a day is left. */
export function lockTone(ms: number): LockTone {
  if (ms <= 0) return 'locked'
  return ms < 24 * HOUR ? 'soon' : 'open'
}

// ---- dates (no timezone drift) ---------------------------------------------------------

/** "Thu, Nov 5, 2026" from a YYYY-MM-DD, without letting the browser's timezone shift the day. */
export function formatSessionDate(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return ymd
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** Practice-local date-time ("Nov 5, 2026, 2:03 PM AST"). */
export function formatStamp(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PRACTICE_TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso))
}

/** Today (YYYY-MM-DD) in Puerto Rico. */
export { todayInPractice }

// ---- risk presentation -----------------------------------------------------------------

/** Full static class strings so Tailwind keeps them. */
export const RISK_STYLE: Record<string, { badge: string; box: string; label: string }> = {
  low: { badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200', box: 'border-emerald-300', label: 'Low' },
  moderate: { badge: 'bg-amber-50 text-amber-800 ring-amber-300', box: 'border-amber-400', label: 'Moderate' },
  high: { badge: 'bg-rose-50 text-rose-700 ring-rose-300', box: 'border-rose-400', label: 'High' },
  imminent: { badge: 'bg-rose-600 text-white ring-rose-700', box: 'border-rose-600', label: 'Imminent' },
}
export const riskStyle = (level: string | null | undefined) => RISK_STYLE[level ?? ''] ?? { badge: 'bg-slate-100 text-slate-600 ring-slate-200', box: 'border-slate-300', label: 'Not assessed' }

/** The wording shown in the Risk step's field-by-field validation. */
export const RISK_ISSUE_TEXT: Record<RiskIssue, string> = {
  risk_suicidal: 'Answer the suicidal ideation question',
  risk_self_harm: 'Answer the self-harm question',
  risk_harm_others: 'Answer the harm-to-others question',
  risk_level: 'Choose the overall risk level',
  risk_notes: 'Write the clinical rationale',
  risk_actions: 'Record at least one action taken (or choose "none" if the level is low)',
}

// ---- the form ----------------------------------------------------------------------------

/** The editor's working copy of a note: strings are '' (never null) so inputs stay controlled. */
export interface NoteForm {
  appointmentId: string | null
  sessionDate: string
  startTime: string
  durationMin: string
  modality: string
  sessionType: string
  moodReported: string
  mse: Partial<Record<MseDomain, { values: string[]; note: string }>>
  moodRating: number | null
  riskSuicidal: string | null
  riskSelfHarm: string | null
  riskHarmOthers: string | null
  riskLevel: string | null
  riskFactors: string[]
  protectiveFactors: string[]
  riskActions: string[]
  riskNotes: string
  dataSubjective: string
  dataObjective: string
  assessment: string
  plan: string
  interventions: string[]
  diagnosisCodes: string
  /** The intake form (B11), used when the session type is intake. */
  intake: IntakeForm
  /** False only for an older intake note written as DAP, which keeps the DAP editor. */
  intakeForm: boolean
}

/** A new note: nothing assessed. The risk answers are NEVER pre-filled, not even from the last session. */
export function emptyForm(sessionDate: string, defaults: Partial<NoteForm> = {}): NoteForm {
  return {
    appointmentId: null, sessionDate, startTime: '', durationMin: '50', modality: 'in_person', sessionType: 'individual',
    moodReported: '', mse: {}, moodRating: null,
    riskSuicidal: null, riskSelfHarm: null, riskHarmOthers: null, riskLevel: null,
    riskFactors: [], protectiveFactors: [], riskActions: [], riskNotes: '',
    dataSubjective: '', dataObjective: '', assessment: '', plan: '', interventions: [], diagnosisCodes: '',
    intake: {}, intakeForm: true,
    ...defaults,
  }
}

export function formFromNote(n: SessionNote): NoteForm {
  const mse: NoteForm['mse'] = {}
  for (const key of MSE_DOMAIN_KEYS) {
    const e = n.mse[key]
    if (e && typeof e === 'object') mse[key] = { values: [...e.values], note: e.note ?? '' }
  }
  return {
    appointmentId: n.appointment_id, sessionDate: n.session_date, startTime: n.start_time?.slice(0, 5) ?? '',
    durationMin: n.duration_min === null ? '' : String(n.duration_min), modality: n.modality, sessionType: n.session_type,
    moodReported: typeof n.mse.mood_reported === 'string' ? n.mse.mood_reported : '', mse, moodRating: n.mood_rating,
    riskSuicidal: n.risk_suicidal, riskSelfHarm: n.risk_self_harm, riskHarmOthers: n.risk_harm_others, riskLevel: n.risk_level,
    riskFactors: n.risk_factors, protectiveFactors: n.protective_factors, riskActions: n.risk_actions, riskNotes: n.risk_notes ?? '',
    dataSubjective: n.data_subjective ?? '', dataObjective: n.data_objective ?? '', assessment: n.assessment ?? '', plan: n.plan ?? '',
    interventions: n.interventions, diagnosisCodes: n.diagnosis_codes.join(', '),
    intake: n.intake ?? {},
    intakeForm: !(n.session_type === 'intake' && typeof n.intake?.version !== 'number'),
  }
}

/** True when the editor shows the intake form instead of DAP. */
export const usesIntakeForm = (f: Pick<NoteForm, 'sessionType' | 'intakeForm'>) => f.sessionType === 'intake' && f.intakeForm

/** The intake form as the API takes it: no version (the server owns it), no empty rows or texts. */
export function intakeToInput(form: IntakeForm): IntakeForm {
  const out: IntakeForm = {}
  const texts = Object.fromEntries(Object.entries(form.texts ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== ''))
  if (Object.keys(texts).length) out.texts = texts
  for (const group of ['functioning', 'mh_history', 'personal_history'] as const) {
    const rows = Object.fromEntries(Object.entries(form[group] ?? {}).filter(([, r]) => r && (r.marked || r.text.trim() !== '')))
    if (Object.keys(rows).length) (out as Record<string, unknown>)[group] = rows
  }
  const t = form.telehealth
  if (t && (t.location.trim() || t.in_pr !== null || t.private_setting !== null)) out.telehealth = t
  return out
}

const blankToNull = (v: string) => (v.trim() === '' ? null : v)

/** The form as an API body (every editable field). Empty MSE domains are dropped. */
export function formToInput(f: NoteForm): SessionNoteInput {
  const mse: Record<string, unknown> = {}
  if (f.moodReported.trim()) mse.mood_reported = f.moodReported.trim()
  for (const key of MSE_DOMAIN_KEYS) {
    const e = f.mse[key]
    if (e && (e.values.length > 0 || e.note.trim())) mse[key] = e.note.trim() ? { values: e.values, note: e.note.trim() } : { values: e.values }
  }
  return {
    appointmentId: f.appointmentId, sessionDate: f.sessionDate, startTime: blankToNull(f.startTime),
    durationMin: f.durationMin.trim() === '' ? null : Number(f.durationMin), modality: f.modality, sessionType: f.sessionType,
    mse, moodRating: f.moodRating,
    riskSuicidal: f.riskSuicidal, riskSelfHarm: f.riskSelfHarm, riskHarmOthers: f.riskHarmOthers, riskLevel: f.riskLevel,
    riskFactors: f.riskFactors, protectiveFactors: f.protectiveFactors, riskActions: f.riskActions, riskNotes: blankToNull(f.riskNotes),
    dataSubjective: blankToNull(f.dataSubjective), dataObjective: blankToNull(f.dataObjective), assessment: blankToNull(f.assessment), plan: blankToNull(f.plan),
    interventions: f.interventions,
    diagnosisCodes: f.diagnosisCodes.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean),
    ...(usesIntakeForm(f) ? { intake: intakeToInput(f.intake) } : {}),
  }
}

/** Only the fields whose value differs from `base` (for autosave: send what changed, not the whole note). */
export function changedInput(base: SessionNoteInput, next: SessionNoteInput): SessionNoteInput {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(next)) if (JSON.stringify((base as Record<string, unknown>)[k]) !== JSON.stringify(v)) out[k] = v
  return out as SessionNoteInput
}

/** What the Risk step still needs, using the exact rule the server and database enforce. */
export function riskStatus(f: NoteForm): { complete: boolean; missing: RiskIssue[]; elevated: boolean; anyPositive: boolean } {
  const v = validateRiskForSign({
    risk_suicidal: f.riskSuicidal, risk_self_harm: f.riskSelfHarm, risk_harm_others: f.riskHarmOthers, risk_level: f.riskLevel,
    risk_actions: f.riskActions, risk_notes: f.riskNotes,
  })
  const elevated = f.riskLevel === 'moderate' || f.riskLevel === 'high' || f.riskLevel === 'imminent'
  const anyPositive = [f.riskSuicidal, f.riskHarmOthers].some((x) => x !== null && x !== 'denied') || (f.riskSelfHarm !== null && f.riskSelfHarm !== 'denied' && f.riskSelfHarm !== 'history')
  return { complete: v.ok, missing: v.missing, elevated, anyPositive }
}

export interface ReviewItem {
  level: 'blocker' | 'warning'
  text: string
}
/** The pre-sign checklist: blockers stop "Sign", warnings only remind. */
export function reviewChecklist(f: NoteForm): ReviewItem[] {
  const items: ReviewItem[] = []
  const r = riskStatus(f)
  for (const m of r.missing) items.push({ level: 'blocker', text: RISK_ISSUE_TEXT[m] })
  if (!f.dataSubjective.trim() && !f.dataObjective.trim()) items.push({ level: 'warning', text: 'The Data section is empty' })
  if (!f.assessment.trim()) items.push({ level: 'warning', text: 'The Assessment is empty' })
  if (!f.plan.trim()) items.push({ level: 'warning', text: 'The Plan is empty' })
  if (f.moodRating === null) items.push({ level: 'warning', text: 'No mood rating recorded' })
  return items
}

/** The one-line recap shown above the Assessment: "Mood 4/10 · Affect: Restricted, Flat · Risk: Low". */
export function mseSummary(f: NoteForm): string {
  const parts: string[] = []
  if (f.moodRating !== null) parts.push(`Mood ${f.moodRating}/10`)
  const affect = f.mse.affect?.values ?? []
  if (affect.length) parts.push(`Affect: ${affect.map(label).join(', ')}`)
  for (const key of ['thought_process', 'insight', 'judgment'] as const) {
    const v = f.mse[key]?.values ?? []
    if (v.length) parts.push(`${MSE_DOMAIN_LABELS[key]}: ${v.map(label).join(', ')}`)
  }
  parts.push(`Risk: ${riskStyle(f.riskLevel).label}`)
  return parts.join(' · ')
}

/** The "within normal limits" shortcut: fills ONLY the domains still empty (never overwrites). */
export const NORMAL_MSE: Partial<Record<MseDomain, string[]>> = {
  appearance: ['well_groomed'], behavior: ['cooperative'], speech: ['normal'], affect: ['congruent', 'full'],
  thought_process: ['logical', 'goal_directed'], thought_content: ['unremarkable'], perception: ['no_disturbance'],
  cognition: ['oriented_x4'], insight: ['good'], judgment: ['good'],
}
export function applyNormalMse(mse: NoteForm['mse']): NoteForm['mse'] {
  const out: NoteForm['mse'] = { ...mse }
  for (const [key, values] of Object.entries(NORMAL_MSE) as [MseDomain, string[]][]) {
    const cur = out[key]
    if (!cur || cur.values.length === 0) out[key] = { values: [...values], note: cur?.note ?? '' }
  }
  return out
}

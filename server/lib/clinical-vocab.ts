/**
 * The clinical vocabulary of a session note: every closed set of values the note
 * form offers, and the one definition of "is this risk assessment complete enough
 * to sign". Pure data + pure functions, so the server (Zod validation, SQL CHECK
 * generation tests) and the web (chips, the printed report) share ONE source.
 * Labels are English, the language of the therapist-facing UI.
 */

export const MODALITIES = ['in_person', 'telehealth_video', 'phone'] as const
export const SESSION_TYPES = ['intake', 'individual', 'couple', 'family', 'crisis', 'collateral'] as const

/** Mental status exam: the domains and the choices offered for each. */
export const MSE_DOMAINS = {
  appearance: ['well_groomed', 'casual', 'disheveled', 'inappropriate_dress', 'poor_hygiene'],
  behavior: ['cooperative', 'engaged', 'guarded', 'withdrawn', 'agitated', 'restless', 'psychomotor_retardation', 'poor_eye_contact'],
  speech: ['normal', 'pressured', 'slow', 'soft', 'loud', 'monotone', 'tangential_speech'],
  mood_observed: ['euthymic', 'depressed', 'anxious', 'irritable', 'euphoric', 'angry', 'tearful'],
  affect: ['congruent', 'incongruent', 'full', 'restricted', 'blunted', 'flat', 'labile'],
  thought_process: ['logical', 'goal_directed', 'circumstantial', 'tangential', 'flight_of_ideas', 'loose_associations'],
  thought_content: ['unremarkable', 'worries', 'ruminations', 'obsessions', 'delusions', 'hopelessness', 'guilt'],
  perception: ['no_disturbance', 'auditory_hallucinations', 'visual_hallucinations', 'depersonalization'],
  cognition: ['oriented_x4', 'disoriented', 'impaired_attention', 'impaired_memory'],
  insight: ['good', 'fair', 'poor'],
  judgment: ['good', 'fair', 'poor'],
} as const
export type MseDomain = keyof typeof MSE_DOMAINS
export const MSE_DOMAIN_KEYS = Object.keys(MSE_DOMAINS) as MseDomain[]

export interface MseEntry {
  values: string[]
  note?: string
}
/** `{ mood_reported?: "…client's own words…", <domain>?: { values, note? } }` */
export type Mse = { mood_reported?: string } & Partial<Record<MseDomain, MseEntry>>

// --- risk assessment ---------------------------------------------------------

export const RISK_SUICIDAL = ['denied', 'passive', 'active_no_plan', 'active_plan', 'active_plan_intent'] as const
export const RISK_SELF_HARM = ['denied', 'history', 'urges', 'recent', 'current'] as const
export const RISK_HARM_OTHERS = ['denied', 'ideation', 'ideation_plan', 'intent'] as const
export const RISK_LEVELS = ['low', 'moderate', 'high', 'imminent'] as const
export const RISK_FACTORS = [
  'prior_attempt', 'access_to_means', 'substance_use', 'isolation', 'recent_loss', 'chronic_pain_illness',
  'impulsivity', 'hopelessness', 'family_history', 'legal_financial_stress', 'abuse_history',
] as const
export const PROTECTIVE_FACTORS = [
  'social_support', 'children_dependents', 'religious_beliefs', 'engaged_in_treatment', 'future_plans',
  'coping_skills', 'pets', 'employment_school',
] as const
/** `none` means "no action was needed"; it is only valid on its own. */
export const RISK_ACTIONS = [
  'none', 'safety_plan_created', 'safety_plan_reviewed', 'means_restriction_counseling',
  'increased_session_frequency', 'emergency_contact_notified', 'crisis_line_provided', 'er_referral',
  'duty_to_warn', 'consultation',
] as const

export const INTERVENTIONS = [
  'cbt', 'dbt_skills', 'act', 'mindfulness', 'psychoeducation', 'motivational_interviewing', 'emdr',
  'supportive', 'behavioral_activation', 'exposure', 'problem_solving', 'relaxation_training',
] as const

export type RiskLevel = (typeof RISK_LEVELS)[number]

/** Moderate or worse: needs a written rationale and at least one action. */
export const ELEVATED_LEVELS: readonly RiskLevel[] = ['moderate', 'high', 'imminent']

export interface RiskFields {
  risk_suicidal: string | null
  risk_self_harm: string | null
  risk_harm_others: string | null
  risk_level: string | null
  risk_actions: readonly string[] | null
  risk_notes: string | null
}

export type RiskIssue =
  | 'risk_suicidal'
  | 'risk_self_harm'
  | 'risk_harm_others'
  | 'risk_level'
  | 'risk_notes'
  | 'risk_actions'

const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === ''

/** Any dimension other than a clear denial (self-harm history alone is a past fact, not a current sign). */
export function hasPositiveRisk(r: Pick<RiskFields, 'risk_suicidal' | 'risk_self_harm' | 'risk_harm_others'>): boolean {
  return (
    r.risk_suicidal !== 'denied' ||
    r.risk_harm_others !== 'denied' ||
    !(r.risk_self_harm === 'denied' || r.risk_self_harm === 'history')
  )
}

/**
 * What is still missing for a note to be signed. Every session is assessed, so the
 * three dimensions and the overall level are mandatory ("denied" is an explicit
 * answer; there is no "not assessed"). An elevated level needs a rationale and a
 * real action; a "low" level with any positive dimension needs a rationale too.
 * `actions` containing "none" alongside anything else is contradictory.
 *
 * The SQL CHECK constraints on session_notes enforce the same rules; this runs first
 * so the API can answer with the exact list of fields instead of a generic DB error.
 */
export function validateRiskForSign(r: RiskFields): { ok: boolean; missing: RiskIssue[] } {
  const missing: RiskIssue[] = []
  if (blank(r.risk_suicidal)) missing.push('risk_suicidal')
  if (blank(r.risk_self_harm)) missing.push('risk_self_harm')
  if (blank(r.risk_harm_others)) missing.push('risk_harm_others')
  if (blank(r.risk_level)) missing.push('risk_level')

  const actions = r.risk_actions ?? []
  const realActions = actions.filter((a) => a !== 'none')
  const level = r.risk_level as RiskLevel | null
  if (level && ELEVATED_LEVELS.includes(level)) {
    if (blank(r.risk_notes)) missing.push('risk_notes')
    if (realActions.length === 0) missing.push('risk_actions')
  } else if (level === 'low' && blank(r.risk_notes) && missing.length === 0 && hasPositiveRisk(r as never)) {
    missing.push('risk_notes')
  }
  if (actions.includes('none') && actions.length > 1 && !missing.includes('risk_actions')) missing.push('risk_actions')
  return { ok: missing.length === 0, missing }
}

/** Validate an MSE object against the vocabulary. Returns the issues (empty = valid). */
export function mseIssues(mse: unknown): string[] {
  if (mse === null || typeof mse !== 'object' || Array.isArray(mse)) return ['mse must be an object']
  const issues: string[] = []
  for (const [key, entry] of Object.entries(mse as Record<string, unknown>)) {
    if (key === 'mood_reported') {
      if (typeof entry !== 'string' || entry.length > 500) issues.push('mood_reported must be text up to 500 characters')
      continue
    }
    if (!(key in MSE_DOMAINS)) {
      issues.push(`unknown mse domain: ${key}`)
      continue
    }
    const e = entry as Partial<MseEntry> | null
    if (!e || typeof e !== 'object' || !Array.isArray(e.values)) {
      issues.push(`${key}: values must be a list`)
      continue
    }
    const allowed = MSE_DOMAINS[key as MseDomain] as readonly string[]
    for (const v of e.values) if (typeof v !== 'string' || !allowed.includes(v)) issues.push(`${key}: unknown value ${String(v)}`)
    if (e.note !== undefined && (typeof e.note !== 'string' || e.note.length > 1000)) issues.push(`${key}: note must be text up to 1000 characters`)
  }
  return issues
}

// --- English labels (UI chips, the printed report) ---------------------------

const humanize = (v: string) => v.replace(/_x4$/, ' ×4').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

export const LABELS: Record<string, string> = {
  // acronyms and values whose plain humanization would be wrong
  cbt: 'CBT', dbt_skills: 'DBT skills', act: 'ACT', emdr: 'EMDR', er_referral: 'ER referral',
  duty_to_warn: 'Duty to warn / protect', crisis_line_provided: 'Crisis line provided (988 / Línea PAS)',
  oriented_x4: 'Oriented ×4', active_no_plan: 'Active, no plan', active_plan: 'Active, with plan',
  active_plan_intent: 'Active, with plan and intent', ideation_plan: 'Ideation with plan', telehealth_video: 'Telehealth (video)',
  mood_observed: 'Mood (observed)', thought_process: 'Thought process', thought_content: 'Thought content',
  risk_suicidal: 'Suicidal ideation', risk_self_harm: 'Self-harm', risk_harm_others: 'Harm to others',
  risk_level: 'Overall risk level', risk_notes: 'Clinical rationale', risk_actions: 'Actions taken',
}
export const label = (value: string): string => LABELS[value] ?? humanize(value)

export const MSE_DOMAIN_LABELS: Record<MseDomain, string> = {
  appearance: 'Appearance', behavior: 'Behavior / attitude', speech: 'Speech', mood_observed: 'Mood (observed)',
  affect: 'Affect', thought_process: 'Thought process', thought_content: 'Thought content', perception: 'Perception',
  cognition: 'Orientation / cognition', insight: 'Insight', judgment: 'Judgment',
}

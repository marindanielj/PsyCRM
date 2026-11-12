// Web copy of server/lib/intake-form.ts: the intake form's keys and Spanish labels.
// Edit the server file and copy it here; server/lib/intake-form-mirror.test.ts checks they match.
// (The two apps are built separately, so the file is copied rather than imported.)
/**
 * The first-session intake note (B11): the therapist's own printed form ("Nota de Entrevista Inicial"), in her order and
 * with her words, in Spanish. Pure data and validation, shared by the API and the web (src/lib/intake-form.ts is a copy).
 * See docs/psycrm/specs/future-intake-notes.md.
 */

/** Bumped only if the shape of the stored form ever changes. A note with this key is an intake-form note. */
export const INTAKE_FORM_VERSION = 1

/** A row with a checkbox and a text (the checkbox marks the area as affected / relevant). */
export interface IntakeRow {
  marked: boolean
  text: string
}

export const FUNCTIONING_ROWS = [
  ['occupational', 'Ocupacional'],
  ['family', 'Familiar'],
  ['social', 'Social'],
  ['sleep', 'Sueño'],
  ['energy', 'Energía'],
  ['appetite', 'Apetito'],
  ['recreation', 'Hobbies / recreacional'],
  ['physical_health', 'Salud física'],
] as const

export const MH_HISTORY_ROWS = [
  ['psychiatric', 'Psiquiátrico'],
  ['psychological', 'Psicológico'],
  ['hospitalizations', 'Hospitalizaciones'],
  ['medications', 'Medicamentos (pasados / actuales)'],
  ['diagnoses', 'Diagnósticos'],
] as const

export const PERSONAL_HISTORY_ROWS = [
  ['family_of_origin', 'Relaciones con la familia de origen'],
  ['childhood', 'Eventos / problemas en la niñez'],
  ['school', 'Problemas académicos o conductuales en la escuela'],
  ['spirituality', 'Espiritualidad / fe'],
  ['romantic', 'Historial de relaciones románticas'],
  ['social', 'Historial de relaciones sociales'],
  ['substances', 'Historial de uso de sustancias'],
] as const

/** The free-text sections, with the label and the helper line of her form. */
export const INTAKE_TEXTS = {
  presenting_problem: ['Queja / problema que presenta', 'Estresores actuales'],
  problem_history: ['Historial del problema', 'Factores precipitantes y/o exacerbantes · Síntomas: duración, severidad, frecuencia'],
  family_mh_history: ['Historial familiar de salud mental', 'Diagnóstico · Tratamiento · Sustancias'],
  physical_personal: ['Historial de salud física: personal', ''],
  physical_family: ['Historial de salud física: familiar', ''],
  dangerousness: ['Peligrosidad', 'Historial y actual · Manejo en caso de crisis'],
  protective: ['Factores protectivos', 'Fortalezas · Destrezas de afrontamiento · Hobbies · Red de apoyo'],
  goals_short: ['Metas y objetivos: corto plazo (3 meses)', ''],
  goals_long: ['Metas y objetivos: largo plazo (6 meses)', ''],
  expectations: ['Expectativas, temores o preguntas acerca del proceso', ''],
} as const
export type IntakeTextKey = keyof typeof INTAKE_TEXTS
export const INTAKE_TEXT_KEYS = Object.keys(INTAKE_TEXTS) as IntakeTextKey[]

export type FunctioningKey = (typeof FUNCTIONING_ROWS)[number][0]
export type MhHistoryKey = (typeof MH_HISTORY_ROWS)[number][0]
export type PersonalHistoryKey = (typeof PERSONAL_HISTORY_ROWS)[number][0]

/** Where the client was during a video or phone session (licence and safety). */
export interface IntakeTelehealth {
  location: string
  in_pr: boolean | null
  private_setting: boolean | null
}

export interface IntakeForm {
  version?: number
  telehealth?: IntakeTelehealth
  functioning?: Partial<Record<FunctioningKey, IntakeRow>>
  mh_history?: Partial<Record<MhHistoryKey, IntakeRow>>
  personal_history?: Partial<Record<PersonalHistoryKey, IntakeRow>>
  texts?: Partial<Record<IntakeTextKey, string>>
}

export const INTAKE_TEXT_MAX = 20_000
export const INTAKE_LOCATION_MAX = 300

/** Required to sign an intake-form note, besides the risk assessment every note needs. */
export function intakeMissingForSign(form: IntakeForm | null | undefined): string[] {
  const text = form?.texts?.presenting_problem ?? ''
  return text.trim() === '' ? ['presenting_problem'] : []
}

/** True for a note that uses the intake form (an older "intake" note written as DAP has no version). */
export const isIntakeForm = (note: { session_type: string; intake?: unknown }) =>
  note.session_type === 'intake' && typeof (note.intake as IntakeForm | null)?.version === 'number'

/** Every key that holds content, for the audit log (names only, never the text). */
export function intakeFieldNames(form: IntakeForm | null | undefined): string[] {
  if (!form) return []
  const names: string[] = []
  for (const [k, v] of Object.entries(form.texts ?? {})) if (v && v.trim()) names.push(`texts.${k}`)
  for (const group of ['functioning', 'mh_history', 'personal_history'] as const) {
    for (const [k, v] of Object.entries(form[group] ?? {})) if (v && (v.marked || v.text.trim())) names.push(`${group}.${k}`)
  }
  if (form.telehealth) names.push('telehealth')
  return names
}

/** The intake keys whose content differs between two versions of the form (names only). */
export function intakeChangedFields(before: IntakeForm | null | undefined, after: IntakeForm | null | undefined): string[] {
  const flat = (f: IntakeForm | null | undefined) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(f?.texts ?? {})) out[`texts.${k}`] = v ?? ''
    for (const group of ['functioning', 'mh_history', 'personal_history'] as const) {
      for (const [k, v] of Object.entries(f?.[group] ?? {})) out[`${group}.${k}`] = JSON.stringify(v ?? null)
    }
    out.telehealth = JSON.stringify(f?.telehealth ?? null)
    return out
  }
  const a = flat(before)
  const b = flat(after)
  const norm = (v: string | undefined) => (v === undefined || v === 'null' ? '' : v)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => norm(a[k]) !== norm(b[k]))
}

// --- the client's admission questionnaire, shown next to the note --------------------------------------------------

/** Questionnaire answer key -> where it helps in the note. Only these keys are ever read. */
export const CLIENT_ANSWER_TARGETS = {
  reason: 'texts.presenting_problem',
  prior_therapy_detail: 'mh_history.psychological',
  meds_list: 'mh_history.medications',
  health: 'texts.physical_personal',
  family_history: 'texts.family_mh_history',
  substances: 'personal_history.substances',
  support: 'texts.protective',
  goals: 'texts.expectations',
} as const
export type ClientAnswerKey = keyof typeof CLIENT_ANSWER_TARGETS

/** The questionnaire's select answers, in words. */
export const CLIENT_ANSWER_VALUES: Record<string, string> = {
  ninguno: 'Ninguno',
  ocasional: 'Ocasional',
  frecuente: 'Frecuente',
  prefiero_hablar: 'Prefiere conversarlo en persona',
}

// --- Spanish labels for the parts reused from the session note ---------------------------------------------------

export const LABELS_ES: Record<string, string> = {
  // mental status: domains
  appearance: 'Apariencia', behavior: 'Conducta', speech: 'Habla', mood_observed: 'Ánimo (observado)', affect: 'Afecto',
  thought_process: 'Proceso de pensamiento', thought_content: 'Contenido del pensamiento', perception: 'Percepción',
  cognition: 'Cognición', insight: 'Introspección', judgment: 'Juicio',
  // mental status: values
  well_groomed: 'Bien arreglado/a', casual: 'Casual', disheveled: 'Descuidado/a', inappropriate_dress: 'Vestimenta inapropiada', poor_hygiene: 'Higiene pobre',
  cooperative: 'Cooperador/a', engaged: 'Involucrado/a', guarded: 'Defensivo/a', withdrawn: 'Retraído/a', agitated: 'Agitado/a', restless: 'Inquieto/a',
  psychomotor_retardation: 'Retardo psicomotor', poor_eye_contact: 'Poco contacto visual',
  normal: 'Normal', pressured: 'Acelerada', slow: 'Lenta', soft: 'Baja', loud: 'Alta', monotone: 'Monótona', tangential_speech: 'Tangencial',
  euthymic: 'Eutímico', depressed: 'Deprimido', anxious: 'Ansioso', irritable: 'Irritable', euphoric: 'Eufórico', angry: 'Enojado', tearful: 'Lloroso',
  congruent: 'Congruente', incongruent: 'Incongruente', full: 'Amplio', restricted: 'Restringido', blunted: 'Embotado', flat: 'Aplanado', labile: 'Lábil',
  logical: 'Lógico', goal_directed: 'Dirigido a metas', circumstantial: 'Circunstancial', tangential: 'Tangencial', flight_of_ideas: 'Fuga de ideas', loose_associations: 'Asociaciones laxas',
  unremarkable: 'Sin hallazgos', worries: 'Preocupaciones', ruminations: 'Rumiaciones', obsessions: 'Obsesiones', delusions: 'Delirios', hopelessness: 'Desesperanza', guilt: 'Culpa',
  no_disturbance: 'Sin alteraciones', auditory_hallucinations: 'Alucinaciones auditivas', visual_hallucinations: 'Alucinaciones visuales', depersonalization: 'Despersonalización',
  oriented_x4: 'Orientado/a ×4', disoriented: 'Desorientado/a', impaired_attention: 'Atención afectada', impaired_memory: 'Memoria afectada',
  good: 'Buena', fair: 'Regular', poor: 'Pobre',
  // risk
  denied: 'Negada', passive: 'Pasiva', active_no_plan: 'Activa, sin plan', active_plan: 'Activa, con plan', active_plan_intent: 'Activa, con plan e intención',
  history: 'Historial', urges: 'Impulsos', recent: 'Reciente', current: 'Actual',
  ideation: 'Ideación', ideation_plan: 'Ideación con plan', intent: 'Intención',
  low: 'Bajo', moderate: 'Moderado', high: 'Alto', imminent: 'Inminente',
  prior_attempt: 'Intento previo', access_to_means: 'Acceso a medios', substance_use: 'Uso de sustancias', isolation: 'Aislamiento',
  recent_loss: 'Pérdida reciente', chronic_pain_illness: 'Dolor o enfermedad crónica', impulsivity: 'Impulsividad',
  family_history: 'Historial familiar', legal_financial_stress: 'Estrés legal o económico', abuse_history: 'Historial de abuso',
  social_support: 'Apoyo social', children_dependents: 'Hijos o dependientes', religious_beliefs: 'Creencias religiosas',
  engaged_in_treatment: 'Comprometido/a con el tratamiento', future_plans: 'Planes a futuro', coping_skills: 'Destrezas de afrontamiento',
  pets: 'Mascotas', employment_school: 'Empleo o escuela',
  none: 'Ninguna necesaria', safety_plan_created: 'Plan de seguridad creado', safety_plan_reviewed: 'Plan de seguridad revisado',
  means_restriction_counseling: 'Consejería sobre restricción de medios', increased_session_frequency: 'Mayor frecuencia de sesiones',
  emergency_contact_notified: 'Contacto de emergencia notificado', crisis_line_provided: 'Línea de crisis provista (988 / Línea PAS)',
  er_referral: 'Referido a sala de emergencias', duty_to_warn: 'Deber de advertir / proteger', consultation: 'Consulta con colega',
  // session
  in_person: 'Presencial', telehealth_video: 'Telesalud (video)', phone: 'Teléfono',
}

/** A Spanish label, or the key itself when one is missing (a test checks there are none for the vocabularies used). */
export const labelEs = (key: string | null | undefined): string => (key ? LABELS_ES[key] ?? key : '')

import { z } from 'zod'
import { isValidIsoDate } from './age'
import {
  INTERVENTIONS, MODALITIES, PROTECTIVE_FACTORS, RISK_ACTIONS, RISK_FACTORS, RISK_HARM_OTHERS, RISK_LEVELS,
  RISK_SELF_HARM, RISK_SUICIDAL, SESSION_TYPES, mseIssues,
} from './clinical-vocab'

/** Request body keys (camelCase, like every other route) -> database columns. */
export const NOTE_COLUMNS = {
  appointmentId: { column: 'appointment_id', type: 'text' },
  sessionDate: { column: 'session_date', type: 'date' },
  startTime: { column: 'start_time', type: 'time' },
  durationMin: { column: 'duration_min', type: 'int' },
  modality: { column: 'modality', type: 'text' },
  sessionType: { column: 'session_type', type: 'text' },
  dataSubjective: { column: 'data_subjective', type: 'text' },
  dataObjective: { column: 'data_objective', type: 'text' },
  assessment: { column: 'assessment', type: 'text' },
  plan: { column: 'plan', type: 'text' },
  mse: { column: 'mse', type: 'jsonb' },
  moodRating: { column: 'mood_rating', type: 'smallint' },
  riskSuicidal: { column: 'risk_suicidal', type: 'text' },
  riskSelfHarm: { column: 'risk_self_harm', type: 'text' },
  riskHarmOthers: { column: 'risk_harm_others', type: 'text' },
  riskLevel: { column: 'risk_level', type: 'text' },
  riskFactors: { column: 'risk_factors', type: 'text[]' },
  protectiveFactors: { column: 'protective_factors', type: 'text[]' },
  riskActions: { column: 'risk_actions', type: 'text[]' },
  riskNotes: { column: 'risk_notes', type: 'text' },
  interventions: { column: 'interventions', type: 'text[]' },
  diagnosisCodes: { column: 'diagnosis_codes', type: 'text[]' },
} as const

export type NoteField = keyof typeof NOTE_COLUMNS

const LONG = 20_000
/** Blank text is stored as NULL so "nothing written" is one state, not two. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => (v === null || v.trim() === '' ? null : v))
const choice = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values).nullable()
const list = <T extends readonly [string, ...string[]]>(values: T) =>
  z.array(z.enum(values)).max(values.length).transform((a) => [...new Set(a)])

const fields = {
  appointmentId: z.string().min(1).max(64).nullable(),
  sessionDate: z.string().refine(isValidIsoDate, 'sessionDate must be a valid YYYY-MM-DD date'),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'startTime must be HH:MM').nullable(),
  durationMin: z.number().int().min(1).max(600).nullable(),
  modality: z.enum(MODALITIES),
  sessionType: z.enum(SESSION_TYPES),
  dataSubjective: text(LONG),
  dataObjective: text(LONG),
  assessment: text(LONG),
  plan: text(LONG),
  mse: z.custom<Record<string, unknown>>((v) => mseIssues(v).length === 0, 'invalid mental status exam'),
  moodRating: z.number().int().min(1).max(10).nullable(),
  riskSuicidal: choice(RISK_SUICIDAL),
  riskSelfHarm: choice(RISK_SELF_HARM),
  riskHarmOthers: choice(RISK_HARM_OTHERS),
  riskLevel: choice(RISK_LEVELS),
  riskFactors: list(RISK_FACTORS),
  protectiveFactors: list(PROTECTIVE_FACTORS),
  riskActions: list(RISK_ACTIONS).refine((a) => !(a.includes('none') && a.length > 1), '"none" cannot be combined with another action'),
  riskNotes: text(5_000),
  interventions: list(INTERVENTIONS),
  diagnosisCodes: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/, 'invalid diagnosis code')).max(12).transform((a) => [...new Set(a)]),
}

const { sessionDate, ...optionalOnCreate } = fields

export const createNoteSchema = z
  .object({ contactId: z.string().min(1).max(64), sessionDate })
  .extend(Object.fromEntries(Object.entries(optionalOnCreate).map(([k, v]) => [k, (v as z.ZodType).optional()])) as { [K in keyof typeof optionalOnCreate]: z.ZodOptional<(typeof optionalOnCreate)[K]> })
  .strict()

export const patchNoteSchema = z
  .object({
    ...(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as z.ZodType).optional()])) as { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> }),
    /** Set by the editor's background save; only valid on a draft. */
    autosave: z.boolean().optional(),
    /** Required when editing a note that is already signed. */
    changeReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()

export const deleteNoteSchema = z.object({ reason: z.string().trim().min(1).max(500) })
export const addendumSchema = z.object({ body: z.string().trim().min(1).max(10_000) })

export type CreateNoteInput = z.infer<typeof createNoteSchema>
export type PatchNoteInput = z.infer<typeof patchNoteSchema>

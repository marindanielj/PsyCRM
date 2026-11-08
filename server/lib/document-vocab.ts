import { z } from 'zod'

/** Document templates: field types, signer roles, merge fields and the Zod schemas that guard them. */

export const FIELD_TYPES = [
  'text', 'textarea', 'email', 'phone', 'date', 'number', 'select', 'radio',
  'checkbox', 'checkbox_group', 'yes_no', 'initials', 'heading', 'paragraph',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const SIGNER_ROLES = ['client', 'guardian', 'minor'] as const
export type SignerRole = (typeof SIGNER_ROLES)[number]

export const TEMPLATE_KINDS = ['agreement', 'intake_form'] as const
export const LOCALES = ['es', 'en'] as const
export const AUDIENCES = ['adult', 'adolescent'] as const

/** Field types that need a list of options. */
const OPTION_TYPES = new Set<FieldType>(['select', 'radio', 'checkbox_group'])
/** Display-only types: they collect nothing. */
export const DISPLAY_TYPES = new Set<FieldType>(['heading', 'paragraph'])

const CONTACT_TARGETS = ['first_name', 'last_name', 'email', 'phone'] as const
const mapsToSchema = z.string().refine((v) => (CONTACT_TARGETS as readonly string[]).includes(v) || /^custom:[a-z][a-z0-9_]{0,49}$/.test(v), 'invalid mapsTo')

const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, 'key must be a lowercase slug'),
  type: z.enum(FIELD_TYPES),
  label: z.string().trim().min(1).max(500),
  help: z.string().trim().max(500).optional(),
  required: z.boolean().optional(),
  options: z.array(z.object({ value: z.string().min(1).max(100), label: z.string().trim().min(1).max(200) })).max(50).optional(),
  showIf: z.object({ key: z.string(), equals: z.union([z.string(), z.boolean()]) }).optional(),
  mapsTo: mapsToSchema.optional(),
  signerRole: z.enum(SIGNER_ROLES).optional(),
})
export type TemplateField = z.infer<typeof fieldSchema>

/** Validate a fields array: unique keys, options where needed, showIf pointing at an earlier key. */
export const fieldsSchema = z.array(fieldSchema).max(200).superRefine((fields, ctx) => {
  const seen = new Set<string>()
  fields.forEach((f, i) => {
    if (seen.has(f.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `duplicate key "${f.key}"` })
    if (OPTION_TYPES.has(f.type) && !(f.options && f.options.length > 0)) {
      ctx.addIssue({ code: 'custom', path: [i, 'options'], message: `${f.type} needs options` })
    }
    if (f.showIf && !seen.has(f.showIf.key)) {
      ctx.addIssue({ code: 'custom', path: [i, 'showIf'], message: 'showIf must point to an earlier field' })
    }
    if (f.mapsTo && DISPLAY_TYPES.has(f.type)) ctx.addIssue({ code: 'custom', path: [i, 'mapsTo'], message: 'display fields collect nothing' })
    seen.add(f.key)
  })
})

export const signatureSchema = z.object({ required: z.boolean(), drawn: z.boolean() })

export const templateBaseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(TEMPLATE_KINDS),
  bodyMd: z.string().max(60_000),
  fields: fieldsSchema,
  signature: signatureSchema,
  signerRoles: z.array(z.enum(SIGNER_ROLES)).min(1).max(3),
  locale: z.enum(LOCALES),
})
export const createTemplateSchema = templateBaseSchema.partial({ bodyMd: true, fields: true, signature: true, signerRoles: true, locale: true })
export const patchTemplateSchema = templateBaseSchema.partial()
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>
export type PatchTemplateInput = z.infer<typeof patchTemplateSchema>

export const packetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullish(),
  familyIds: z.array(z.string().min(1).max(64)).max(40),
  audience: z.enum(AUDIENCES),
})
export const patchPacketSchema = packetSchema.partial().extend({ archived: z.boolean().optional() })
export type PacketInput = z.infer<typeof packetSchema>

/** Merge tokens a document may use. The renderer substitutes exactly these. */
export const DOCUMENT_MERGE_FIELDS: readonly { token: string; label: string }[] = [
  { token: '{{client.full_name}}', label: 'Client full name' },
  { token: '{{client.first_name}}', label: 'Client first name' },
  { token: '{{client.date_of_birth}}', label: 'Client date of birth' },
  { token: '{{practice.name}}', label: 'Practice name' },
  { token: '{{practice.therapist}}', label: 'Therapist' },
  { token: '{{practice.license}}', label: 'License number' },
  { token: '{{practice.address}}', label: 'Practice address' },
  { token: '{{practice.phone}}', label: 'Practice phone' },
  { token: '{{fees.session}}', label: 'Session fee' },
  { token: '{{fees.intake}}', label: 'Intake fee' },
  { token: '{{fees.late_cancel}}', label: 'Late-cancel fee' },
  { token: '{{policy.cancel_hours}}', label: 'Cancellation notice (hours)' },
  { token: '{{today}}', label: 'Today (long date)' },
]

import { z } from 'zod'

/**
 * A practice's public page: what it says (`PublicPageConfig`, stored in locations.settings.publicPage), the
 * form people use to ask for information or an appointment, and the rules both obey. Pure: no database.
 *
 * The page is meant to answer, before anyone calls, the questions a therapist otherwise answers one by one:
 * fees, which insurance plans, hours, how it works. It collects NO clinical information.
 */

export const DAYS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const
export type Day = (typeof DAYS)[number]
export const DAY_LABEL: Record<Day, string> = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado' }

export const SLOTS = ['manana', 'tarde'] as const
export type Slot = (typeof SLOTS)[number]
export const SLOT_LABEL: Record<Slot, string> = { manana: 'Mañana', tarde: 'Tarde' }

export const MODES = ['presencial', 'virtual'] as const
export type Mode = (typeof MODES)[number]
export const MODE_LABEL: Record<Mode, string> = { presencial: 'Presencial', virtual: 'Virtual' }

export const WHO = ['adult', 'minor'] as const
export type Who = (typeof WHO)[number]

/** Answers the form can give about insurance besides a listed plan (only asked when the practice accepts plans). */
export const NO_PLAN = 'Sin plan médico'
export const NOT_SURE = 'No estoy segura/o'

/**
 * The statements a person must tick before asking, so nobody asks without having seen what the page answers (fees,
 * insurance). The practice writes the editable ones; this one is added automatically while the practice does NOT accept
 * insurance, so the page and the checkbox can never disagree.
 */
export const NO_INSURANCE_ACK = 'Entiendo que no se aceptan planes médicos.'
export const DEFAULT_ACKS = ['Leí las preguntas frecuentes de esta página.', 'Vi las tarifas.'] as const

/** The numbers shown on the page. Same lines as the intake documents and the session-note risk step; a test keeps them equal. */
export const CRISIS_LINES = [
  { name: 'Línea 988 de prevención del suicidio y crisis', detail: 'llame o envíe texto al 988' },
  { name: 'Línea PAS (Primera Ayuda Psicológica) de Puerto Rico', detail: '1-800-981-0023' },
  { name: 'Emergencias', detail: '911' },
] as const

/** Questions people usually ask first. Offered as suggestions in the editor: never published with an answer nobody wrote. */
export const SUGGESTED_QUESTIONS = [
  '¿Aceptan plan médico?',
  '¿Cuánto cuesta la primera cita?',
  '¿Cuánto dura cada sesión?',
  '¿Ofrecen citas virtuales?',
  '¿Atienden niños y adolescentes?',
  '¿Cómo cancelo o cambio una cita?',
  '¿Qué debo llevar a la primera cita?',
  '¿Mi información es confidencial?',
] as const

export interface PublicPageConfig {
  enabled: boolean
  headline: string
  subheadline: string
  about: string
  services: { title: string; text: string }[]
  showFees: boolean
  /** Does the practice take insurance plans? When not, the page says so and the form makes people acknowledge it. */
  insurance: { accepted: boolean; plans: string[]; note: string }
  faq: { q: string; a: string }[]
  hours: string
  location: string
  showTherapist: boolean
  showCrisis: boolean
  form: { intro: string; askInsurance: boolean; acknowledgements: string[]; modes: Mode[]; days: Day[]; slots: Slot[] }
  /** Fingerprint of the banner picture (8 hex), null when there is none. */
  bannerVersion: string | null
}

export const EMPTY_PAGE: PublicPageConfig = {
  enabled: false,
  headline: '',
  subheadline: '',
  about: '',
  services: [],
  showFees: true,
  insurance: { accepted: false, plans: [], note: '' },
  faq: [],
  hours: '',
  location: '',
  showTherapist: true,
  showCrisis: true,
  // "For now" the in-person schedule: Monday or Tuesday, morning or afternoon. Virtual uses the same days.
  form: { intro: '', askInsurance: true, acknowledgements: [...DEFAULT_ACKS], modes: ['presencial', 'virtual'], days: ['lunes', 'martes'], slots: ['manana', 'tarde'] },
  bannerVersion: null,
}

export const LIMITS = {
  headline: 120,
  subheadline: 240,
  about: 1500,
  serviceTitle: 80,
  serviceText: 400,
  services: 8,
  plan: 60,
  plans: 30,
  insuranceNote: 500,
  question: 200,
  answer: 1200,
  faq: 20,
  hours: 400,
  location: 400,
  intro: 300,
  ack: 200,
  acks: 5,
} as const

const text = (max: number) => z.string().trim().max(max)
const list = <T extends string>(all: readonly T[]) => z.array(z.enum(all as [T, ...T[]])).max(all.length)

/** What the editor may save. Every list is capped, every text is plain text (never HTML). */
export const pageSchema = z.object({
  enabled: z.boolean(),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/, 'slug').nullable(),
  headline: text(LIMITS.headline),
  subheadline: text(LIMITS.subheadline),
  about: text(LIMITS.about),
  services: z.array(z.object({ title: text(LIMITS.serviceTitle).min(1), text: text(LIMITS.serviceText) })).max(LIMITS.services),
  showFees: z.boolean(),
  insurance: z.object({ accepted: z.boolean(), plans: z.array(text(LIMITS.plan).min(1)).max(LIMITS.plans), note: text(LIMITS.insuranceNote) }),
  faq: z.array(z.object({ q: text(LIMITS.question).min(1), a: text(LIMITS.answer).min(1) })).max(LIMITS.faq),
  hours: text(LIMITS.hours),
  location: text(LIMITS.location),
  showTherapist: z.boolean(),
  showCrisis: z.boolean(),
  form: z.object({
    intro: text(LIMITS.intro),
    askInsurance: z.boolean(),
    acknowledgements: z.array(text(LIMITS.ack).min(1)).max(LIMITS.acks),
    modes: list(MODES).min(1),
    days: list(DAYS).min(1),
    slots: list(SLOTS).min(1),
  }),
})
export type PageInput = z.infer<typeof pageSchema>

/** Paths that must never be a practice's page name. */
export const RESERVED_SLUGS = new Set(['admin', 'api', 'app', 'login', 'p', 'd', 'i', 'brand', 'health', 'www', 'static', 'assets', 'settings', 'contacts', 'documents'])

/** A readable default for the page's address, from the practice's name ("Dra. Maritza Martínez" → "dra-maritza-martinez"). */
export function suggestSlug(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return s.length >= 3 && !RESERVED_SLUGS.has(s) ? s : ''
}

const arr = <T,>(v: unknown, ok: (x: unknown) => x is T): T[] => (Array.isArray(v) ? v.filter(ok) : [])
const isStr = (x: unknown): x is string => typeof x === 'string'
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const str = (v: unknown, max: number, d = ''): string => (typeof v === 'string' ? v.trim().slice(0, max) : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

/** Whatever is stored, as a complete config (missing or damaged keys fall back to the defaults). */
export function normalizePage(raw: unknown): PublicPageConfig {
  const r = obj(raw)
  const form = obj(r.form)
  const insurance = obj(r.insurance)
  const pick = <T extends string>(all: readonly T[], v: unknown, d: readonly T[]): T[] => {
    const got = all.filter((x) => arr(v, isStr).includes(x))
    return got.length ? got : [...d]
  }
  return {
    enabled: bool(r.enabled, false),
    headline: str(r.headline, LIMITS.headline),
    subheadline: str(r.subheadline, LIMITS.subheadline),
    about: str(r.about, LIMITS.about),
    services: arr(r.services, (x): x is { title: string; text: string } => typeof x === 'object' && x !== null && isStr(obj(x).title))
      .slice(0, LIMITS.services)
      .map((s) => ({ title: str(s.title, LIMITS.serviceTitle), text: str(s.text, LIMITS.serviceText) }))
      .filter((s) => s.title),
    showFees: bool(r.showFees, EMPTY_PAGE.showFees),
    insurance: {
      accepted: bool(insurance.accepted, EMPTY_PAGE.insurance.accepted),
      plans: arr(insurance.plans, isStr).map((p) => p.trim().slice(0, LIMITS.plan)).filter(Boolean).slice(0, LIMITS.plans),
      note: str(insurance.note, LIMITS.insuranceNote),
    },
    faq: arr(r.faq, (x): x is { q: string; a: string } => typeof x === 'object' && x !== null && isStr(obj(x).q) && isStr(obj(x).a))
      .slice(0, LIMITS.faq)
      .map((f) => ({ q: str(f.q, LIMITS.question), a: str(f.a, LIMITS.answer) }))
      .filter((f) => f.q && f.a),
    hours: str(r.hours, LIMITS.hours),
    location: str(r.location, LIMITS.location),
    showTherapist: bool(r.showTherapist, EMPTY_PAGE.showTherapist),
    showCrisis: bool(r.showCrisis, EMPTY_PAGE.showCrisis),
    form: {
      intro: str(form.intro, LIMITS.intro),
      askInsurance: bool(form.askInsurance, EMPTY_PAGE.form.askInsurance),
      acknowledgements: Array.isArray(form.acknowledgements) ? arr(form.acknowledgements, isStr).map((a) => a.trim().slice(0, LIMITS.ack)).filter(Boolean).slice(0, LIMITS.acks) : [...DEFAULT_ACKS],
      modes: pick(MODES, form.modes, EMPTY_PAGE.form.modes),
      days: pick(DAYS, form.days, EMPTY_PAGE.form.days),
      slots: pick(SLOTS, form.slots, EMPTY_PAGE.form.slots),
    },
    bannerVersion: typeof r.bannerVersion === 'string' && /^[0-9a-f]{8}$/.test(r.bannerVersion) ? r.bannerVersion : null,
  }
}

/** What stops a page from going live: it must say something and have an address. */
export function missingForPublish(c: PublicPageConfig, slug: string | null): string[] {
  const out: string[] = []
  if (!slug) out.push('slug')
  if (!c.headline) out.push('headline')
  return out
}

/** Every statement the form makes the person tick: the practice's own, plus the automatic insurance one while no plans are accepted. */
export function requiredAcknowledgements(c: PublicPageConfig): string[] {
  return [...c.form.acknowledgements, ...(c.insurance.accepted ? [] : [NO_INSURANCE_ACK])]
}

/** Whether the form asks about an insurance plan: only when the practice takes plans, has listed some and wants the question. */
export const asksInsurance = (c: PublicPageConfig): boolean => c.insurance.accepted && c.insurance.plans.length > 0 && c.form.askInsurance

// ---- the request form --------------------------------------------------------------------------

export const MAX_MESSAGE = 600
export const BANNER_MAX_BYTES = 700 * 1024

/** What a visitor may send. The form is built from the page's config; `inquirySchemaFor` narrows this to it. */
export const inquirySchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().max(40).optional(),
  who: z.enum(WHO),
  mode: z.enum(MODES),
  days: z.array(z.enum(DAYS)).max(DAYS.length),
  slots: z.array(z.enum(SLOTS)).max(SLOTS.length),
  insurance: z.string().trim().max(LIMITS.plan).optional(),
  /** The exact statements ticked (all of them are required). */
  acknowledged: z.array(z.string().max(LIMITS.ack)).max(LIMITS.acks + 1),
  message: z.string().trim().max(MAX_MESSAGE).optional(),
  consent: z.literal(true),
  // A field people never see: a bot that fills it in is quietly ignored.
  website: z.string().max(200).optional(),
})
export type InquiryInput = z.infer<typeof inquirySchema>

export type InquiryCheck = { ok: true; value: InquiryInput } | { ok: false; error: string }

/** The visitor's answers checked against THIS page's form: only the modes, days and slots it offers, only its insurance options. */
export function checkInquiry(config: PublicPageConfig, raw: unknown): InquiryCheck {
  const parsed = inquirySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'invalid' }
  const v = parsed.data
  if (!config.form.modes.includes(v.mode)) return { ok: false, error: 'mode_not_offered' }
  if (v.days.length === 0 || v.days.some((d) => !config.form.days.includes(d))) return { ok: false, error: 'invalid_days' }
  if (v.slots.length === 0 || v.slots.some((s) => !config.form.slots.includes(s))) return { ok: false, error: 'invalid_slots' }
  if (asksInsurance(config)) {
    const allowed = new Set<string>([...config.insurance.plans, NO_PLAN, NOT_SURE])
    if (!v.insurance || !allowed.has(v.insurance)) return { ok: false, error: 'invalid_insurance' }
  }
  // Every statement the page asks for must have been ticked, word for word as the page showed it.
  const required = requiredAcknowledgements(config)
  if (!required.every((a) => v.acknowledged.includes(a))) return { ok: false, error: 'acknowledgement_required' }
  return { ok: true, value: { ...v, acknowledged: required, insurance: asksInsurance(config) ? v.insurance : undefined, phone: v.phone || undefined, message: v.message || undefined } }
}


/** A banner arrives as a data URL; what it IS is decided by its first bytes (see detectLogoType), never by what it claims. */
export function decodeBannerDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!m || m[1]!.length > Math.ceil((BANNER_MAX_BYTES * 4) / 3) + 8) return null
  return Buffer.from(m[1]!, 'base64')
}

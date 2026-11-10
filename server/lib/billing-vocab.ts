/**
 * Billing vocabulary and rules for superbills (A4). Pure: no database, no I/O.
 *
 * What a superbill needs per service is a CPT code, the place of service, optional modifiers and the diagnoses it
 * relates to. Everything here only SUGGESTS (the therapist reviews it) or VALIDATES the shape of what she typed. Nothing
 * here decides a clinical or billing fact for her.
 *
 * CPT descriptors are the property of the AMA; the labels below are short paraphrases of our own, not their text.
 */

export interface CptInfo {
  code: string
  label: string
}

/** Codes a psychotherapy practice normally uses. Any other 5-character code can still be entered by hand. */
export const COMMON_CPT: readonly CptInfo[] = [
  { code: '90791', label: 'Diagnostic evaluation (intake)' },
  { code: '90832', label: 'Individual therapy, about 30 min (16–37)' },
  { code: '90834', label: 'Individual therapy, about 45 min (38–52)' },
  { code: '90837', label: 'Individual therapy, about 60 min (53+)' },
  { code: '90846', label: 'Family session without the client present' },
  { code: '90847', label: 'Family or couple session with the client present' },
  { code: '90839', label: 'Crisis session, first 60 min' },
  { code: '90840', label: 'Crisis session, each added 30 min' },
]

export const MODIFIERS: readonly { code: string; label: string }[] = [
  { code: '95', label: 'Live video telehealth' },
  { code: '93', label: 'Audio-only telehealth' },
  { code: 'GT', label: 'Telehealth (older payer convention)' },
]

export const PLACES_OF_SERVICE: readonly { code: string; label: string }[] = [
  { code: '11', label: 'Office' },
  { code: '10', label: 'Telehealth, client at home' },
  { code: '02', label: 'Telehealth, client elsewhere' },
]

export const PAYMENT_METHODS = ['cash', 'card', 'check', 'transfer', 'ath_movil', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const TELEHEALTH_POS = ['10', '02'] as const
export type TelehealthPos = (typeof TELEHEALTH_POS)[number]

/** The most diagnoses one superbill lists (letters A–L, as on the standard claim form). */
export const MAX_DIAGNOSES = 12

// --- shape checks ------------------------------------------------------------------------------------------------

/** 5 digits, or the Category II/III forms (4 digits + F/T), or HCPCS (a letter + 4 digits). */
export const CPT_PATTERN = /^(\d{4}[0-9FT]|[A-Z]\d{4})$/
export const MODIFIER_PATTERN = /^[A-Z0-9]{2}$/
export const POS_PATTERN = /^\d{2}$/
/** ICD-10-CM: a letter (never U), two characters, then an optional dot and 1–4 more. */
export const ICD10_PATTERN = /^[A-TV-Z][0-9][0-9AB](\.[0-9A-TV-Z]{1,4})?$/

export const isValidCpt = (s: string) => CPT_PATTERN.test(s)

/** Upper-case, trim, and put the dot after the third character when it was left out ("f411" → "F41.1"). */
export function normalizeIcd10(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, '')
  return s.length > 3 && !s.includes('.') ? `${s.slice(0, 3)}.${s.slice(3)}` : s
}
export const isValidIcd10 = (s: string) => ICD10_PATTERN.test(s)

/**
 * An NPI is 10 digits whose last is a Luhn check digit computed over the number with the prefix 80840. This catches a
 * mistyped digit, not a number that was never issued.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false
  const digits = `80840${npi}`.split('').map(Number)
  let sum = 0
  // Luhn over the 15 digits, from the right: double every second digit.
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = digits[i]!
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

/** EIN (`12-3456789`) or SSN (`123-45-6789`), digits only inside. Returns the digits, or null. */
export function normalizeTaxId(raw: string): { digits: string; type: 'ein' | 'ssn' } | null {
  const t = raw.trim()
  if (/^\d{2}-?\d{7}$/.test(t)) return { digits: t.replace('-', ''), type: 'ein' }
  if (/^\d{3}-?\d{2}-?\d{4}$/.test(t)) return { digits: t.replace(/-/g, ''), type: 'ssn' }
  return null
}

/** `12-3456789` or `123-45-6789`, from the digits and kind. */
export function formatTaxId(digits: string, type: 'ein' | 'ssn'): string {
  return type === 'ein' ? `${digits.slice(0, 2)}-${digits.slice(2)}` : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
}

// --- money -------------------------------------------------------------------------------------------------------

/** "$1,000.50", "100", "$ 99.5" → whole cents without ever passing through a float. Null when it is not money. */
export function parseMoneyToCents(raw: string): number | null {
  const t = raw.trim().replace(/^\$\s*/, '').replace(/,/g, '')
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

// --- suggestions (the therapist reviews them) ---------------------------------------------------------------------

export interface SessionFacts {
  sessionType: string
  modality: string
  /** Minutes the session lasted. */
  durationMin: number | null
}

/** The CPT code that usually fits this kind and length of session, or null when it cannot be told (she must choose). */
export function suggestCpt(s: Pick<SessionFacts, 'sessionType' | 'durationMin'>): string | null {
  const min = s.durationMin
  switch (s.sessionType) {
    case 'intake':
      return '90791'
    case 'individual':
      if (min === null || min < 16) return null
      return min <= 37 ? '90832' : min <= 52 ? '90834' : '90837'
    case 'couple':
    case 'family':
      return min !== null && min >= 26 ? '90847' : null
    case 'collateral':
      return min !== null && min >= 26 ? '90846' : null
    case 'crisis':
      return min !== null && min >= 30 ? '90839' : null
    default:
      return null
  }
}

/** Place of service and modifiers implied by how the session was held. */
export function suggestPlace(modality: string, telehealthPos: TelehealthPos): { placeOfService: string; modifiers: string[] } {
  if (modality === 'telehealth_video') return { placeOfService: telehealthPos, modifiers: ['95'] }
  if (modality === 'phone') return { placeOfService: telehealthPos, modifiers: ['93'] }
  return { placeOfService: '11', modifiers: [] }
}

/** `SB-2026-0007` */
export const formatSuperbillNumber = (year: number, n: number) => `SB-${year}-${String(n).padStart(4, '0')}`

/** Diagnosis pointer letters A–L for the Nth diagnosis (0-based). */
export const diagnosisLetter = (i: number) => String.fromCharCode(65 + i)

/** The letters (e.g. "AB") pointing a line at its diagnoses within the superbill's list; unknown codes are skipped. */
export function diagnosisPointers(lineCodes: readonly string[], superbillCodes: readonly string[]): string {
  return lineCodes
    .map((c) => superbillCodes.indexOf(c))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
    .map(diagnosisLetter)
    .join('')
}

// --- documents for the client (invoice, receipt): Spanish, and nothing clinical -------------------------------------

/** How a payment method reads on a document the client receives. */
export const PAYMENT_METHOD_LABEL_ES: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  check: 'Cheque',
  transfer: 'Transferencia',
  ath_movil: 'ATH Móvil',
  other: 'Otro',
}

/**
 * What a service is called on an invoice or receipt. Deliberately generic: these documents get shown to employers, family
 * and banks, so they never carry a diagnosis or a CPT code, only the kind of service.
 */
export function serviceDescription(cpt: string): string {
  switch (cpt) {
    case '90791':
      return 'Evaluación inicial'
    case '90832':
    case '90834':
    case '90837':
      return 'Sesión de terapia individual'
    case '90846':
    case '90847':
      return 'Sesión de pareja o familia'
    case '90839':
    case '90840':
      return 'Sesión de crisis'
    default:
      return 'Servicio profesional'
  }
}

const pad4 = (n: number) => String(n).padStart(4, '0')
/** `FAC-2026-0007` */
export const formatInvoiceNumber = (year: number, n: number) => `FAC-${year}-${pad4(n)}`
/** `REC-2026-0007` */
export const formatReceiptNumber = (year: number, n: number) => `REC-${year}-${pad4(n)}`

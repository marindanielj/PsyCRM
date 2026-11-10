import type { MissingItem } from './api'

/** "$1,000.50", "100", "99.5" → whole cents without a float. Null when it is not money. */
export function dollarsToCents(raw: string): number | null {
  const t = raw.trim().replace(/^\$\s*/, '').replace(/,/g, '')
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
}

/** Cents → the text to put in an input: "110.00". */
export function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** What each reason a superbill cannot be issued yet means, in words the therapist can act on. */
export const MISSING_MESSAGES: Record<string, string> = {
  provider_name: 'Add your name in Settings → Practice.',
  practice_license: 'Add your license number in Settings → Practice.',
  practice_address: 'Add the practice address in Settings → Practice.',
  provider_npi: 'Add your NPI in Settings → Billing.',
  provider_tax_id: 'Add your tax ID (EIN or SSN) in Settings → Billing.',
  client_date_of_birth: 'This client has no date of birth on file.',
  charge_no_diagnosis: 'A charge has no diagnosis code. Edit it and add one.',
  charge_zero_fee: 'A charge has no fee. Edit it and set the amount.',
}

/** One line per distinct reason, with a count when several charges share it. */
export function describeMissing(items: MissingItem[]): string[] {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(i.code, (counts.get(i.code) ?? 0) + 1)
  return [...counts].map(([code, n]) => {
    const text = MISSING_MESSAGES[code] ?? 'Something is missing.'
    return n > 1 ? `${text} (${n} charges)` : text
  })
}

/** Messages for the short codes the billing API answers with. */
export const BILLING_MESSAGES: Record<string, string> = {
  invalid_npi: 'That NPI does not look right. Check the 10 digits.',
  invalid_tax_id: 'Use an EIN (12-3456789) or an SSN (123-45-6789).',
  invalid_taxonomy: 'A taxonomy code has 10 letters and numbers.',
  invalid_cpt: 'That is not a valid procedure code.',
  unknown_contact: 'That client was not found.',
  unknown_note: 'That session note cannot be billed (it must be this client’s signed note).',
  unknown_appointment: 'That appointment does not belong to this client.',
  note_already_charged: 'That session already has a charge.',
  overpaid: 'The amount paid cannot be more than the fee.',
  issued: 'This charge is on a superbill. Void the superbill first to change it.',
  voided: 'This charge was voided and cannot be changed.',
  not_found: 'That was not found. It may have been removed.',
  nothing_to_change: 'Nothing was changed.',
  charges_unavailable: 'One of those charges is not available (it may already be on a superbill or voided).',
  too_many_diagnoses: 'A superbill lists at most 12 different diagnoses. Split it into two.',
  no_charges: 'Choose at least one charge.',
  method_required: 'Choose how it was paid.',
}

export const billingMessage = (code: string | undefined | null): string => (code && BILLING_MESSAGES[code]) || 'Something went wrong. Please try again.'

export const SESSION_TYPE_LABELS: Record<string, string> = {
  intake: 'Intake', individual: 'Individual', couple: 'Couple', family: 'Family', crisis: 'Crisis', collateral: 'Collateral',
}
export const MODALITY_LABELS: Record<string, string> = { in_person: 'In person', telehealth_video: 'Video', phone: 'Phone' }
export const PAYMENT_LABELS: Record<string, string> = { cash: 'Cash', card: 'Card', check: 'Check', transfer: 'Transfer', other: 'Other' }

/** `2026-11-02` → `Nov 2, 2026`, read from the string so a time zone can never move the date. */
export function formatServiceDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!m) return ymd
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`
}

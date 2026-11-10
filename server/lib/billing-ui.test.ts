import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL_ES, formatCents, parseMoneyToCents } from './billing-vocab'
import { BILLING_MESSAGES, MISSING_MESSAGES, PAYMENT_LABELS, PAYMENT_LABELS_ES, billingMessage, centsToInput, describeMissing, dollarsToCents, formatDateEs, formatServiceDate } from '../../src/lib/billing'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
// the superbill/charge routes and repos, plus the payments/receipts/invoices ones
const ROUTE = read('../routes/billing.ts') + read('../routes/billing-documents.ts')
const REPO = read('../repos/billing-repo.ts') + read('../repos/billing-documents-repo.ts')

test('the web parses money exactly like the server, so what she types is what is stored', () => {
  for (const t of ['$100', '100', '$1,000.50', '99.5', '0.07', '19.99', '1.15', '', '$', 'abc', '1.234', '-5', '12345678', '$100 per session']) {
    expect(dollarsToCents(t), t).toBe(parseMoneyToCents(t))
  }
  expect(dollarsToCents('19.99')).toBe(1999)
})

test('cents become an input value that parses back to the same cents', () => {
  for (const c of [0, 7, 100, 1999, 10000, 100050, 9_999_999]) {
    expect(centsToInput(c)).toMatch(/^\d+\.\d{2}$/)
    expect(dollarsToCents(centsToInput(c))).toBe(c)
  }
  expect(centsToInput(11000)).toBe('110.00')
  expect(formatCents(11000)).toBe('$110.00')
})

test('every reason a superbill can be refused has words the therapist can act on', () => {
  // the codes the repo can put in `missing` are exactly the ones the web knows how to explain
  const fromRepo = [...REPO.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]!).filter((c) => !['not_found'].includes(c))
  expect(fromRepo.length).toBeGreaterThan(5)
  for (const code of new Set(fromRepo)) expect(MISSING_MESSAGES[code], code).toBeTruthy()
})

test('missing items are listed once per reason, with a count when several charges share it', () => {
  expect(describeMissing([{ code: 'provider_npi' }, { code: 'charge_no_diagnosis', chargeId: 'a' }, { code: 'charge_no_diagnosis', chargeId: 'b' }])).toEqual([
    'Add your NPI in Settings → Billing.',
    'A charge has no diagnosis code. Edit it and add one. (2 charges)',
  ])
  expect(describeMissing([{ code: 'something_new' }])).toEqual(['Something is missing.'])
  expect(describeMissing([])).toEqual([])
})

test('every error the billing API can answer with has a message, and unknown ones get a safe fallback', () => {
  const codes = new Set<string>()
  for (const m of ROUTE.matchAll(/error: '([a-z_]+)'/g)) codes.add(m[1]!)
  for (const m of ROUTE.matchAll(/^\s{2}([a-z_]+): (?:400|404|409|422),$/gm)) codes.add(m[1]!) // the ChargeError status table
  for (const c of ['too_many_diagnoses', 'charges_unavailable', 'no_charges', 'unknown_contact', 'incomplete']) codes.add(c)
  codes.delete('incomplete') // shown as a list, not a sentence
  codes.delete('not found')
  for (const code of codes) expect(BILLING_MESSAGES[code], code).toBeTruthy()
  expect(billingMessage('nope')).toBe('Something went wrong. Please try again.')
  expect(billingMessage(undefined)).toBe('Something went wrong. Please try again.')
})

test('the web and the server agree on every payment method, ATH Móvil included, in English and in Spanish', () => {
  expect(Object.keys(PAYMENT_LABELS).sort()).toEqual([...PAYMENT_METHODS].sort())
  expect(PAYMENT_LABELS_ES).toEqual(PAYMENT_METHOD_LABEL_ES) // what the client reads on a receipt is the same on both sides
  expect(PAYMENT_LABELS.ath_movil).toBe('ATH Móvil')
  expect(PAYMENT_LABELS_ES.ath_movil).toBe('ATH Móvil')
})

test('dates on the documents the client receives read in Spanish, taken from the text so no time zone moves them', () => {
  expect(formatDateEs('2026-11-02')).toBe('2 de noviembre de 2026')
  expect(formatDateEs('2026-01-31')).toBe('31 de enero de 2026')
  expect(formatDateEs('2026-12-05T00:00:00Z')).toBe('5 de diciembre de 2026')
  expect(formatDateEs(null)).toBe('')
  expect(formatDateEs('garbage')).toBe('garbage')
})

test('a service date is read from its text, so no time zone can move it', () => {
  expect(formatServiceDate('2026-11-02')).toBe('Nov 2, 2026')
  expect(formatServiceDate('2026-12-31')).toBe('Dec 31, 2026')
  expect(formatServiceDate('2026-01-05T00:00:00Z')).toBe('Jan 5, 2026')
  expect(formatServiceDate('garbage')).toBe('garbage')
})

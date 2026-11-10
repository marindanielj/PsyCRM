import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABEL_ES, formatInvoiceNumber, formatReceiptNumber, serviceDescription,
  COMMON_CPT, MAX_DIAGNOSES, diagnosisLetter, diagnosisPointers, formatCents, formatSuperbillNumber, formatTaxId, isValidCpt,
  isValidIcd10, isValidNpi, normalizeIcd10, normalizeTaxId, parseMoneyToCents, suggestCpt, suggestPlace,
} from './billing-vocab'

test('NPI: the check digit is verified (1234567893 is the published example), and anything else is refused', () => {
  expect(isValidNpi('1234567893')).toBe(true)
  expect(isValidNpi('1234567890')).toBe(false) // a wrong check digit
  expect(isValidNpi('1234567894')).toBe(false)
  expect(isValidNpi('123456789')).toBe(false) // 9 digits
  expect(isValidNpi('12345678930')).toBe(false) // 11 digits
  expect(isValidNpi('12345 67893')).toBe(false)
  expect(isValidNpi('abcdefghij')).toBe(false)
  expect(isValidNpi('')).toBe(false)
  // a single mistyped digit anywhere is always caught
  for (let i = 0; i < 9; i++) {
    const d = '1234567893'.split('')
    d[i] = String((Number(d[i]) + 1) % 10)
    expect(isValidNpi(d.join('')), `digit ${i}`).toBe(false)
  }
})

test('ICD-10-CM codes are upper-cased, get their dot, and must have the right shape', () => {
  expect(normalizeIcd10('f41.1')).toBe('F41.1')
  expect(normalizeIcd10(' f411 ')).toBe('F41.1')
  expect(normalizeIcd10('F32')).toBe('F32')
  expect(normalizeIcd10('f 43 . 10')).toBe('F43.10')
  for (const ok of ['F41.1', 'F32.A', 'F43.10', 'Z63.0', 'F90', 'F10.20']) expect(isValidIcd10(ok), ok).toBe(true)
  for (const bad of ['', 'F4', '41.1', 'U07.1', 'F41.12345', 'F41,1', 'FF1.1', 'f41.1', 'F41.']) expect(isValidIcd10(bad), bad).toBe(false)
})

test('CPT: 5 digits, the Category II/III forms and HCPCS pass; other shapes do not', () => {
  for (const ok of ['90837', '90791', '0001F', '0123T', 'G0444', 'H0031']) expect(isValidCpt(ok), ok).toBe(true)
  for (const bad of ['9083', '908377', '9083A', 'ABCDE', '', '90 37', '90837 ']) expect(isValidCpt(bad), bad).toBe(false)
  for (const c of COMMON_CPT) expect(isValidCpt(c.code), c.code).toBe(true)
})

test('tax ids: an EIN or an SSN, with or without dashes, and nothing else', () => {
  expect(normalizeTaxId('12-3456789')).toEqual({ digits: '123456789', type: 'ein' })
  expect(normalizeTaxId('123456789')).toEqual({ digits: '123456789', type: 'ein' }) // 9 digits unformatted is ambiguous; read as an EIN
  expect(normalizeTaxId('123-45-6789')).toEqual({ digits: '123456789', type: 'ssn' })
  expect(normalizeTaxId(' 123-45-6789 ')).toEqual({ digits: '123456789', type: 'ssn' })
  for (const bad of ['', '12-345678', '123-456-789', 'abc-de-fghi', '1234567890']) expect(normalizeTaxId(bad), bad).toBeNull()
  expect(formatTaxId('123456789', 'ein')).toBe('12-3456789')
  expect(formatTaxId('123456789', 'ssn')).toBe('123-45-6789')
})

test('money is parsed to whole cents without floating-point error, and formatted back', () => {
  expect(parseMoneyToCents('$100')).toBe(10000)
  expect(parseMoneyToCents('100')).toBe(10000)
  expect(parseMoneyToCents('$1,000.50')).toBe(100050)
  expect(parseMoneyToCents('99.5')).toBe(9950)
  expect(parseMoneyToCents('0.07')).toBe(7)
  expect(parseMoneyToCents('19.99')).toBe(1999) // 19.99 * 100 is 1998.9999999999998 as a float
  expect(parseMoneyToCents('1.15')).toBe(115)
  for (const bad of ['', '$', 'abc', '$100 per session', '1.234', '-5', '1e3', '$1,00,0.5x', '12345678']) expect(parseMoneyToCents(bad), bad).toBeNull()
  expect(formatCents(10000)).toBe('$100.00')
  expect(formatCents(100050)).toBe('$1,000.50')
  expect(formatCents(7)).toBe('$0.07')
  expect(formatCents(0)).toBe('$0.00')
})

test('CPT suggestions follow the kind and length of session; unclear ones are left for her to choose', () => {
  const s = (sessionType: string, durationMin: number | null) => suggestCpt({ sessionType, durationMin })
  expect(s('intake', 60)).toBe('90791')
  expect(s('intake', null)).toBe('90791')
  expect([15, 16, 37, 38, 52, 53, 90].map((m) => s('individual', m))).toEqual([null, '90832', '90832', '90834', '90834', '90837', '90837'])
  expect(s('individual', null)).toBeNull()
  expect(s('couple', 50)).toBe('90847')
  expect(s('family', 25)).toBeNull()
  expect(s('family', 26)).toBe('90847')
  expect(s('collateral', 40)).toBe('90846')
  expect(s('crisis', 45)).toBe('90839')
  expect(s('crisis', 20)).toBeNull()
  expect(s('something_else', 50)).toBeNull()
})

test('place of service and modifier follow how the session was held, with her telehealth default', () => {
  expect(suggestPlace('in_person', '10')).toEqual({ placeOfService: '11', modifiers: [] })
  expect(suggestPlace('telehealth_video', '10')).toEqual({ placeOfService: '10', modifiers: ['95'] })
  expect(suggestPlace('telehealth_video', '02')).toEqual({ placeOfService: '02', modifiers: ['95'] })
  expect(suggestPlace('phone', '10')).toEqual({ placeOfService: '10', modifiers: ['93'] })
  expect(suggestPlace('unknown', '10')).toEqual({ placeOfService: '11', modifiers: [] })
})

test('superbill numbers and diagnosis pointers', () => {
  expect(formatSuperbillNumber(2026, 7)).toBe('SB-2026-0007')
  expect(formatSuperbillNumber(2026, 12345)).toBe('SB-2026-12345')
  expect(MAX_DIAGNOSES).toBe(12)
  expect([0, 1, 11].map(diagnosisLetter)).toEqual(['A', 'B', 'L'])
  expect(diagnosisPointers(['F41.1', 'F32.A'], ['F32.A', 'F41.1', 'F43.10'])).toBe('AB')
  expect(diagnosisPointers(['F43.10'], ['F32.A', 'F41.1', 'F43.10'])).toBe('C')
  expect(diagnosisPointers(['Z00.0'], ['F41.1'])).toBe('')
})

test('ATH Móvil is a payment method, and every method has a Spanish label for the client documents', () => {
  expect(PAYMENT_METHODS).toContain('ath_movil')
  expect(PAYMENT_METHOD_LABEL_ES.ath_movil).toBe('ATH Móvil')
  for (const m of PAYMENT_METHODS) expect(PAYMENT_METHOD_LABEL_ES[m], m).toBeTruthy()
  expect(Object.keys(PAYMENT_METHOD_LABEL_ES).sort()).toEqual([...PAYMENT_METHODS].sort())
})

test('a service reads in Spanish and says nothing clinical: no code, no diagnosis, only the kind of service', () => {
  expect(serviceDescription('90791')).toBe('Evaluación inicial')
  expect(['90832', '90834', '90837'].map(serviceDescription)).toEqual(Array(3).fill('Sesión de terapia individual'))
  expect(serviceDescription('90847')).toBe('Sesión de pareja o familia')
  expect(serviceDescription('90839')).toBe('Sesión de crisis')
  expect(serviceDescription('99999')).toBe('Servicio profesional')
  for (const c of COMMON_CPT) expect(serviceDescription(c.code), c.code).not.toMatch(/\d{5}|F\d{2}/)
})

test('invoice and receipt numbers', () => {
  expect(formatInvoiceNumber(2026, 7)).toBe('FAC-2026-0007')
  expect(formatReceiptNumber(2026, 12)).toBe('REC-2026-0012')
  expect(formatReceiptNumber(2026, 12345)).toBe('REC-2026-12345')
})

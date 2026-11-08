import { auditCsv, csvCell, formatLocal } from './audit-csv'

test('csvCell quotes commas/quotes/newlines and neutralizes spreadsheet formulas', () => {
  expect(csvCell('plain')).toBe('plain')
  expect(csvCell('a,b')).toBe('"a,b"')
  expect(csvCell('say "hi"')).toBe('"say ""hi"""')
  expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  expect(csvCell(null)).toBe('')
  expect(csvCell(42)).toBe('42')
  for (const evil of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tx']) {
    expect(csvCell(evil).replace(/^"/, '')).toMatch(/^'/)
  }
})

test('formatLocal shows practice time with the zone named', () => {
  expect(formatLocal('2026-11-05T18:03:22.000Z')).toBe('2026-11-05 14:03:22 AST')
  expect(formatLocal('2026-11-05T02:00:00.000Z')).toBe('2026-11-04 22:00:00 AST') // previous local day
})

test('auditCsv has a BOM, CRLF lines, human labels and the raw action code', () => {
  const csv = auditCsv([
    { seq: 2, occurredAt: '2026-11-05T18:03:22.000Z', actorType: 'operator', actorId: 'op1', actorName: 'Dra. Y', action: 'contact.created', entityType: 'contact', entityId: 'c1', contactId: 'c1', contactName: '=cmd|calc', details: { fields: ['name'] }, ip: '203.0.113.9' },
  ])
  expect(csv.startsWith('﻿Seq,When,')).toBe(true)
  const lines = csv.trimEnd().split('\r\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toContain('Client created,contact.created')
  expect(lines[1]).toContain("'=cmd|calc")
  expect(lines[1]).toContain('"{""fields"":[""name""]}"')
})

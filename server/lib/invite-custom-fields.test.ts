import { readFileSync } from 'node:fs'
import { RESERVED_KEYS, checkAnswers } from './invite-custom-fields'
import type { InviteField } from './invite-custom-fields'

const f = (key: string, type: string, extra: Partial<InviteField> = {}): InviteField => ({ key, label: key.toUpperCase(), type, options: [], placeholder: null, ...extra })

test('the web copy of the reserved keys matches the server list', () => {
  const src = readFileSync(new URL('../../src/lib/invite-fields.ts', import.meta.url), 'utf8')
  const web = [...src.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
  expect(web).toEqual([...RESERVED_KEYS].sort())
})

test('empty answers and unchecked boxes are no answer, and unknown keys are ignored', () => {
  const r = checkAnswers([f('a', 'text'), f('b', 'checkbox'), f('c', 'number')], { a: '  ', b: false, c: '', z: 'x' })
  expect(r).toEqual({ ok: true, values: {} })
})

test('values are trimmed and typed', () => {
  const r = checkAnswers([f('a', 'text'), f('b', 'checkbox'), f('c', 'number'), f('d', 'date'), f('e', 'dropdown', { options: ['x', 'y'] })], { a: ' hola ', b: 'true', c: '2.5', d: '2020-02-29', e: 'y' })
  expect(r).toEqual({ ok: true, values: { a: 'hola', b: true, c: 2.5, d: '2020-02-29', e: 'y' } })
})

test('a typed value that cannot be read is a mistake naming the field, not silently dropped', () => {
  expect(checkAnswers([f('n', 'number')], { n: 'abc' })).toEqual({ ok: false, field: 'N' })
  expect(checkAnswers([f('n', 'number')], { n: Number.POSITIVE_INFINITY })).toEqual({ ok: false, field: 'N' })
  expect(checkAnswers([f('n', 'number')], { n: 1e13 })).toEqual({ ok: false, field: 'N' })
  expect(checkAnswers([f('d', 'date')], { d: '2020-13-01' })).toEqual({ ok: false, field: 'D' })
  expect(checkAnswers([f('s', 'dropdown', { options: ['a'] })], { s: 'b' })).toEqual({ ok: false, field: 'S' })
  expect(checkAnswers([f('t', 'text')], { t: 'x'.repeat(501) })).toEqual({ ok: false, field: 'T' })
  expect(checkAnswers([f('t', 'textarea')], { t: 'x'.repeat(2001) })).toEqual({ ok: false, field: 'T' })
})

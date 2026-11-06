import { SEED_TEMPLATES } from './document-seed-content'
import { createTemplateSchema, DOCUMENT_MERGE_FIELDS, fieldsSchema, packetSchema } from './document-vocab'

const ok = (fields: unknown) => fieldsSchema.safeParse(fields)
const f = (over: Record<string, unknown>) => ({ key: 'a', type: 'text', label: 'A', ...over })

test('keys must be unique lowercase slugs', () => {
  expect(ok([f({}), f({})]).success).toBe(false)
  expect(ok([f({ key: 'Bad Key' })]).success).toBe(false)
  expect(ok([f({}), f({ key: 'b' })]).success).toBe(true)
})

test('select, radio and checkbox_group need options', () => {
  for (const type of ['select', 'radio', 'checkbox_group']) {
    expect(ok([f({ type })]).success, type).toBe(false)
    expect(ok([f({ type, options: [{ value: 'x', label: 'X' }] })]).success, type).toBe(true)
  }
})

test('showIf must point to an earlier field', () => {
  expect(ok([f({ showIf: { key: 'b', equals: 'yes' } }), f({ key: 'b' })]).success).toBe(false)
  expect(ok([f({ key: 'b' }), f({ showIf: { key: 'b', equals: 'yes' } })]).success).toBe(true)
  expect(ok([f({ showIf: { key: 'a', equals: true } })]).success).toBe(false)
})

test('mapsTo accepts contact fields and custom:slug only, and not on display fields', () => {
  expect(ok([f({ mapsTo: 'email' })]).success).toBe(true)
  expect(ok([f({ mapsTo: 'custom:date_of_birth' })]).success).toBe(true)
  expect(ok([f({ mapsTo: 'password' })]).success).toBe(false)
  expect(ok([f({ type: 'heading', mapsTo: 'email' })]).success).toBe(false)
})

test('a template needs a title, a kind and at least one signer', () => {
  expect(createTemplateSchema.safeParse({ title: 'x', kind: 'agreement' }).success).toBe(true)
  expect(createTemplateSchema.safeParse({ title: '', kind: 'agreement' }).success).toBe(false)
  expect(createTemplateSchema.safeParse({ title: 'x', kind: 'other' }).success).toBe(false)
  expect(createTemplateSchema.safeParse({ title: 'x', kind: 'agreement', signerRoles: [] }).success).toBe(false)
  expect(packetSchema.safeParse({ name: 'p', familyIds: [], audience: 'teen' }).success).toBe(false)
})

test('every starter template is valid, uses only known merge fields and places only fields it defines', () => {
  const known = new Set(DOCUMENT_MERGE_FIELDS.map((m) => m.token.replace(/[{}]/g, '')))
  for (const t of SEED_TEMPLATES) {
    expect(fieldsSchema.safeParse(t.fields).success, t.slug).toBe(true)
    const keys = new Set(t.fields.map((x) => x.key))
    for (const m of t.bodyMd.matchAll(/\{\{\s*([a-z_.:0-9]+)\s*\}\}/gi)) {
      const tok = m[1]!
      if (tok.startsWith('field:')) expect(keys.has(tok.slice(6)), `${t.slug}: ${tok}`).toBe(true)
      else expect(known.has(tok), `${t.slug}: ${tok}`).toBe(true)
    }
  }
  expect(SEED_TEMPLATES).toHaveLength(9)
})

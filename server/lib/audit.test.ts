import { FakeDatabase } from '../db/fake-database'
import { addLocation, freshDb } from '../test-utils/pglite'
import { audit, diff, sanitizeDetails } from './audit'
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, auditLabel, categoryPrefixes } from './audit-vocab'

test('audit writes one row with the actor, entity and sanitized details', async () => {
  const db = new FakeDatabase()
  await audit(db, 'locA', {
    action: 'contact.updated',
    entityType: 'contact',
    entityId: 'c1',
    contactId: 'c1',
    details: { fields: ['name'] },
    actor: { type: 'operator', id: 'op1' },
    ip: '203.0.113.9',
    userAgent: 'UA',
  })
  expect(db.auditEntries()).toEqual([
    { locationId: 'locA', actorType: 'operator', actorId: 'op1', action: 'contact.updated', entityType: 'contact', entityId: 'c1', contactId: 'c1', details: { fields: ['name'] } },
  ])
})

test('sanitizeDetails drops clinical/secret keys at any depth and truncates long text', () => {
  const clean = sanitizeDetails({
    fields: ['name'],
    body: 'secret note',
    nested: { password: 'x', ok: 1, deeper: { assessment: 'clinical', keep: true } },
    long: 'x'.repeat(500),
    list: [{ token: 't', id: 7 }],
    nothing: undefined,
  }) as Record<string, any>
  expect(clean.body).toBeUndefined()
  expect(clean.nested.password).toBeUndefined()
  expect(clean.nested.deeper).toEqual({ keep: true })
  expect(clean.long.length).toBe(201)
  expect(clean.list).toEqual([{ id: 7 }])
  expect('nothing' in clean).toBe(false)
  expect(clean.fields).toEqual(['name'])
})

test('sanitizeDetails keeps Date values (pg returns timestamptz as Date) as ISO strings', () => {
  const clean = sanitizeDetails({ at: new Date('2026-11-10T14:00:00Z'), nested: [new Date('2026-01-01T00:00:00Z')], bad: new Date('nope') }) as Record<string, any>
  expect(clean.at).toBe('2026-11-10T14:00:00.000Z')
  expect(clean.nested).toEqual(['2026-01-01T00:00:00.000Z'])
  expect(clean.bad).toBeNull()
})

test('diff lists only changed listed fields, as [from, to]', () => {
  expect(diff({ name: 'A', state: 'PR' }, { name: 'B', state: 'PR', other: 1 }, ['name', 'state'])).toEqual({ name: ['A', 'B'] })
  expect(diff(null, { name: 'B' }, ['name'])).toEqual({ name: [null, 'B'] })
  expect(diff({ tags: ['a'] }, { tags: ['a'] }, ['tags'])).toEqual({})
})

test('every action maps to exactly one category and has a label', () => {
  for (const action of Object.keys(AUDIT_ACTIONS)) {
    const cats = AUDIT_CATEGORIES.filter((c) => c.prefixes.some((p) => action.startsWith(p)))
    expect(cats, action).toHaveLength(1)
    expect(auditLabel(action)).not.toBe(action)
  }
  expect(auditLabel('something.unknown')).toBe('something.unknown')
  expect(categoryPrefixes('notes')).toContain('note.')
  expect(categoryPrefixes('nope')).toEqual([])
})

test('against a real database the row lands chained, and an invalid actor type is rejected', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  await audit(db, loc, { action: 'auth.login', entityType: 'auth', actor: { type: 'operator', id: 'op1' }, details: { body: 'dropped', via: 'password' } })
  await audit(db, loc, { action: 'auth.logout', entityType: 'auth', actor: { type: 'system' } })
  const rows = await db.query<{ chain_seq: string | number; details: Record<string, unknown>; prev_hash: string | null }>('SELECT chain_seq, details, prev_hash FROM audit_log ORDER BY chain_seq')
  expect(rows.map((r) => Number(r.chain_seq))).toEqual([1, 2])
  expect(rows[0]!.details).toEqual({ via: 'password' })
  expect(rows[1]!.prev_hash).toMatch(/^[0-9a-f]{64}$/)
  await expect(audit(db, loc, { action: 'auth.login', entityType: 'auth', actor: { type: 'bogus' as never } })).rejects.toThrow()
})

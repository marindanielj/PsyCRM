import { FakeDatabase } from './fake-database'

test('fake records queries and returns canned rows', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: '1' }])
  const rows = await db.query<{ id: string }>('SELECT 1 WHERE x=$1', ['a'])
  expect(rows).toEqual([{ id: '1' }])
  expect(db.calls[0]).toEqual({ sql: 'SELECT 1 WHERE x=$1', params: ['a'] })
})

test('fake returns empty array when nothing enqueued', async () => {
  const db = new FakeDatabase()
  const rows = await db.query('SELECT 1')
  expect(rows).toEqual([])
  expect(db.calls[0]).toEqual({ sql: 'SELECT 1', params: [] })
})

import { addLocation, freshDb } from '../test-utils/pglite'

test('fake captures audit inserts separately without consuming queued results', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'next' }])
  await db.query('INSERT INTO audit_log (location_id, actor_type, actor_id, actor_label, action, entity_type, entity_id, contact_id, details) VALUES ($1)', ['locA', 'operator', 'op1', null, 'contact.created', 'contact', 'c1', 'c1', '{"a":1}'])
  expect(db.calls).toHaveLength(0)
  expect(db.auditEntries()).toEqual([
    { locationId: 'locA', actorType: 'operator', actorId: 'op1', action: 'contact.created', entityType: 'contact', entityId: 'c1', contactId: 'c1', details: { a: 1 } },
  ])
  expect(await db.query('SELECT 1')).toEqual([{ id: 'next' }]) // the queued row was still there
})

test('transaction commits everything together', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana')", [loc])
    await tx.query("INSERT INTO audit_log (location_id, actor_type, action, entity_type) VALUES ($1,'system','contact.created','contact')", [loc])
  })
  expect(await db.query('SELECT 1 FROM contacts')).toHaveLength(1)
  expect(await db.query('SELECT 1 FROM audit_log')).toHaveLength(1)
})

test('transaction rolls back every write when the callback throws (a failed audit undoes the change)', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  await expect(
    db.transaction(async (tx) => {
      await tx.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana')", [loc])
      // an invalid audit row (bad actor_type) violates the CHECK -> the whole unit fails
      await tx.query("INSERT INTO audit_log (location_id, actor_type, action, entity_type) VALUES ($1,'bogus','contact.created','contact')", [loc])
    }),
  ).rejects.toThrow()
  expect(await db.query('SELECT 1 FROM contacts')).toHaveLength(0)
  expect(await db.query('SELECT 1 FROM audit_log')).toHaveLength(0)
})

test('a nested transaction() joins the outer one and rolls back with it', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  await expect(
    db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana')", [loc])
      })
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')
  expect(await db.query('SELECT 1 FROM contacts')).toHaveLength(0)
})

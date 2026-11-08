import { addLocation, freshDb } from '../test-utils/pglite'

const insert = (db: Awaited<ReturnType<typeof freshDb>>['db'], loc: string, action: string, extra: Record<string, unknown> = {}) =>
  db.query<{ id: string; chain_seq: string; prev_hash: string | null; row_hash: string }>(
    `INSERT INTO audit_log (location_id, actor_type, actor_id, action, entity_type, entity_id, contact_id, details)
     VALUES ($1,'operator','op1',$2,'contact','c1','c1',$3) RETURNING id, chain_seq, prev_hash, row_hash`,
    [loc, action, JSON.stringify(extra)],
  )

test('chains rows per location and stamps the time itself', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  const [a] = await insert(db, loc, 'contact.created')
  const [b] = await insert(db, loc, 'contact.updated', { fields: ['name'] })
  const [c] = await insert(db, loc, 'contact.archived')
  expect([a!.chain_seq, b!.chain_seq, c!.chain_seq].map(Number)).toEqual([1, 2, 3])
  expect(a!.prev_hash).toBeNull()
  expect(b!.prev_hash).toBe(a!.row_hash)
  expect(c!.prev_hash).toBe(b!.row_hash)
  expect(a!.row_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(new Set([a!.row_hash, b!.row_hash, c!.row_hash]).size).toBe(3)

  // A caller cannot backdate a row or pre-fill the chain columns.
  const [d] = await db.query<{ occurred_at: string; chain_seq: string }>(
    `INSERT INTO audit_log (location_id, actor_type, action, entity_type, occurred_at, chain_seq, prev_hash, row_hash)
     VALUES ($1,'system','x.y','x','2001-01-01T00:00:00Z', 99, 'forged', 'forged') RETURNING occurred_at, chain_seq`,
    [loc],
  )
  expect(Number(d!.chain_seq)).toBe(4)
  expect(new Date(d!.occurred_at).getFullYear()).toBeGreaterThan(2020)
})

test('each location has its own independent chain', async () => {
  const { db } = await freshDb()
  const l1 = await addLocation(db, 'loc_a')
  const l2 = await addLocation(db, 'loc_b')
  await insert(db, l1, 'a1')
  await insert(db, l1, 'a2')
  const [b1] = await insert(db, l2, 'b1')
  expect(Number(b1!.chain_seq)).toBe(1)
  expect(b1!.prev_hash).toBeNull()
})

test('rows cannot be updated, deleted or truncated', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  await insert(db, loc, 'contact.created')
  await expect(db.query("UPDATE audit_log SET action='tampered'")).rejects.toThrow(/append-only/)
  await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/)
  await expect(db.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/)
  expect(await db.query('SELECT 1 FROM audit_log')).toHaveLength(1)
})

test('a location with audit history cannot be deleted', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  await insert(db, loc, 'contact.created')
  await expect(db.query('DELETE FROM locations WHERE id=$1', [loc])).rejects.toThrow()
})

test('the log outlives the contact it describes (no foreign key on contact_id)', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana')", [loc])
  await insert(db, loc, 'contact.created')
  await db.query("DELETE FROM contacts WHERE id='c1'")
  expect(await db.query("SELECT 1 FROM audit_log WHERE contact_id='c1'")).toHaveLength(1)
})

test('audit_log_verify: intact chain -> NULL; altered content, broken link or gap -> first broken seq', async () => {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db)
  for (const a of ['one', 'two', 'three', 'four']) await insert(db, loc, a)
  // pg returns int8 as a string, PGlite as a number: normalize.
  const verify = async () => {
    const v = (await db.query<{ v: string | number | null }>('SELECT audit_log_verify($1) AS v', [loc]))[0]!.v
    return v === null ? null : Number(v)
  }

  expect(await verify()).toBeNull()
  expect(await verify()).toBeNull() // read-only: running it twice changes nothing

  // Tamper as a superuser who bypasses the guard triggers (what an attacker with
  // table access would have to do), then verify catches it.
  await pg.exec("SET session_replication_role = replica; UPDATE audit_log SET details = '{\"edited\":true}' WHERE chain_seq = 3; SET session_replication_role = DEFAULT;")
  expect(await verify()).toBe(3)

  await pg.exec("SET session_replication_role = replica; UPDATE audit_log SET details = '{}' WHERE chain_seq = 3; SET session_replication_role = DEFAULT;")
  expect(await verify()).toBeNull() // restored byte-for-byte -> intact again

  await pg.exec('SET session_replication_role = replica; DELETE FROM audit_log WHERE chain_seq = 2; SET session_replication_role = DEFAULT;')
  expect(await verify()).toBe(3) // a removed row breaks the link that follows it
})

test('concurrent writers on one location still produce one unbroken chain', async () => {
  const { db } = await freshDb()
  const loc = await addLocation(db)
  await Promise.all(Array.from({ length: 12 }, (_, i) => insert(db, loc, `act.${i}`)))
  const rows = await db.query<{ chain_seq: string }>('SELECT chain_seq FROM audit_log WHERE location_id=$1 ORDER BY chain_seq', [loc])
  expect(rows.map((r) => Number(r.chain_seq))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  expect((await db.query<{ v: string | number | null }>('SELECT audit_log_verify($1) AS v', [loc]))[0]!.v).toBeNull()
})

test('the schema can be applied twice (idempotent migration)', async () => {
  const { pg } = await freshDb()
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const sql = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')
  await expect(pg.exec(sql)).resolves.toBeDefined()
})

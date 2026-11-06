import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase } from '../db/pglite-database'
import { verifyPassword } from './password'
import { CLINICAL_CUSTOM_FIELDS, ONBOARDING_STAGES, seedPractice } from './practice-seed'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')

async function freshDb() {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  return new PgliteDatabase(pg)
}

const input = {
  practiceName: 'Consultorio Prueba',
  ownerEmail: 'Dra@Example.com',
  ownerName: 'Dra. Prueba',
  ownerPassword: 'a-long-enough-password',
}

const count = async (db: PgliteDatabase, sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string }>(sql, params))[0]?.n)

test('creates the location, owner, onboarding pipeline, calendar and clinical fields', async () => {
  const db = await freshDb()
  const r = await seedPractice(db, input)

  expect(r.createdOwner).toBe(true)
  const loc = (await db.query<{ name: string; settings: Record<string, any> }>('SELECT name, settings FROM locations WHERE id=$1', [r.locationId]))[0]!
  expect(loc.name).toBe('Consultorio Prueba')
  expect(loc.settings.timezone).toBe('America/Puerto_Rico')
  expect(loc.settings.practice.name).toBe('Consultorio Prueba')
  expect(loc.settings.enabledModules).toContain('session_notes')
  expect(loc.settings.enabledModules).not.toContain('assistant')

  // owner: email lowercased, password hashed (never stored), linked to the location
  const op = (await db.query<{ email: string; password_hash: string; role: string }>('SELECT email, password_hash, role FROM operators WHERE id=$1', [r.operatorId]))[0]!
  expect(op.email).toBe('dra@example.com')
  expect(op.role).toBe('owner')
  expect(op.password_hash).not.toContain('a-long-enough-password')
  expect(await verifyPassword(op.password_hash, 'a-long-enough-password')).toBe(true)
  expect(await count(db, 'SELECT count(*) AS n FROM operator_locations WHERE operator_id=$1 AND location_id=$2', [r.operatorId, r.locationId])).toBe(1)

  // onboarding pipeline: the six stages, in order, ids recorded in settings
  const stages = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM pipeline_stages WHERE pipeline_id=$1 ORDER BY position',
    [r.onboarding.pipelineId],
  )
  expect(stages.map((s) => s.name)).toEqual(ONBOARDING_STAGES.map((s) => s.name))
  for (const st of ONBOARDING_STAGES) {
    expect(r.onboarding.stages[st.key]).toBe(stages.find((s) => s.name === st.name)?.id)
  }
  expect(loc.settings.onboarding.pipelineId).toBe(r.onboarding.pipelineId)

  const cal = (await db.query<{ duration_min: number; timezone: string; booking_enabled: boolean }>('SELECT duration_min, timezone, booking_enabled FROM calendars WHERE location_id=$1', [r.locationId]))[0]!
  expect(cal).toEqual({ duration_min: 50, timezone: 'America/Puerto_Rico', booking_enabled: false })

  expect(await count(db, 'SELECT count(*) AS n FROM custom_fields WHERE location_id=$1', [r.locationId])).toBe(CLINICAL_CUSTOM_FIELDS.length)
})

test('is idempotent: a second run duplicates nothing and keeps the owner password', async () => {
  const db = await freshDb()
  const first = await seedPractice(db, input)
  const hashBefore = (await db.query<{ password_hash: string }>('SELECT password_hash FROM operators WHERE id=$1', [first.operatorId]))[0]!.password_hash

  // No password needed (and a different one is ignored) once the owner exists.
  const second = await seedPractice(db, { ...input, ownerPassword: 'a-DIFFERENT-long-password' })

  expect(second.createdOwner).toBe(false)
  expect(second.locationId).toBe(first.locationId)
  expect(second.operatorId).toBe(first.operatorId)
  expect(second.onboarding).toEqual(first.onboarding)
  expect((await db.query<{ password_hash: string }>('SELECT password_hash FROM operators WHERE id=$1', [first.operatorId]))[0]!.password_hash).toBe(hashBefore)
  expect(await count(db, 'SELECT count(*) AS n FROM locations')).toBe(1)
  expect(await count(db, 'SELECT count(*) AS n FROM operators')).toBe(1)
  expect(await count(db, 'SELECT count(*) AS n FROM pipelines')).toBe(1)
  expect(await count(db, 'SELECT count(*) AS n FROM pipeline_stages')).toBe(ONBOARDING_STAGES.length)
  expect(await count(db, 'SELECT count(*) AS n FROM calendars')).toBe(1)
  expect(await count(db, 'SELECT count(*) AS n FROM custom_fields')).toBe(CLINICAL_CUSTOM_FIELDS.length)
  await seedPractice(db, { ...input, ownerPassword: undefined })
})

test('does not overwrite settings the practice edited after the first seed', async () => {
  const db = await freshDb()
  const r = await seedPractice(db, input)
  await db.query(
    `UPDATE locations SET settings = settings || '{"enabledModules":["contacts"],"practice":{"name":"Renamed","license":"PR-1"}}'::jsonb WHERE id=$1`,
    [r.locationId],
  )
  await seedPractice(db, input)
  const s = (await db.query<{ settings: Record<string, any> }>('SELECT settings FROM locations WHERE id=$1', [r.locationId]))[0]!.settings
  expect(s.enabledModules).toEqual(['contacts'])
  expect(s.practice).toEqual({ name: 'Renamed', license: 'PR-1' })
  expect(s.onboarding.pipelineId).toBe(r.onboarding.pipelineId)
})

test('refuses to create a new owner without a strong password', async () => {
  const db = await freshDb()
  await expect(seedPractice(db, { ...input, ownerPassword: undefined })).rejects.toThrow(/ownerPassword is required/)
  await expect(seedPractice(db, { ...input, ownerPassword: 'short' })).rejects.toThrow(/at least 12/)
})

test('with a deployment SES sender, a new practice starts on Amazon SES; an existing choice is never overwritten', async () => {
  const db = await freshDb()
  const first = await seedPractice(db, { ...input, emailProvider: 'ses' })
  const sending = async () => (await db.query<{ s: any }>("SELECT settings->'sending' AS s FROM locations WHERE id=$1", [first.locationId]))[0]!.s
  expect(await sending()).toEqual({ emailProvider: 'ses', fromName: 'Consultorio Prueba' })

  // she later chooses another provider; running the seed again (every deploy) leaves it alone
  await db.query(`UPDATE locations SET settings = jsonb_set(settings, '{sending}', '{"emailProvider":"none"}') WHERE id=$1`, [first.locationId])
  await seedPractice(db, { ...input, emailProvider: 'ses' })
  expect(await sending()).toEqual({ emailProvider: 'none' })

  // with no SES sender configured, nothing is preset
  const plain = await freshDb()
  const p = await seedPractice(plain, input)
  expect((await plain.query<{ s: unknown }>("SELECT settings->'sending' AS s FROM locations WHERE id=$1", [p.locationId]))[0]!.s).toBeNull()
})

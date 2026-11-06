import { DEMO_LOGIN, seedPracticeDemo } from '../../db/seed-demo'
import { freshDb } from '../test-utils/pglite'
import { ageOn, isMinor, todayIn } from './age'
import { verifyPassword } from './password'

test('the demo practice has four fictional clients across the onboarding pipeline, one a minor, with real ages', async () => {
  const { db } = await freshDb()
  await seedPracticeDemo(db)

  const clients = await db.query<{ name: string; custom_fields: { date_of_birth: string } }>('SELECT name, custom_fields FROM contacts ORDER BY created_at')
  expect(clients.map((c) => c.name)).toEqual(['Ana Rivera', 'Luis Mora', 'Sofía Díaz (minor)', 'Carlos Vega'])
  const ages = Object.fromEntries(clients.map((c) => [c.name, ageOn(c.custom_fields.date_of_birth)]))
  expect(ages).toEqual({ 'Ana Rivera': 34, 'Luis Mora': 41, 'Sofía Díaz (minor)': 16, 'Carlos Vega': 47 })
  expect(clients.filter((c) => isMinor(c.custom_fields.date_of_birth)).map((c) => c.name)).toEqual(['Sofía Díaz (minor)'])

  const cards = await db.query<{ name: string; stage: string }>(
    `SELECT o.name, s.name AS stage FROM opportunities o JOIN pipeline_stages s ON s.id = o.stage_id ORDER BY o.position`,
  )
  expect(cards.map((c) => [c.name, c.stage])).toEqual([
    ['Ana Rivera', 'Documents sent'],
    ['Luis Mora', 'Documents signed'],
    ['Sofía Díaz (minor)', 'New contact'],
    ['Carlos Vega', 'Active client'],
  ])
})

test('the demo appointments are always still ahead, whatever time the demo boots', async () => {
  const { db } = await freshDb()
  await seedPracticeDemo(db)
  const rows = await db.query<{ starts_at: string | Date }>('SELECT starts_at FROM appointments ORDER BY starts_at')
  expect(rows).toHaveLength(3)
  for (const r of rows) expect(new Date(r.starts_at).getTime()).toBeGreaterThan(Date.now())
  expect(todayIn()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('the demo login works and re-running the seed changes nothing', async () => {
  const { db } = await freshDb()
  await seedPracticeDemo(db)
  const op = (await db.query<{ password_hash: string }>('SELECT password_hash FROM operators WHERE email=$1', [DEMO_LOGIN.email]))[0]!
  expect(await verifyPassword(op.password_hash, DEMO_LOGIN.password)).toBe(true)
  await seedPracticeDemo(db)
  expect(await db.query('SELECT 1 FROM operators')).toHaveLength(1)
  expect(await db.query('SELECT 1 FROM contacts')).toHaveLength(4)
  expect(await db.query('SELECT 1 FROM opportunities')).toHaveLength(4)
  expect(await db.query('SELECT 1 FROM appointments')).toHaveLength(3)
})

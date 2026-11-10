import { addLocation, freshDb } from '../test-utils/pglite'
import { enableModule } from './enable-module'
import { PSYCRM_DEFAULT_MODULES } from './modules'

async function setup(settings: unknown, slug = 'practice-a') {
  const { db } = await freshDb()
  const id = await addLocation(db, 'loc_a')
  await db.query('UPDATE locations SET slug = $2, settings = $3::jsonb WHERE id = $1', [id, slug, JSON.stringify(settings)])
  const other = await addLocation(db, 'loc_b')
  await db.query("UPDATE locations SET slug = 'practice-b', settings = $2::jsonb WHERE id = $1", [other, JSON.stringify({ enabledModules: ['contacts'] })])
  const settingsOf = async (loc: string) => (await db.query<{ settings: Record<string, unknown> }>('SELECT settings FROM locations WHERE id = $1', [loc]))[0]!.settings
  return { db, id, other, settingsOf }
}

test('a practice with a saved list gets the module added, and everything else in its settings is untouched', async () => {
  const s = await setup({ enabledModules: ['contacts', 'calendars'], timezone: 'America/Puerto_Rico', practice: { name: 'Consultorio' } })
  const r = await enableModule(s.db, 'practice-a', 'billing')
  expect(r).toEqual({ ok: true, changed: true, modules: ['contacts', 'calendars', 'billing'] })
  expect(await s.settingsOf(s.id)).toEqual({ enabledModules: ['contacts', 'calendars', 'billing'], timezone: 'America/Puerto_Rico', practice: { name: 'Consultorio' } })
})

test('it is idempotent: the second run changes nothing and writes nothing to the audit log', async () => {
  const s = await setup({ enabledModules: ['contacts'] })
  await enableModule(s.db, 'practice-a', 'billing')
  const again = await enableModule(s.db, 'practice-a', 'billing')
  expect(again).toMatchObject({ ok: true, changed: false })
  expect((await s.settingsOf(s.id)).enabledModules).toEqual(['contacts', 'billing'])
  expect(await s.db.query("SELECT 1 FROM audit_log WHERE action = 'practice.module_enabled'")).toHaveLength(1)
})

test('the change is audited with the module name only, as a system action', async () => {
  const s = await setup({ enabledModules: ['contacts'] })
  await enableModule(s.db, 'practice-a', 'billing')
  const rows = await s.db.query<{ actor_type: string; actor_label: string; details: Record<string, unknown>; location_id: string }>("SELECT actor_type, actor_label, details, location_id FROM audit_log WHERE action = 'practice.module_enabled'")
  expect(rows).toEqual([{ actor_type: 'system', actor_label: 'Operations script', details: { module: 'billing', hadSavedList: true }, location_id: s.id }])
})

test('a name that is not a module is refused and nothing is saved, so a typo cannot be stored', async () => {
  const s = await setup({ enabledModules: ['contacts'] })
  for (const bad of ['billin', 'Billing', '', 'drop table', 'contacts; x']) expect(await enableModule(s.db, 'practice-a', bad)).toEqual({ ok: false, error: 'unknown_module' })
  expect((await s.settingsOf(s.id)).enabledModules).toEqual(['contacts'])
})

test('an unknown practice is reported, and another practice is never touched', async () => {
  const s = await setup({ enabledModules: ['contacts'] })
  expect(await enableModule(s.db, 'nobody', 'billing')).toEqual({ ok: false, error: 'unknown_practice' })
  await enableModule(s.db, 'practice-a', 'billing')
  expect((await s.settingsOf(s.other)).enabledModules).toEqual(['contacts'])
})

test('a practice with no saved list already follows the defaults: a default module is "already on", another is added to them', async () => {
  const s = await setup({ timezone: 'America/Puerto_Rico' })
  expect(await enableModule(s.db, 'practice-a', 'calendars')).toMatchObject({ ok: true, changed: false })
  expect((await s.settingsOf(s.id)).enabledModules).toBeUndefined() // nothing was written
  const r = await enableModule(s.db, 'practice-a', 'marketing')
  expect(r).toEqual({ ok: true, changed: true, modules: [...PSYCRM_DEFAULT_MODULES, 'marketing'] })
  expect((await s.settingsOf(s.id)).timezone).toBe('America/Puerto_Rico')
})

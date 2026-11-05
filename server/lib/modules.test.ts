import { ALL_MODULES, PSYCRM_DEFAULT_MODULES, enabledModules, isModule } from './modules'

test('falls back to the PsyCRM default when settings carry no list', () => {
  expect(enabledModules(undefined)).toEqual([...PSYCRM_DEFAULT_MODULES])
  expect(enabledModules({})).toEqual([...PSYCRM_DEFAULT_MODULES])
  expect(enabledModules({ enabledModules: 'contacts' })).toEqual([...PSYCRM_DEFAULT_MODULES])
  expect(enabledModules(null)).toEqual([...PSYCRM_DEFAULT_MODULES])
})

test('honors a configured list and drops unknown names and duplicates', () => {
  expect(enabledModules({ enabledModules: ['contacts', 'nope', 'contacts', 'blog'] })).toEqual([
    'contacts',
    'blog',
  ])
})

test('an explicitly empty list means nothing is enabled', () => {
  expect(enabledModules({ enabledModules: [] })).toEqual([])
})

test('every default module is a known module and the default hides the risky ones', () => {
  for (const m of PSYCRM_DEFAULT_MODULES) expect(isModule(m)).toBe(true)
  for (const risky of ['assistant', 'conversations', 'social', 'communities', 'blog', 'affiliates', 'calls']) {
    expect(PSYCRM_DEFAULT_MODULES).not.toContain(risky)
    expect(ALL_MODULES).toContain(risky)
  }
})

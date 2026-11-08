import { INTEGRATIONS, INTEGRATION_NAMES, isIntegration, parseIntegrations } from './integrations'

test('every integration documents what it mounts and which vendor receives data', () => {
  expect(INTEGRATION_NAMES.length).toBeGreaterThan(0)
  for (const name of INTEGRATION_NAMES) {
    expect(INTEGRATIONS[name].label, name).toBeTruthy()
    expect(INTEGRATIONS[name].mounts, name).toBeTruthy()
    expect(INTEGRATIONS[name].vendor, name).toBeTruthy()
  }
})

test('parseIntegrations: empty/unset is none; names are normalized; unknown names are reported, never dropped silently', () => {
  expect(parseIntegrations(undefined)).toEqual({ enabled: [], unknown: [] })
  expect(parseIntegrations('')).toEqual({ enabled: [], unknown: [] })
  expect(parseIntegrations(' Voice , payments,voice')).toEqual({ enabled: ['voice', 'payments'], unknown: [] })
  expect(parseIntegrations('voice,nope,  ,also-nope')).toEqual({ enabled: ['voice'], unknown: ['nope', 'also-nope'] })
})

test('isIntegration only accepts registry names', () => {
  expect(isIntegration('chatwoot')).toBe(true)
  expect(isIntegration('constructor')).toBe(false) // not a prototype lookup
  expect(isIntegration('')).toBe(false)
})

import { assignSigner, validateSignerRoles } from './document-assignment'

test('a document goes to the signer whose role it names; a guardian covers client documents', () => {
  expect(assignSigner(['client'], [{ role: 'client' }])).toEqual({ role: 'client' })
  expect(assignSigner(['guardian'], [{ role: 'guardian' }, { role: 'minor' }])).toEqual({ role: 'guardian' })
  expect(assignSigner(['minor'], [{ role: 'guardian' }, { role: 'minor' }])).toEqual({ role: 'minor' })
  expect(assignSigner(['client'], [{ role: 'guardian' }, { role: 'minor' }])).toEqual({ role: 'guardian' })
  expect(assignSigner(['minor'], [{ role: 'guardian' }])).toBeNull()
  expect(assignSigner(['client', 'guardian'], [{ role: 'guardian' }, { role: 'client' }])).toEqual({ role: 'guardian' }) // first exact match
})

test('who must sign: the client for an adult packet, the guardian for a minor packet', () => {
  expect(validateSignerRoles('adult', ['client'])).toEqual([])
  expect(validateSignerRoles('adult', [])).toEqual(['client_required'])
  expect(validateSignerRoles('adult', ['client', 'guardian'])).toEqual(['guardian_not_allowed'])
  expect(validateSignerRoles('adolescent', ['guardian'])).toEqual([])
  expect(validateSignerRoles('adolescent', ['guardian', 'minor'])).toEqual([])
  expect(validateSignerRoles('adolescent', ['minor'])).toEqual(['guardian_required'])
  expect(validateSignerRoles('adolescent', ['client', 'guardian'])).toEqual(['client_not_allowed'])
  expect(validateSignerRoles('adult', ['client', 'client'])).toContain('duplicate_role')
})

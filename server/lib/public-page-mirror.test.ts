import { readFileSync } from 'node:fs'
import { DAYS, DAY_LABEL, DEFAULT_ACKS, LIMITS, MODES, MODE_LABEL, NO_INSURANCE_ACK, SLOTS, SLOT_LABEL } from './public-page'

const web = readFileSync(new URL('../../src/lib/public-page.ts', import.meta.url), 'utf8')

test('the web copy of the public page vocabulary matches the server', () => {
  const list = (name: string) => [...(new RegExp(`export const ${name}[^=]*= \\[([^\\]]*)\\]`).exec(web)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
  expect(list('DAYS')).toEqual([...DAYS])
  expect(list('SLOTS')).toEqual([...SLOTS])
  expect(list('MODES')).toEqual([...MODES])
  expect(list('DEFAULT_ACKS')).toEqual([...DEFAULT_ACKS])
  expect(web).toContain(`NO_INSURANCE_ACK = '${NO_INSURANCE_ACK}'`)
})

test('labels and limits match', () => {
  const labels = (name: string) => Object.fromEntries([...(new RegExp(`export const ${name}[^=]*= \\{([^}]*)\\}`).exec(web)?.[1] ?? '').matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]))
  expect(labels('DAY_LABEL')).toEqual(DAY_LABEL)
  expect(labels('SLOT_LABEL')).toEqual(SLOT_LABEL)
  expect(labels('MODE_LABEL')).toEqual(MODE_LABEL)
  const lim = Object.fromEntries([...(/export const LIMITS = \{([^}]*)\}/.exec(web)?.[1] ?? '').matchAll(/(\w+): (\d+)/g)].map((m) => [m[1], Number(m[2])]))
  expect(lim).toEqual(LIMITS)
})

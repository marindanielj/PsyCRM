import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('the web copy of the clinical vocabulary is identical to the server file (below its banner)', () => {
  const server = read('./clinical-vocab.ts')
  const web = read('../../src/lib/clinical-vocab.ts')
  expect(web.endsWith(server)).toBe(true)
  const banner = web.slice(0, web.length - server.length)
  expect(banner).toMatch(/^\/\/ Web copy of server\/lib\/clinical-vocab\.ts/)
  expect(banner.split('\n').length).toBeLessThanOrEqual(4) // only the 3 comment lines
})

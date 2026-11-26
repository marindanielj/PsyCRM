import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

// The video call died for everyone on `ReferenceError: global is not defined`: Chime's browser code expects Node's `global`,
// and Vite's library mode does not provide it. Nothing in the server tests starts a real call, so guard the fix here.
test('the browser bundle of the call is built with Node\'s global and NODE_ENV defined', () => {
  const cfg = read('../../vite.video.config.ts')
  expect(cfg).toMatch(/global:\s*'globalThis'/)
  expect(cfg).toMatch(/'process\.env\.NODE_ENV':\s*JSON\.stringify\('production'\)/)
})

test('the Docker build carries what the video bundle needs', () => {
  const docker = read('../../Dockerfile')
  expect(docker).toContain('vite.video.config.ts')
  expect(docker).toContain('COPY client-video')
  expect(read('../../package.json')).toContain('vite build -c vite.video.config.ts')
})

test('a call that never comes up is reported instead of left on a black screen', () => {
  const entry = read('../../client-video/entry.ts')
  expect(entry).toContain("finish('ConnectTimeout')")
  expect(entry).toMatch(/CONNECT_TIMEOUT_MS = \d/)
})

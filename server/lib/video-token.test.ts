import { looksLikeToken } from './document-tokens'
import { videoToken, videoTokenHash } from './video-token'

test('a meeting\'s token is stable, link-shaped, and differs by meeting and by secret', () => {
  const t = videoToken('m1', 's3cret')
  expect(t).toBe(videoToken('m1', 's3cret'))
  expect(looksLikeToken(t)).toBe(true)
  expect(videoToken('m2', 's3cret')).not.toBe(t)
  expect(videoToken('m1', 'other')).not.toBe(t)
})

test('only the hash of the token is what gets stored', () => {
  const t = videoToken('m1', 's3cret')
  expect(videoTokenHash(t)).toMatch(/^[0-9a-f]{64}$/)
  expect(videoTokenHash(t)).not.toContain(t)
})

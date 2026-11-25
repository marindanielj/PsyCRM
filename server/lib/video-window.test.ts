import { videoWindow } from './video-window'

const START = '2026-06-04T15:00:00Z'
const END = '2026-06-04T15:50:00Z'
const at = (iso: string) => videoWindow(START, END, new Date(iso)).state

test('the link opens 15 minutes before the start', () => {
  expect(at('2026-06-04T14:44:59Z')).toBe('not_yet')
  expect(at('2026-06-04T14:45:00Z')).toBe('open')
})

test('the link stays open through the session and 60 minutes after its scheduled end', () => {
  expect(at('2026-06-04T15:30:00Z')).toBe('open')
  expect(at('2026-06-04T16:49:59Z')).toBe('open')
  expect(at('2026-06-04T16:50:00Z')).toBe('ended')
})

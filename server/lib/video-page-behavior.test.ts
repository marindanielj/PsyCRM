import { renderVideoPage } from './video-page'
import { renderVideoRoomPage } from './video-room-page'

/**
 * The call pages' scripts, run against a tiny fake page. The test decides when the browser's camera permission is
 * answered and when the 3-second status check fires, which is exactly what the two real bugs depended on.
 */
interface El { hidden: boolean; disabled: boolean; textContent: string; value: string; checked: boolean; handlers: Record<string, () => void>; onclick?: () => void; addEventListener(t: string, f: () => void): void }
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }

function harness(script: string, replies: (url: string) => unknown) {
  const els = new Map<string, El>()
  const el = (id: string): El => {
    if (!els.has(id)) els.set(id, { hidden: false, disabled: false, textContent: '', value: '', checked: false, handlers: {}, addEventListener(t, f) { this.handlers[t] = f } })
    return els.get(id)!
  }
  const intervals: Array<() => void> = []
  const joinCalls: Array<{ opts: Record<string, (...a: unknown[]) => void>; resolve: (h: unknown) => void; reject: (e: unknown) => void }> = []
  const win = {
    addEventListener() {},
    PsyVideo: { join: (opts: never) => new Promise((resolve, reject) => joinCalls.push({ opts, resolve, reject })) },
  }
  const fetchMock = async (url: string) => ({ status: 200, json: async () => replies(url) })
  new Function('document', 'window', 'fetch', 'setInterval', 'clearInterval', 'navigator', 'location', script)(
    { getElementById: el },
    win,
    fetchMock,
    (fn: () => void) => { intervals.push(fn); return intervals.length },
    () => {},
    { sendBeacon() {} },
    { origin: 'https://x.test' },
  )
  return { el, intervals, joinCalls, visible: (...ids: string[]) => ids.filter((i) => !el(i).hidden) }
}
const scriptOf = (html: string) => [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]!).at(-1)!

const clientHtml = renderVideoPage({ practice: 'P', nonce: 'n', token: 'T'.repeat(43), state: 'admitted' })
const CLIENT_REPLIES = (url: string) => (url.endsWith('/join') ? { ok: true, meeting: { MeetingId: 'm' }, attendee: { AttendeeId: 'a' } } : { state: 'open', admitted: true, ended: false })

test('the client stays in the call screen while the browser waits for the camera permission (the status check must not flip the page back)', async () => {
  const h = harness(scriptOf(clientHtml), CLIENT_REPLIES)
  h.el('join').handlers.click!()
  await tick()
  expect(h.visible('ready', 'incall')).toEqual(['incall'])
  expect(h.joinCalls).toHaveLength(1) // the call is starting; the permission prompt is open: no call handle yet

  h.intervals[0]!() // the 3-second status check fires while the person is still deciding
  await tick()
  expect(h.visible('ready', 'incall')).toEqual(['incall']) // it used to show the waiting card again, for good
  expect(h.el('join').disabled).toBe(true)

  h.joinCalls[0]!.resolve({ leave() {}, setMuted() {}, setCamera: async () => {} }) // the person clicked Allow
  await tick()
  h.intervals[0]!()
  await tick()
  expect(h.visible('ready', 'incall')).toEqual(['incall'])
})

test('a call that fails goes back to the waiting card with a reason and a working button; a normal end shows the end screen', async () => {
  const failed = harness(scriptOf(clientHtml), CLIENT_REPLIES)
  failed.el('join').handlers.click!()
  await tick()
  failed.joinCalls[0]!.resolve({ leave() {}, setMuted() {}, setCamera: async () => {} })
  failed.joinCalls[0]!.opts.onEnd!('ConnectTimeout')
  await tick()
  expect(failed.visible('ready', 'incall')).toEqual(['ready'])
  expect(failed.el('join').disabled).toBe(false)
  expect(failed.el('e2').textContent).toContain('conexión de video')
  failed.intervals[0]!()
  await tick()
  expect(failed.visible('ready', 'incall', 'over')).toEqual(['ready']) // and the status check leaves it alone

  const normal = harness(scriptOf(clientHtml), CLIENT_REPLIES)
  normal.el('join').handlers.click!()
  await tick()
  normal.joinCalls[0]!.opts.onEnd!('MeetingEnded')
  await tick()
  expect(normal.visible('ready', 'incall', 'over')).toEqual(['over'])
})

test('the "waiting for the other person" label shows until someone else is in the room', async () => {
  const h = harness(scriptOf(clientHtml), CLIENT_REPLIES)
  h.el('join').handlers.click!()
  await tick()
  expect(h.el('peer').hidden).toBe(false)
  h.joinCalls[0]!.opts.onPeer!(true)
  expect(h.el('peer').hidden).toBe(true)
  h.joinCalls[0]!.opts.onPeer!(false)
  expect(h.el('peer').hidden).toBe(false)
})

test('the therapist\'s Open the room button is not re-enabled by the refresh while the call is starting', async () => {
  const html = renderVideoRoomPage({ title: 'T', base: '/api/loc/l/video/appointments/a', nonce: 'n', startsLabel: 'x' })
  const VIDEO = { link: '/v/x', waiting: false, admitted: false, ended: false, consentSigned: true, clientConfirmation: null, window: { state: 'open', opensAt: new Date().toISOString(), closesAt: new Date().toISOString() } }
  const h = harness(scriptOf(html), (url) => (url.endsWith('/video/join') ? { ok: true, meeting: {}, attendee: {} } : { ok: true, video: VIDEO }))
  await tick()
  expect(h.el('open').disabled).toBe(false)
  h.el('open').onclick!()
  await tick()
  expect(h.visible('gate', 'incall')).toEqual(['incall'])
  h.intervals[0]!() // refresh() while the permission prompt is open
  await tick()
  expect(h.el('open').disabled).toBe(true)
  h.joinCalls[0]!.opts.onEnd!('TaskFailed')
  await tick()
  expect(h.visible('gate', 'incall')).toEqual(['gate'])
  expect(h.el('open').disabled).toBe(false)
  expect(h.el('err').textContent).toContain('TaskFailed')
})

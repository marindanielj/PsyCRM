/**
 * The browser bundle (client-video/entry.ts) against a stand-in for Chime's library. Nothing here touches a network: the stand-in
 * records what the bundle asks of the SDK and lets the test fire the SDK's events, which is how a bad connection arrives.
 */
const sdk = vi.hoisted(() => {
  const state = {
    observers: [] as Array<Record<string, (...a: unknown[]) => void>>,
    presence: undefined as undefined | ((id: string, present: boolean) => void),
    calls: [] as string[],
  }
  const rec = (name: string, result?: unknown) => (..._a: unknown[]) => { state.calls.push(name); return result }
  const av = {
    addObserver: (o: Record<string, (...a: unknown[]) => void>) => { state.calls.push('addObserver'); state.observers.push(o) },
    realtimeSubscribeToAttendeeIdPresence: (cb: (id: string, present: boolean) => void) => { state.calls.push('presence'); state.presence = cb },
    listAudioInputDevices: async () => [{ deviceId: 'mic1' }],
    listVideoInputDevices: async () => [{ deviceId: 'cam1' }],
    startAudioInput: async () => { state.calls.push('startAudioInput') },
    startVideoInput: async () => { state.calls.push('startVideoInput') },
    startVideoPreviewForVideoInput: rec('preview'),
    stopVideoPreviewForVideoInput: rec('stopPreview'),
    startLocalVideoTile: rec('startLocalVideoTile', 1),
    stopLocalVideoTile: rec('stopLocalVideoTile'),
    stopVideoInput: async () => { state.calls.push('stopVideoInput') },
    stopAudioInput: async () => { state.calls.push('stopAudioInput') },
    bindAudioElement: rec('bindAudio'),
    bindVideoElement: (tileId: number, el: unknown) => { state.calls.push(`bindVideo:${tileId}:${(el as { name: string }).name}`) },
    start: rec('start'),
    stop: rec('stop'),
    realtimeMuteLocalAudio: rec('mute'),
    realtimeUnmuteLocalAudio: rec('unmute'),
  }
  return { state, av }
})

vi.mock('amazon-chime-sdk-js', () => {
  class ConsoleLogger {}
  class DefaultDeviceController {}
  class MeetingSessionConfiguration { credentials = { attendeeId: 'me' } }
  class DefaultMeetingSession { audioVideo = sdk.av }
  const MeetingSessionStatusCode = { OK: 0, Left: 1, MeetingEnded: 5, TaskFailed: 18, 0: 'OK', 1: 'Left', 5: 'MeetingEnded', 18: 'TaskFailed' } as Record<string | number, string | number>
  return { ConsoleLogger, DefaultDeviceController, DefaultMeetingSession, LogLevel: { WARN: 0 }, MeetingSessionConfiguration, MeetingSessionStatusCode }
})

type Join = (o: Record<string, unknown>) => Promise<{ leave(): void; setCamera(on: boolean): Promise<void> }>
const els = { audioEl: { name: 'audio' }, remoteVideoEl: { name: 'remote' }, localVideoEl: { name: 'local' } }

async function start(extra: Record<string, unknown> = {}) {
  sdk.state.observers.length = 0
  sdk.state.calls.length = 0
  await import('../../client-video/entry')
  const join = (globalThis as unknown as { PsyVideo: { join: Join } }).PsyVideo.join
  const events: Array<[string, unknown?]> = []
  const handle = await join({
    meeting: {}, attendee: {}, ...els,
    onEnd: (r: string) => events.push(['end', r]),
    onConnected: () => events.push(['connected']),
    onPeer: (p: boolean) => events.push(['peer', p]),
    onConnection: (s: string) => events.push(['connection', s]),
    onSuggestStopVideo: () => events.push(['suggestStopVideo']),
    ...extra,
  })
  return { handle, events, observer: sdk.state.observers[0]! }
}

test('the bundle listens for the SDK\'s events BEFORE it touches the camera (the SDK announces the video tile only once)', async () => {
  await start()
  const calls = sdk.state.calls
  expect(calls.indexOf('addObserver')).toBeGreaterThanOrEqual(0)
  expect(calls.indexOf('addObserver')).toBeLessThan(calls.indexOf('startVideoInput'))
  expect(calls.indexOf('addObserver')).toBeLessThan(calls.indexOf('startAudioInput'))
})

test('our own picture comes straight from the camera; the call is sent into only once it has started', async () => {
  const { observer } = await start()
  expect(sdk.state.calls).toContain('preview')
  expect(sdk.state.calls).not.toContain('startLocalVideoTile') // no call yet
  observer.audioVideoDidStart!()
  expect(sdk.state.calls).toContain('startLocalVideoTile')
})

test('only the other person\'s picture goes in the big panel; our own tile is not bound over the preview', async () => {
  const { observer } = await start()
  observer.videoTileDidUpdate!({ tileId: 7, localTile: false, isContent: false })
  observer.videoTileDidUpdate!({ tileId: 8, localTile: true, isContent: false })
  observer.videoTileDidUpdate!({ tileId: 9, localTile: false, isContent: true })
  expect(sdk.state.calls.filter((c) => c.startsWith('bindVideo'))).toEqual(['bindVideo:7:remote'])
})

test('a dropped heartbeat shows as reconnecting, recovery as good, and a poor connection as poor, then good again', async () => {
  const { observer, events } = await start()
  observer.audioVideoDidStartConnecting!(false) // the first connection is not a "reconnect"
  observer.audioVideoDidStart!()
  expect(events).toEqual([['connected']])

  observer.audioVideoDidStartConnecting!(true) // pongs stopped arriving; the SDK reconnects by itself
  observer.audioVideoDidStart!() // and it is back
  observer.connectionDidBecomePoor!()
  observer.connectionDidBecomeGood!()
  expect(events.slice(1)).toEqual([['connection', 'reconnecting'], ['connected'], ['connection', 'good'], ['connection', 'poor'], ['connection', 'good']])
})

test('the "turn your video off" suggestion is passed on only while the camera is on', async () => {
  const { handle, observer, events } = await start()
  observer.connectionDidSuggestStopVideo!()
  expect(events).toContainEqual(['suggestStopVideo'])
  events.length = 0
  await handle.setCamera(false)
  observer.connectionDidSuggestStopVideo!()
  expect(events).toEqual([])
  expect(sdk.state.calls).toContain('stopVideoInput')
})

test('someone else arriving or leaving is reported; our own presence is not', async () => {
  const { events } = await start()
  sdk.state.presence!('me', true)
  sdk.state.presence!('them', true)
  sdk.state.presence!('them', false)
  expect(events).toEqual([['peer', true], ['peer', false]])
})

test('an abnormal end names the SDK\'s status, ends once, and turns the camera and microphone off', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const { observer, events } = await start()
    sdk.state.calls.length = 0
    observer.audioVideoDidStop!({ statusCode: () => 18 })
    observer.audioVideoDidStop!({ statusCode: () => 1 }) // the SDK's second, less useful report after a failure
    expect(events).toEqual([['end', 'TaskFailed']])
    expect(sdk.state.calls).toEqual(expect.arrayContaining(['stopLocalVideoTile', 'stopPreview', 'stopVideoInput', 'stopAudioInput']))
  } finally {
    err.mockRestore()
  }
})

test('leaving turns the camera off and stops the call', async () => {
  const { handle } = await start()
  sdk.state.calls.length = 0
  handle.leave()
  expect(sdk.state.calls).toEqual(expect.arrayContaining(['stopVideoInput', 'stopAudioInput', 'stop']))
})

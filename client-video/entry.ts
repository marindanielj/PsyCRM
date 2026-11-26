import { ConsoleLogger, DefaultDeviceController, DefaultMeetingSession, LogLevel, MeetingSessionConfiguration, MeetingSessionStatusCode } from 'amazon-chime-sdk-js'

/**
 * The browser half of a video session, bundled to one script (dist/video/chime-client.js) and used by
 * the client page (/v/<token>) and the therapist's room. It only turns the credentials the server
 * handed out into a call; it never talks to our API and nothing is recorded.
 */
export interface JoinOptions {
  meeting: unknown
  attendee: unknown
  audioEl: HTMLAudioElement
  remoteVideoEl: HTMLVideoElement
  localVideoEl: HTMLVideoElement
  /**
   * The call ended. `reason` is the SDK's own status name: Left, MeetingEnded and OK are a normal end; anything else
   * (SignalingBadRequest, TURNCredentialsForbidden, AudioCallAtCapacity...) is a failure the page should explain.
   */
  onEnd: (reason: string) => void
  /** The call is up: media is flowing. Until then the page shows "connecting". */
  onConnected?: () => void
  /** No camera or microphone could be used (permission denied, none present). */
  onDeviceProblem?: (what: 'camera' | 'microphone') => void
}

export interface CallHandle {
  leave(): void
  setMuted(muted: boolean): void
  setCamera(on: boolean): Promise<void>
}

async function startCall(o: JoinOptions): Promise<CallHandle> {
  const logger = new ConsoleLogger('call', LogLevel.WARN)
  const devices = new DefaultDeviceController(logger)
  const config = new MeetingSessionConfiguration(o.meeting as never, o.attendee as never)
  const session = new DefaultMeetingSession(config, logger, devices)
  const av = session.audioVideo

  try {
    const mics = await av.listAudioInputDevices()
    if (!mics[0]) throw new Error('no microphone')
    await av.startAudioInput(mics[0].deviceId)
  } catch (err) {
    console.warn('microphone unavailable', err)
    o.onDeviceProblem?.('microphone')
  }
  const startCamera = async () => {
    const cams = await av.listVideoInputDevices()
    if (!cams[0]) throw new Error('no camera')
    await av.startVideoInput(cams[0].deviceId)
    av.startLocalVideoTile()
  }
  try {
    await startCamera()
  } catch (err) {
    console.warn('camera unavailable', err)
    o.onDeviceProblem?.('camera')
  }

  av.bindAudioElement(o.audioEl)
  // A call that never comes up must say so: on a network that blocks the media connection the SDK just keeps retrying.
  const CONNECT_TIMEOUT_MS = 25_000
  let connected = false
  let ended = false
  // The first reason wins: stopping the call after a timeout makes the SDK report a second, less useful one.
  const finish = (reason: string) => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    o.onEnd(reason)
  }
  const timer = setTimeout(() => {
    if (connected) return
    console.error('call did not connect in', CONNECT_TIMEOUT_MS, 'ms')
    finish('ConnectTimeout')
    av.stop()
  }, CONNECT_TIMEOUT_MS)
  av.addObserver({
    audioVideoDidStart() {
      connected = true
      clearTimeout(timer)
      o.onConnected?.()
    },
    videoTileDidUpdate(tile) {
      if (!tile.tileId || tile.isContent) return
      av.bindVideoElement(tile.tileId, tile.localTile ? o.localVideoEl : o.remoteVideoEl)
    },
    audioVideoDidStop(status) {
      const code = status.statusCode()
      const name = MeetingSessionStatusCode[code] ?? String(code)
      if (!ended && !['OK', 'Left', 'MeetingEnded'].includes(name)) console.error('call ended abnormally', name)
      finish(name)
    },
  })
  av.start()

  return {
    leave() {
      av.stopLocalVideoTile()
      av.stop()
    },
    setMuted(muted) {
      if (muted) av.realtimeMuteLocalAudio()
      else av.realtimeUnmuteLocalAudio()
    },
    async setCamera(on) {
      if (on) await startCamera()
      else av.stopLocalVideoTile()
    },
  }
}

/** Logs why starting a call failed to the browser console (where a person helping can read it), then lets the page explain. */
async function join(o: JoinOptions): Promise<CallHandle> {
  try {
    return await startCall(o)
  } catch (err) {
    console.error('join failed', err)
    throw err
  }
}

;(globalThis as unknown as { PsyVideo: { join: typeof join } }).PsyVideo = { join }

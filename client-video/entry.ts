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
  /** Whether anyone besides us is in the room (true/false as people come and go). */
  onPeer?: (present: boolean) => void
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
  const selfId = config.credentials?.attendeeId ?? null

  // A call that never comes up must say so: on a network that blocks the media connection the SDK just keeps retrying.
  const CONNECT_TIMEOUT_MS = 25_000
  let connected = false
  let ended = false
  let cameraOn = false
  const releaseDevices = () => {
    try {
      av.stopLocalVideoTile()
      av.stopVideoPreviewForVideoInput(o.localVideoEl)
    } catch {
      /* already stopped */
    }
    void av.stopVideoInput().catch(() => undefined) // turns the camera light off
    void av.stopAudioInput().catch(() => undefined)
  }
  // The first reason wins: stopping the call after a timeout makes the SDK report a second, less useful one.
  const finish = (reason: string) => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    releaseDevices()
    o.onEnd(reason)
  }
  const timer = setTimeout(() => {
    if (connected) return
    console.error('call did not connect in', CONNECT_TIMEOUT_MS, 'ms')
    finish('ConnectTimeout')
    av.stop()
  }, CONNECT_TIMEOUT_MS)

  // Listen FIRST. The SDK announces a video tile once, when it is created; a listener added afterwards never hears it,
  // which left the therapist's own panel black.
  const others = new Set<string>()
  av.addObserver({
    audioVideoDidStart() {
      connected = true
      clearTimeout(timer)
      if (cameraOn) av.startLocalVideoTile() // now there is a call to send the picture into
      o.onConnected?.()
    },
    videoTileDidUpdate(tile) {
      // Only the OTHER person's picture goes in the big panel; our own preview comes straight from the camera below.
      if (!tile.tileId || tile.isContent || tile.localTile) return
      av.bindVideoElement(tile.tileId, o.remoteVideoEl)
    },
    audioVideoDidStop(status) {
      const code = status.statusCode()
      const name = MeetingSessionStatusCode[code] ?? String(code)
      if (!ended && !['OK', 'Left', 'MeetingEnded'].includes(name)) console.error('call ended abnormally', name)
      finish(name)
    },
  })
  // Who else is in the room, so the page can say "waiting for the other person" instead of showing a black panel.
  av.realtimeSubscribeToAttendeeIdPresence((attendeeId, present) => {
    if (attendeeId === selfId) return
    if (present) others.add(attendeeId)
    else others.delete(attendeeId)
    o.onPeer?.(others.size > 0)
  })

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
    av.startVideoPreviewForVideoInput(o.localVideoEl) // our own picture, straight from the camera
    cameraOn = true
    if (connected) av.startLocalVideoTile()
  }
  try {
    await startCamera()
  } catch (err) {
    console.warn('camera unavailable', err)
    o.onDeviceProblem?.('camera')
  }

  av.bindAudioElement(o.audioEl)
  av.start()

  return {
    leave() {
      releaseDevices()
      av.stop()
    },
    setMuted(muted) {
      if (muted) av.realtimeMuteLocalAudio()
      else av.realtimeUnmuteLocalAudio()
    },
    async setCamera(on) {
      if (on) {
        await startCamera()
      } else {
        cameraOn = false
        av.stopLocalVideoTile()
        av.stopVideoPreviewForVideoInput(o.localVideoEl)
        await av.stopVideoInput()
      }
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

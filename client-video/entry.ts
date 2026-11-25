import { ConsoleLogger, DefaultDeviceController, DefaultMeetingSession, LogLevel, MeetingSessionConfiguration } from 'amazon-chime-sdk-js'

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
  /** The call ended or the connection could not be recovered. */
  onEnd: (reason: string) => void
  /** No camera or microphone could be used (permission denied, none present). */
  onDeviceProblem?: (what: 'camera' | 'microphone') => void
}

export interface CallHandle {
  leave(): void
  setMuted(muted: boolean): void
  setCamera(on: boolean): Promise<void>
}

async function join(o: JoinOptions): Promise<CallHandle> {
  const logger = new ConsoleLogger('call', LogLevel.WARN)
  const devices = new DefaultDeviceController(logger)
  const config = new MeetingSessionConfiguration(o.meeting as never, o.attendee as never)
  const session = new DefaultMeetingSession(config, logger, devices)
  const av = session.audioVideo

  try {
    const mics = await av.listAudioInputDevices()
    if (!mics[0]) throw new Error('no microphone')
    await av.startAudioInput(mics[0].deviceId)
  } catch {
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
  } catch {
    o.onDeviceProblem?.('camera')
  }

  av.bindAudioElement(o.audioEl)
  av.addObserver({
    videoTileDidUpdate(tile) {
      if (!tile.tileId || tile.isContent) return
      av.bindVideoElement(tile.tileId, tile.localTile ? o.localVideoEl : o.remoteVideoEl)
    },
    audioVideoDidStop(status) {
      o.onEnd(String(status.statusCode()))
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

;(globalThis as unknown as { PsyVideo: { join: typeof join } }).PsyVideo = { join }

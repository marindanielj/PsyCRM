import {
  ChimeSDKMeetingsClient, CreateAttendeeCommand, CreateMeetingCommand, DeleteMeetingCommand,
  type Attendee, type Meeting,
} from '@aws-sdk/client-chime-sdk-meetings'

/** What the app needs from a video service. Amazon Chime SDK is the only real one; tests use the fake. */
export interface VideoProvider {
  /** A new room. `externalId` is our meeting id (no client data ever goes to the provider). */
  createMeeting(externalId: string): Promise<Meeting>
  /** Credentials for one person to enter the room. `externalUserId` is an opaque role label. */
  createAttendee(meetingId: string, externalUserId: string): Promise<Attendee>
  /** Close the room for everyone. A room already gone is not an error. */
  endMeeting(meetingId: string): Promise<void>
}

/** US East (N. Virginia) hosts the Chime control plane for Puerto Rico and the mainland US. */
export function chimeProvider(opts: { region: string; client?: Pick<ChimeSDKMeetingsClient, 'send'> }): VideoProvider {
  const client = opts.client ?? new ChimeSDKMeetingsClient({ region: opts.region })
  return {
    async createMeeting(externalId) {
      const out = await client.send(new CreateMeetingCommand({
        ClientRequestToken: externalId,
        ExternalMeetingId: externalId,
        MediaRegion: opts.region,
      }))
      if (!out.Meeting) throw new Error('chime returned no meeting')
      return out.Meeting
    },
    async createAttendee(meetingId, externalUserId) {
      const out = await client.send(new CreateAttendeeCommand({ MeetingId: meetingId, ExternalUserId: externalUserId }))
      if (!out.Attendee) throw new Error('chime returned no attendee')
      return out.Attendee
    },
    async endMeeting(meetingId) {
      try {
        await client.send(new DeleteMeetingCommand({ MeetingId: meetingId }))
      } catch (err) {
        if ((err as { name?: string }).name !== 'NotFoundException') throw err
      }
    },
  }
}

/** An in-memory provider for tests and local development: records calls, makes up ids. */
export function fakeVideoProvider(): VideoProvider & { meetings: string[]; attendees: Array<{ meetingId: string; externalUserId: string }>; ended: string[] } {
  const meetings: string[] = []
  const attendees: Array<{ meetingId: string; externalUserId: string }> = []
  const ended: string[] = []
  return {
    meetings, attendees, ended,
    async createMeeting(externalId) {
      meetings.push(externalId)
      return { MeetingId: `chime_${externalId}`, ExternalMeetingId: externalId, MediaRegion: 'us-east-1', MediaPlacement: { AudioHostUrl: 'fake', SignalingUrl: 'fake' } }
    },
    async createAttendee(meetingId, externalUserId) {
      attendees.push({ meetingId, externalUserId })
      return { AttendeeId: `att_${attendees.length}`, ExternalUserId: externalUserId, JoinToken: `join_${attendees.length}` }
    },
    async endMeeting(meetingId) {
      ended.push(meetingId)
    },
  }
}

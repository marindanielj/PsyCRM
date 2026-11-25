import { nanoid } from 'nanoid'
import { videoToken, videoTokenHash } from '../lib/video-token'
import { LocationScopedRepo } from './base-repo'

export interface VideoMeeting {
  id: string
  location_id: string
  appointment_id: string
  token_hash: string
  chime_meeting: Record<string, unknown> | null
  waiting_since: string | null
  admitted_at: string | null
  ended_at: string | null
  created_at: string
}

export type VideoRole = 'therapist' | 'client'
export type VideoEvent = 'waiting' | 'admitted' | 'joined' | 'left'

export class VideoMeetingsRepo extends LocationScopedRepo {
  async getByAppointment(appointmentId: string): Promise<VideoMeeting | undefined> {
    const rows = await this.scopedSelect<VideoMeeting>('SELECT * FROM video_meetings WHERE appointment_id=$2', [appointmentId])
    return rows[0]
  }

  /** The one room of an appointment, made on first use. Two racing callers end up with the same row. */
  async ensure(appointmentId: string, secret: string): Promise<VideoMeeting> {
    const id = nanoid()
    const rows = await this.scopedWrite<VideoMeeting>(
      `INSERT INTO video_meetings (id, location_id, appointment_id, token_hash)
       VALUES ($2,$1,$3,$4) ON CONFLICT (appointment_id) DO NOTHING RETURNING *`,
      [id, appointmentId, videoTokenHash(videoToken(id, secret))],
    )
    if (rows[0]) return rows[0]
    const existing = await this.getByAppointment(appointmentId)
    if (!existing) throw new Error('video meeting vanished after conflict')
    return existing
  }

  /** Keep the Chime meeting descriptor (first writer wins; Chime returns the same room for the same request token). */
  async setChimeMeeting(id: string, meeting: Record<string, unknown>): Promise<void> {
    await this.scopedWrite(
      'UPDATE video_meetings SET chime_meeting=$2 WHERE location_id=$1 AND id=$3 AND chime_meeting IS NULL',
      [JSON.stringify(meeting), id],
    )
  }

  async markWaiting(id: string): Promise<void> {
    await this.scopedWrite(
      'UPDATE video_meetings SET waiting_since=COALESCE(waiting_since, now()) WHERE location_id=$1 AND id=$2 AND ended_at IS NULL',
      [id],
    )
  }

  /** Let the waiting client in. False when nobody is waiting or the room is over. */
  async admit(id: string): Promise<boolean> {
    const rows = await this.scopedWrite<{ id: string }>(
      `UPDATE video_meetings SET admitted_at=COALESCE(admitted_at, now())
       WHERE location_id=$1 AND id=$2 AND waiting_since IS NOT NULL AND ended_at IS NULL RETURNING id`,
      [id],
    )
    return rows.length > 0
  }

  async end(id: string): Promise<void> {
    await this.scopedWrite('UPDATE video_meetings SET ended_at=COALESCE(ended_at, now()) WHERE location_id=$1 AND id=$2', [id])
  }

  /** Who came and went, when. Times only. */
  async addEvent(meetingId: string, role: VideoRole, event: VideoEvent): Promise<void> {
    await this.scopedWrite(
      'INSERT INTO video_meeting_events (id, location_id, meeting_id, role, event) VALUES ($2,$1,$3,$4,$5)',
      [nanoid(), meetingId, role, event],
    )
  }
}

import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
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
  client_location: string | null
  client_in_pr: boolean | null
  client_private: boolean | null
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

  /** The client came into the waiting room and said where she is. The first arrival's time is kept. */
  async markWaiting(id: string, confirmation: { location: string; inPuertoRico: boolean; privatePlace: boolean }): Promise<void> {
    await this.scopedWrite(
      `UPDATE video_meetings SET waiting_since=COALESCE(waiting_since, now()),
              client_location=$3, client_in_pr=$4, client_private=$5
       WHERE location_id=$1 AND id=$2 AND ended_at IS NULL`,
      [id, confirmation.location, confirmation.inPuertoRico, confirmation.privatePlace],
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

/** What the public link needs about the session behind it. */
export interface VideoLinkContext {
  locationId: string
  meeting: VideoMeeting
  appointment: { id: string; contact_id: string | null; modality: string; status: string; starts_at: string; ends_at: string }
}

/**
 * The room a link token points at, across all practices (the token is the credential, so there is no
 * location to scope by yet). Only the hash is compared. After this, every query is location-scoped.
 */
export async function findVideoByTokenHash(db: Database, tokenHash: string): Promise<VideoLinkContext | null> {
  const rows = await db.query<Record<string, any>>(
    `SELECT v.*, a.contact_id AS a_contact_id, a.modality AS a_modality, a.status AS a_status,
            a.starts_at AS a_starts_at, a.ends_at AS a_ends_at
       FROM video_meetings v JOIN appointments a ON a.id = v.appointment_id
      WHERE v.token_hash = $1`,
    [tokenHash],
  )
  const x = rows[0]
  if (!x) return null
  const { a_contact_id, a_modality, a_status, a_starts_at, a_ends_at, ...meeting } = x
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string))
  return {
    locationId: x.location_id,
    meeting: meeting as VideoMeeting,
    appointment: { id: x.appointment_id, contact_id: a_contact_id ?? null, modality: a_modality, status: a_status, starts_at: iso(a_starts_at), ends_at: iso(a_ends_at) },
  }
}

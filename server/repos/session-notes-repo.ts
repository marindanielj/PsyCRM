import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { type AuditEntry, audit } from '../lib/audit'
import { ELEVATED_LEVELS, type RiskIssue, validateRiskForSign } from '../lib/clinical-vocab'
import { NOTE_COLUMNS, type CreateNoteInput, type NoteField, type PatchNoteInput } from '../lib/session-note-schema'
import { ContactsRepo } from './contacts-repo'
import { TimelineRepo } from './timeline-repo'

/** Who is acting and from where; the operator's id is mandatory (the database refuses anonymous changes). */
export type NoteActor = Pick<AuditEntry, 'ip' | 'userAgent'> & { operatorId: string }

export interface SessionNote {
  id: string
  location_id: string
  contact_id: string
  appointment_id: string | null
  session_date: string
  start_time: string | null
  duration_min: number | null
  modality: string
  session_type: string
  data_subjective: string | null
  data_objective: string | null
  assessment: string | null
  plan: string | null
  mse: Record<string, unknown>
  mood_rating: number | null
  risk_suicidal: string | null
  risk_self_harm: string | null
  risk_harm_others: string | null
  risk_level: string | null
  risk_factors: string[]
  protective_factors: string[]
  risk_actions: string[]
  risk_notes: string | null
  interventions: string[]
  diagnosis_codes: string[]
  status: 'draft' | 'signed'
  signed_at: string | null
  signed_by: string | null
  signed_late: boolean
  created_by: string
  created_at: string
  updated_at: string
  locks_at: string
  deleted_at: string | null
  deleted_by: string | null
  delete_reason: string | null
}

/** Computed with the DATABASE clock, so a skewed app server cannot misreport the window. */
export interface NoteLock {
  locked: boolean
  locksAt: string
  msRemaining: number
}
export type SessionNoteWithLock = SessionNote & { lock: NoteLock }
/** The note as the record view needs it: also says WHO signed (the display name, not just the id). */
export type SessionNoteDetail = SessionNoteWithLock & { signed_by_name: string | null; created_by_name: string | null }

/** A note without its clinical text: for lists, risk summaries and the "locking soon" panel. */
export interface SessionNoteSummary {
  id: string
  contact_id: string
  contact_name: string | null
  appointment_id: string | null
  session_date: string
  session_type: string
  modality: string
  status: 'draft' | 'signed'
  signed_late: boolean
  risk_level: string | null
  created_at: string
  updated_at: string
  locks_at: string
  deleted_at: string | null
  delete_reason: string | null
  lock: NoteLock
}

export interface Addendum {
  id: string
  note_id: string
  body: string
  author: string
  author_name: string | null
  created_at: string
}

export interface RevisionMeta {
  revision: number
  kind: string
  changed_by: string
  changed_by_name: string | null
  changed_at: string
  change_reason: string | null
}

export type NoteError =
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'note_deleted' }
  | { ok: false; error: 'note_locked' }
  | { ok: false; error: 'change_reason_required' }
  | { ok: false; error: 'autosave_on_signed' }
  | { ok: false; error: 'risk_incomplete'; missing: RiskIssue[] }
  | { ok: false; error: 'unknown_contact' }
  | { ok: false; error: 'unknown_appointment' }
  | { ok: false; error: 'appointment_mismatch' }
export type NoteResult<T> = ({ ok: true } & T) | NoteError

/** Every note column, with the DATE/TIME ones as text: node-postgres turns `date` into a JS Date at local midnight, which shifts the day. */
const NOTE_COLS = `id, location_id, contact_id, appointment_id, session_date::text AS session_date, start_time::text AS start_time,
  duration_min, modality, session_type, data_subjective, data_objective, assessment, plan, mse, mood_rating,
  risk_suicidal, risk_self_harm, risk_harm_others, risk_level, risk_factors, protective_factors, risk_actions, risk_notes,
  interventions, diagnosis_codes, status, signed_at, signed_by, signed_late, created_by, created_at, updated_at, locks_at,
  deleted_at, deleted_by, delete_reason`

const LOCK_SQL = `(now() >= locks_at) AS lock_locked,
  GREATEST(0, floor(extract(epoch from (locks_at - now())) * 1000))::bigint AS lock_ms`

interface LockCols {
  lock_locked: boolean
  lock_ms: string | number
}
const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())

/** Fold the two computed columns into a `lock` object. */
function withLock<T extends LockCols & { locks_at: string | Date }>(row: T): Omit<T, 'lock_locked' | 'lock_ms'> & { lock: NoteLock } {
  const { lock_locked, lock_ms, ...rest } = row
  return { ...rest, lock: { locked: lock_locked, locksAt: iso(rest.locks_at), msRemaining: Number(lock_ms) } }
}

const SUMMARY_COLS = `n.id, n.contact_id, n.appointment_id, n.session_date::text AS session_date, n.session_type, n.modality, n.status, n.signed_late,
  n.risk_level, n.created_at, n.updated_at, n.locks_at, n.deleted_at, n.delete_reason,
  (now() >= n.locks_at) AS lock_locked,
  GREATEST(0, floor(extract(epoch from (n.locks_at - now())) * 1000))::bigint AS lock_ms,
  COALESCE(c.name, NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '')) AS contact_name`

/**
 * Session notes for ONE location. Every write runs in a transaction that (1) names the
 * acting operator for the database's revision trigger, (2) does the change and (3)
 * writes the audit row — so a note can never change without a revision AND an audit
 * entry. The 72 h lock, the mandatory risk assessment and the immutability of
 * revisions/addenda are enforced by the database (see schema.sql); the checks here
 * exist to give the caller an exact, friendly answer before the database would refuse.
 */
export class SessionNotesRepo {
  constructor(
    private db: Database,
    private locationId: string,
  ) {
    if (!locationId) throw new Error('locationId is required (tenancy guard)')
  }

  // ---- reads ---------------------------------------------------------------------

  async listByContact(contactId: string, opts: { includeDeleted?: boolean } = {}): Promise<SessionNoteSummary[]> {
    const rows = await this.db.query<LockCols & { locks_at: string | Date } & Record<string, unknown>>(
      `SELECT ${SUMMARY_COLS} FROM session_notes n
       LEFT JOIN contacts c ON c.id = n.contact_id AND c.location_id = n.location_id
       WHERE n.location_id = $1 AND n.contact_id = $2 ${opts.includeDeleted ? '' : 'AND n.deleted_at IS NULL'}
       ORDER BY n.session_date DESC, n.created_at DESC`,
      [this.locationId, contactId],
    )
    return rows.map(withLock) as unknown as SessionNoteSummary[]
  }

  async get(id: string): Promise<(SessionNoteDetail & { addenda: Addendum[]; revisionCount: number }) | undefined> {
    const rows = await this.db.query<SessionNote & LockCols>(
      `SELECT ${NOTE_COLS}, ${LOCK_SQL} FROM session_notes WHERE location_id = $1 AND id = $2`,
      [this.locationId, id],
    )
    if (!rows[0]) return undefined
    const note = withLock(rows[0]) as SessionNoteWithLock
    const names = await this.db.query<{ id: string; name: string }>(
      'SELECT id, COALESCE(name, email) AS name FROM operators WHERE id = ANY($1::text[])',
      [[note.signed_by, note.created_by].filter((x): x is string => !!x)],
    )
    const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? null
    const addenda = await this.db.query<Addendum>(
      `SELECT a.id, a.note_id, a.body, a.author, COALESCE(o.name, o.email) AS author_name, a.created_at
       FROM session_note_addenda a LEFT JOIN operators o ON o.id = a.author
       WHERE a.location_id = $1 AND a.note_id = $2 ORDER BY a.created_at, a.id`,
      [this.locationId, id],
    )
    const [count] = await this.db.query<{ n: string | number }>('SELECT count(*) AS n FROM session_note_revisions WHERE location_id = $1 AND note_id = $2', [this.locationId, id])
    return { ...note, signed_by_name: nameOf(note.signed_by), created_by_name: nameOf(note.created_by), addenda, revisionCount: Number(count?.n ?? 0) }
  }

  async listRevisions(id: string): Promise<RevisionMeta[]> {
    return this.db.query<RevisionMeta>(
      `SELECT r.revision, r.kind, r.changed_by, COALESCE(o.name, o.email) AS changed_by_name, r.changed_at, r.change_reason
       FROM session_note_revisions r LEFT JOIN operators o ON o.id = r.changed_by
       WHERE r.location_id = $1 AND r.note_id = $2 ORDER BY r.revision`,
      [this.locationId, id],
    )
  }

  async getRevision(id: string, revision: number): Promise<(RevisionMeta & { snapshot: Record<string, unknown> }) | undefined> {
    const rows = await this.db.query<RevisionMeta & { snapshot: Record<string, unknown> }>(
      `SELECT r.revision, r.kind, r.changed_by, COALESCE(o.name, o.email) AS changed_by_name, r.changed_at, r.change_reason, r.snapshot
       FROM session_note_revisions r LEFT JOIN operators o ON o.id = r.changed_by
       WHERE r.location_id = $1 AND r.note_id = $2 AND r.revision = $3`,
      [this.locationId, id, revision],
    )
    return rows[0]
  }

  /** The latest SIGNED, live note's risk level for each client, newest session first. */
  async latestRiskByContact(): Promise<{ contact_id: string; risk_level: string; session_date: string; note_id: string }[]> {
    return this.db.query(
      `SELECT DISTINCT ON (contact_id) contact_id, risk_level, session_date::text AS session_date, id AS note_id
       FROM session_notes
       WHERE location_id = $1 AND status = 'signed' AND deleted_at IS NULL AND risk_level IS NOT NULL
       ORDER BY contact_id, session_date DESC, created_at DESC`,
      [this.locationId],
    )
  }

  /** One client's current risk: the level of their latest signed, live note (or null if none yet). */
  async latestRisk(contactId: string): Promise<{ risk_level: string; session_date: string; note_id: string } | null> {
    const rows = await this.db.query<{ risk_level: string; session_date: string; note_id: string }>(
      `SELECT risk_level, session_date::text AS session_date, id AS note_id
       FROM session_notes
       WHERE location_id = $1 AND contact_id = $2 AND status = 'signed' AND deleted_at IS NULL AND risk_level IS NOT NULL
       ORDER BY session_date DESC, created_at DESC LIMIT 1`,
      [this.locationId, contactId],
    )
    return rows[0] ?? null
  }

  /**
   * Sessions that took place (client checked in, or marked completed) in the last
   * `days` days that still have NO note: the documentation backlog. A deleted note
   * does not count as documentation.
   */
  async sessionsWithoutNote(days = 3): Promise<
    { appointment_id: string; title: string; starts_at: string; status: string; contact_id: string; contact_name: string | null }[]
  > {
    return this.db.query(
      `SELECT a.id AS appointment_id, a.title, a.starts_at, a.status, a.contact_id,
              COALESCE(c.name, NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '')) AS contact_name
       FROM appointments a
       JOIN contacts c ON c.id = a.contact_id AND c.location_id = a.location_id
       WHERE a.location_id = $1 AND a.status IN ('checked_in', 'completed')
         AND a.starts_at >= now() - ($2::int * interval '1 day') AND a.starts_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM session_notes n
           WHERE n.location_id = a.location_id AND n.appointment_id = a.id AND n.deleted_at IS NULL)
       ORDER BY a.starts_at DESC`,
      [this.locationId, days],
    )
  }

  /** Clients whose latest signed note records moderate-or-worse risk. */
  async elevatedRisk(): Promise<{ contact_id: string; contact_name: string | null; risk_level: string; session_date: string; note_id: string }[]> {
    return this.db.query(
      `SELECT l.contact_id, COALESCE(c.name, NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '')) AS contact_name,
              l.risk_level, l.session_date, l.note_id
       FROM (
         SELECT DISTINCT ON (contact_id) contact_id, risk_level, session_date::text AS session_date, id AS note_id
         FROM session_notes
         WHERE location_id = $1 AND status = 'signed' AND deleted_at IS NULL AND risk_level IS NOT NULL
         ORDER BY contact_id, session_date DESC, created_at DESC
       ) l
       LEFT JOIN contacts c ON c.id = l.contact_id AND c.location_id = $1
       WHERE l.risk_level = ANY($2::text[])
       ORDER BY CASE l.risk_level WHEN 'imminent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, l.session_date DESC`,
      [this.locationId, ELEVATED_LEVELS as unknown as string[]],
    )
  }

  /** Unsigned drafts whose 72 h window closes within `hours`. */
  async lockingSoon(hours = 24): Promise<SessionNoteSummary[]> {
    const rows = await this.db.query<LockCols & { locks_at: string | Date } & Record<string, unknown>>(
      `SELECT ${SUMMARY_COLS} FROM session_notes n
       LEFT JOIN contacts c ON c.id = n.contact_id AND c.location_id = n.location_id
       WHERE n.location_id = $1 AND n.status = 'draft' AND n.deleted_at IS NULL
         AND n.locks_at > now() AND n.locks_at <= now() + ($2::int * interval '1 hour')
       ORDER BY n.locks_at`,
      [this.locationId, hours],
    )
    return rows.map(withLock) as unknown as SessionNoteSummary[]
  }

  // ---- writes --------------------------------------------------------------------

  /** Run `fn` in a transaction that names the actor (and optionally the change kind/reason) for the revision trigger. */
  private act<T>(actor: NoteActor, fn: (tx: Database) => Promise<T>, opts: { kind?: 'update' | 'autosave'; reason?: string } = {}): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('psycrm.actor', $1, true)", [actor.operatorId])
      if (opts.kind) await tx.query("SELECT set_config('psycrm.change_kind', $1, true)", [opts.kind])
      if (opts.reason) await tx.query("SELECT set_config('psycrm.change_reason', $1, true)", [opts.reason])
      return fn(tx)
    })
  }

  private auditCtx(actor: NoteActor): Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'> {
    return { actor: { type: 'operator', id: actor.operatorId }, ip: actor.ip, userAgent: actor.userAgent }
  }

  async create(input: CreateNoteInput, actor: NoteActor): Promise<NoteResult<{ note: SessionNoteWithLock }>> {
    const contact = await new ContactsRepo(this.db, this.locationId).get(input.contactId)
    if (!contact) return { ok: false, error: 'unknown_contact' }
    if (input.appointmentId) {
      const [appt] = await this.db.query<{ contact_id: string | null }>('SELECT contact_id FROM appointments WHERE location_id = $1 AND id = $2', [this.locationId, input.appointmentId])
      if (!appt) return { ok: false, error: 'unknown_appointment' }
      if (appt.contact_id && appt.contact_id !== input.contactId) return { ok: false, error: 'appointment_mismatch' }
    }

    const { contactId, ...rest } = input
    const cols = ['id', 'location_id', 'contact_id', 'created_by']
    const vals: unknown[] = [nanoid(), this.locationId, contactId, actor.operatorId]
    const casts = ['', '', '', '']
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue
      const { column, type } = NOTE_COLUMNS[key as NoteField]
      cols.push(column)
      vals.push(type === 'jsonb' ? JSON.stringify(value) : value)
      casts.push(`::${type}`)
    }
    const note = await this.act(actor, async (tx) => {
      const rows = await tx.query<SessionNote & LockCols>(
        `INSERT INTO session_notes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}${casts[i]}`).join(', ')})
         RETURNING ${NOTE_COLS}, ${LOCK_SQL}`,
        vals,
      )
      const created = withLock(rows[0]!) as SessionNoteWithLock
      await audit(tx, this.locationId, {
        action: 'note.created',
        entityType: 'session_note',
        entityId: created.id,
        contactId,
        details: { fields: Object.keys(rest).filter((k) => (rest as Record<string, unknown>)[k] !== undefined) },
        ...this.auditCtx(actor),
      })
      return created
    })
    return { ok: true, note }
  }

  async update(id: string, patch: PatchNoteInput, actor: NoteActor): Promise<NoteResult<{ note: SessionNoteWithLock; changed: string[] }>> {
    const { autosave, changeReason, ...fields } = patch
    return this.act(
      actor,
      async (tx): Promise<NoteResult<{ note: SessionNoteWithLock; changed: string[] }>> => {
        const before = await this.lockRow(tx, id)
        if (!before) return { ok: false, error: 'not_found' }
        if (before.deleted_at) return { ok: false, error: 'note_deleted' }
        if (before.lock_locked) return this.rejectLocked(tx, before, actor)
        if (autosave && before.status === 'signed') return { ok: false, error: 'autosave_on_signed' }
        if (before.status === 'signed' && !changeReason) return { ok: false, error: 'change_reason_required' }

        const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [NoteField, unknown][]
        if (entries.length === 0) return { ok: true, note: withLock(before) as SessionNoteWithLock, changed: [] }

        // A signed note must stay complete: check the state the edit would produce.
        if (before.status === 'signed') {
          const merged = { ...before } as Record<string, unknown>
          for (const [key, value] of entries) merged[NOTE_COLUMNS[key].column] = value
          const check = validateRiskForSign(merged as never)
          if (!check.ok) return { ok: false, error: 'risk_incomplete', missing: check.missing }
        }

        const sets: string[] = []
        const vals: unknown[] = [this.locationId, id]
        for (const [key, value] of entries) {
          const { column, type } = NOTE_COLUMNS[key]
          vals.push(type === 'jsonb' ? JSON.stringify(value) : value)
          sets.push(`${column} = $${vals.length}::${type}`)
        }
        // Editing a signed note renews the signature (and the editor becomes the signer).
        if (before.status === 'signed') {
          vals.push(actor.operatorId)
          sets.push('signed_at = now()', `signed_by = $${vals.length}`)
        }
        const revisionsBefore = autosave ? await this.revisionCount(tx, id) : 0
        const [afterRow] = await tx.query<SessionNote & LockCols>(
          `UPDATE session_notes SET ${sets.join(', ')} WHERE location_id = $1 AND id = $2 RETURNING ${NOTE_COLS}, ${LOCK_SQL}`,
          vals,
        )
        const after = withLock(afterRow!) as SessionNoteWithLock
        const changed = entries
          .map(([key]) => NOTE_COLUMNS[key].column)
          .filter((col) => JSON.stringify((before as unknown as Record<string, unknown>)[col]) !== JSON.stringify((after as unknown as Record<string, unknown>)[col]))

        // The database keeps one autosave revision per author per 5 minutes; the audit
        // log mirrors that: an autosave is logged only when it actually produced a revision.
        const logIt = !autosave || (await this.revisionCount(tx, id)) > revisionsBefore
        if (logIt) {
          await audit(tx, this.locationId, {
            action: autosave ? 'note.autosaved' : 'note.updated',
            entityType: 'session_note',
            entityId: id,
            contactId: before.contact_id,
            details: { fields: changed },
            ...this.auditCtx(actor),
          })
        }
        return { ok: true, note: after, changed }
      },
      { kind: autosave ? 'autosave' : 'update', reason: changeReason },
    )
  }

  /**
   * Sign a note (or sign it late, after the window, if it was never signed). Idempotent:
   * an already-signed note comes back unchanged. The risk assessment is validated here
   * (exact missing fields) and again by the database's CHECK constraints.
   */
  async sign(
    id: string,
    actor: NoteActor,
    opts: { dispatch?: WorkflowDispatch } = {},
  ): Promise<NoteResult<{ note: SessionNoteWithLock; changed: boolean; late: boolean; isFirst: boolean }>> {
    type Done = NoteResult<{ note: SessionNoteWithLock; changed: boolean; late: boolean; isFirst: boolean }>
    const result = await this.act(actor, async (tx): Promise<Done> => {
      const before = await this.lockRow(tx, id)
      if (!before) return { ok: false, error: 'not_found' }
      if (before.deleted_at) return { ok: false, error: 'note_deleted' }
      if (before.status === 'signed') return { ok: true, note: withLock(before) as SessionNoteWithLock, changed: false, late: before.signed_late, isFirst: false }

      const check = validateRiskForSign(before as never)
      if (!check.ok) return { ok: false, error: 'risk_incomplete', missing: check.missing }

      // The risk level of the previous signed note, to report a change.
      const [prior] = await tx.query<{ id: string; risk_level: string }>(
        `SELECT id, risk_level FROM session_notes
         WHERE location_id = $1 AND contact_id = $2 AND id <> $3 AND status = 'signed' AND deleted_at IS NULL AND risk_level IS NOT NULL
         ORDER BY session_date DESC, created_at DESC LIMIT 1`,
        [this.locationId, before.contact_id, id],
      )
      const [anySigned] = await tx.query<{ n: string | number }>(
        "SELECT count(*) AS n FROM session_notes WHERE location_id = $1 AND contact_id = $2 AND id <> $3 AND status = 'signed' AND deleted_at IS NULL",
        [this.locationId, before.contact_id, id],
      )

      const late = before.lock_locked // the database flags it too; this is for the audit action name
      const [row] = await tx.query<SessionNote & LockCols>(
        `UPDATE session_notes SET status = 'signed', signed_at = now(), signed_by = $3
         WHERE location_id = $1 AND id = $2 RETURNING ${NOTE_COLS}, ${LOCK_SQL}`,
        [this.locationId, id, actor.operatorId],
      )
      const note = withLock(row!) as SessionNoteWithLock

      await audit(tx, this.locationId, {
        action: late ? 'note.signed_late' : 'note.signed',
        entityType: 'session_note',
        entityId: id,
        contactId: note.contact_id,
        details: { late },
        ...this.auditCtx(actor),
      })
      if (prior && prior.risk_level !== note.risk_level) {
        await audit(tx, this.locationId, {
          action: 'risk.level_changed',
          entityType: 'session_note',
          entityId: id,
          contactId: note.contact_id,
          details: { from: prior.risk_level, to: note.risk_level, previousNoteId: prior.id },
          ...this.auditCtx(actor),
        })
      }
      // A session that now has a signed note has happened: close its appointment
      // (unless it was cancelled or marked a no-show, which is a different story).
      if (note.appointment_id) {
        const closed = await tx.query<{ id: string; prev: string }>(
          `WITH old AS (SELECT status FROM appointments WHERE location_id = $1 AND id = $2)
           UPDATE appointments SET status = 'completed', updated_at = now()
           WHERE location_id = $1 AND id = $2 AND status IN ('scheduled','confirmed','checked_in')
           RETURNING id, (SELECT status FROM old) AS prev`,
          [this.locationId, note.appointment_id],
        )
        if (closed[0]) {
          await audit(tx, this.locationId, {
            action: 'appointment.status_changed',
            entityType: 'appointment',
            entityId: closed[0].id,
            contactId: note.contact_id,
            details: { from: closed[0].prev, to: 'completed', via: 'note_signed' },
            ...this.auditCtx(actor),
          })
        }
      }
      // Fact only on the client's timeline — never clinical content.
      await new TimelineRepo(tx, this.locationId).add({
        contactId: note.contact_id,
        type: 'session_note_signed',
        refTable: 'session_notes',
        refId: note.id,
        payload: { sessionDate: note.session_date, sessionType: note.session_type, late },
      })
      return { ok: true, note, changed: true, late, isFirst: Number(anySigned?.n ?? 0) === 0 }
    })
    if (result.ok && result.changed) {
      await opts.dispatch?.({
        locationId: this.locationId,
        triggerType: 'session_note_signed',
        contactId: result.note.contact_id,
        payload: { noteId: result.note.id, sessionType: result.note.session_type, isFirst: result.isFirst },
        depth: 0,
      })
    }
    return result
  }

  /** Soft delete: only inside the 72 h window, with a reason. The row, its revisions and its audit trail stay. */
  async softDelete(id: string, reason: string, actor: NoteActor): Promise<NoteResult<Record<never, never>>> {
    return this.act(actor, async (tx): Promise<NoteResult<Record<never, never>>> => {
      const before = await this.lockRow(tx, id)
      if (!before) return { ok: false, error: 'not_found' }
      if (before.deleted_at) return { ok: false, error: 'note_deleted' }
      if (before.lock_locked) return this.rejectLocked(tx, before, actor)
      await tx.query(
        'UPDATE session_notes SET deleted_at = now(), deleted_by = $3, delete_reason = $4 WHERE location_id = $1 AND id = $2',
        [this.locationId, id, actor.operatorId, reason],
      )
      // The reason is free text (it can name clinical details): it lives on the row and its revision, not in the audit.
      await audit(tx, this.locationId, {
        action: 'note.deleted',
        entityType: 'session_note',
        entityId: id,
        contactId: before.contact_id,
        details: { wasSigned: before.status === 'signed' },
        ...this.auditCtx(actor),
      })
      return { ok: true }
    })
  }

  /** An addendum: how a frozen (or signed) note is added to. Never edits the note. */
  async addAddendum(id: string, body: string, actor: NoteActor): Promise<NoteResult<{ addendum: Addendum }>> {
    return this.db.transaction(async (tx): Promise<NoteResult<{ addendum: Addendum }>> => {
      const [note] = await tx.query<{ contact_id: string; deleted_at: string | null }>(
        'SELECT contact_id, deleted_at FROM session_notes WHERE location_id = $1 AND id = $2',
        [this.locationId, id],
      )
      if (!note) return { ok: false, error: 'not_found' }
      if (note.deleted_at) return { ok: false, error: 'note_deleted' }
      const [row] = await tx.query<Addendum>(
        `INSERT INTO session_note_addenda (id, location_id, note_id, body, author) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, note_id, body, author, NULL::text AS author_name, created_at`,
        [nanoid(), this.locationId, id, body, actor.operatorId],
      )
      await audit(tx, this.locationId, {
        action: 'note.addendum_added',
        entityType: 'session_note',
        entityId: id,
        contactId: note.contact_id,
        details: { addendumId: row!.id },
        ...this.auditCtx(actor),
      })
      return { ok: true, addendum: row! }
    })
  }

  /** Record an access to a note (open, print, open a revision) in the audit log. */
  async recordAccess(id: string, action: 'note.viewed' | 'note.printed' | 'note.revision_viewed', actor: NoteActor, details: Record<string, unknown> = {}): Promise<boolean> {
    const [note] = await this.db.query<{ contact_id: string }>('SELECT contact_id FROM session_notes WHERE location_id = $1 AND id = $2', [this.locationId, id])
    if (!note) return false
    await audit(this.db, this.locationId, { action, entityType: 'session_note', entityId: id, contactId: note.contact_id, details, ...this.auditCtx(actor) })
    return true
  }

  // ---- internals -----------------------------------------------------------------

  /** The note row, locked for the rest of the transaction (concurrent edits queue up). */
  private async lockRow(tx: Database, id: string): Promise<(SessionNote & LockCols) | undefined> {
    const rows = await tx.query<SessionNote & LockCols>(
      `SELECT ${NOTE_COLS}, ${LOCK_SQL} FROM session_notes WHERE location_id = $1 AND id = $2 FOR UPDATE`,
      [this.locationId, id],
    )
    return rows[0]
  }

  private async revisionCount(tx: Database, id: string): Promise<number> {
    const [r] = await tx.query<{ n: string | number }>('SELECT count(*) AS n FROM session_note_revisions WHERE note_id = $1', [id])
    return Number(r?.n ?? 0)
  }

  /** The refusal itself is evidence: write it (the surrounding transaction commits) and say no. */
  private async rejectLocked(tx: Database, note: SessionNote, actor: NoteActor): Promise<NoteError> {
    await audit(tx, this.locationId, {
      action: 'note.edit_rejected_locked',
      entityType: 'session_note',
      entityId: note.id,
      contactId: note.contact_id,
      ...this.auditCtx(actor),
    })
    return { ok: false, error: 'note_locked' }
  }
}


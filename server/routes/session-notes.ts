import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import type { WorkflowDispatch } from '../jobs/workflow-dispatcher'
import { todayIn } from '../lib/age'
import { clientIp } from '../lib/client-ip'
import { addendumSchema, createNoteSchema, deleteNoteSchema, patchNoteSchema } from '../lib/session-note-schema'
import { type NoteActor, type NoteError, SessionNotesRepo } from '../repos/session-notes-repo'

const listQuery = z.object({
  contactId: z.string().min(1).max(64),
  includeDeleted: z.enum(['true', 'false']).optional(),
})
const lockingQuery = z.object({ hours: z.coerce.number().int().min(1).max(72).optional() })

/** Honest HTTP answers for every way a note operation can be refused. */
function refuse(c: Context<AppEnv>, r: NoteError) {
  switch (r.error) {
    case 'not_found':
      return c.json({ error: 'not found' }, 404)
    case 'note_deleted':
      return c.json({ error: 'note_deleted' }, 409)
    case 'note_locked':
      // 72 h have passed: the note can no longer be edited or deleted; only an addendum can be added.
      return c.json({ error: 'note_locked' }, 409)
    case 'change_reason_required':
      return c.json({ error: 'change_reason_required' }, 422)
    case 'autosave_on_signed':
      return c.json({ error: 'autosave_on_signed' }, 422)
    case 'risk_incomplete':
      return c.json({ error: 'risk_incomplete', missing: r.missing }, 422)
    case 'unknown_contact':
      return c.json({ error: 'unknown contact' }, 400)
    case 'unknown_appointment':
      return c.json({ error: 'unknown appointment' }, 400)
    case 'appointment_mismatch':
      return c.json({ error: 'appointment belongs to another client' }, 400)
  }
}

/**
 * Map a database refusal that slipped past the pre-checks (a race with the 72 h clock,
 * a CHECK constraint) to the same answers. Anything else is a real fault: rethrown.
 */
function databaseRefusal(c: Context<AppEnv>, err: unknown) {
  const message = String((err as { message?: unknown } | null)?.message ?? '')
  if (/session_note_locked/.test(message)) return c.json({ error: 'note_locked' }, 409)
  if (/session_note_deleted/.test(message)) return c.json({ error: 'note_deleted' }, 409)
  if (/session_note_unsign/.test(message)) return c.json({ error: 'note_cannot_be_unsigned' }, 409)
  if (/violates check constraint "session_notes_(risk|actions|signed)/.test(message)) return c.json({ error: 'risk_incomplete' }, 422)
  throw err
}

/**
 * Session notes (DAP + mental status + a mandatory risk assessment) for the current
 * location, at /api/loc/:loc/session-notes behind operatorAuth + locationAccess + the
 * `session_notes` module. The 72 h lock, the risk requirement and the append-only
 * history are enforced by the database; this layer validates input, answers honestly
 * (409 locked / 422 incomplete) and records every access in the audit log.
 */
export function sessionNotesRoute(deps: {
  db: Database
  /** Fired after a note is signed so live workflows can react (day 7). */
  dispatch?: WorkflowDispatch
  /** Injectable "today" (YYYY-MM-DD, practice time) for the not-in-the-future check. */
  today?: () => string
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const repo = (c: Context<AppEnv>) => new SessionNotesRepo(deps.db, c.get('locationId'))
  const actor = (c: Context<AppEnv>): NoteActor => {
    const ip = clientIp(c)
    return { operatorId: c.get('operatorId'), ip: ip === 'unknown' ? null : ip, userAgent: c.req.header('user-agent') ?? null }
  }

  // Lists carry no clinical text: dates, type, risk level, status and the lock.
  app.get('/', zValidator('query', listQuery), async (c) => {
    const { contactId, includeDeleted } = c.req.valid('query')
    return c.json({ notes: await repo(c).listByContact(contactId, { includeDeleted: includeDeleted === 'true' }) })
  })

  // Registered before /:id so these literal paths are not read as a note id.
  app.get('/risk/summary', async (c) => c.json({ elevated: await repo(c).elevatedRisk() }))

  app.get('/locking-soon', zValidator('query', lockingQuery), async (c) => {
    return c.json({ notes: await repo(c).lockingSoon(c.req.valid('query').hours ?? 24) })
  })

  app.post('/', zValidator('json', createNoteSchema), async (c) => {
    const input = c.req.valid('json')
    if (input.sessionDate > (deps.today?.() ?? todayIn())) return c.json({ error: 'session_date_in_future' }, 422)
    try {
      const r = await repo(c).create(input, actor(c))
      return r.ok ? c.json({ ok: true, note: r.note }, 201) : refuse(c, r)
    } catch (err) {
      return databaseRefusal(c, err)
    }
  })

  app.get('/:id', async (c) => {
    const id = c.req.param('id')
    const note = await repo(c).get(id)
    if (!note) return c.json({ error: 'not found' }, 404)
    // A deleted note's content is not served on the record view (its history stays
    // available through the audited revisions endpoint).
    if (note.deleted_at) return c.json({ error: 'note_deleted', deletedAt: note.deleted_at }, 410)
    // Opening a clinical note is an access to PHI: logged before anything is returned.
    await repo(c).recordAccess(id, 'note.viewed', actor(c))
    const { addenda, revisionCount, lock, ...rest } = note
    return c.json({ note: { ...rest, lock }, addenda, revisionCount, lock })
  })

  app.patch('/:id', zValidator('json', patchNoteSchema), async (c) => {
    const input = c.req.valid('json')
    if (input.sessionDate !== undefined && input.sessionDate > (deps.today?.() ?? todayIn())) {
      return c.json({ error: 'session_date_in_future' }, 422)
    }
    try {
      const r = await repo(c).update(c.req.param('id'), input, actor(c))
      return r.ok ? c.json({ ok: true, note: r.note, changed: r.changed }) : refuse(c, r)
    } catch (err) {
      return databaseRefusal(c, err)
    }
  })

  app.post('/:id/sign', async (c) => {
    try {
      const r = await repo(c).sign(c.req.param('id'), actor(c), { dispatch: deps.dispatch })
      return r.ok ? c.json({ ok: true, note: r.note, late: r.late }) : refuse(c, r)
    } catch (err) {
      return databaseRefusal(c, err)
    }
  })

  // Soft delete, with a mandatory reason, only inside the 72 h window.
  app.delete('/:id', zValidator('json', deleteNoteSchema), async (c) => {
    try {
      const r = await repo(c).softDelete(c.req.param('id'), c.req.valid('json').reason, actor(c))
      return r.ok ? c.body(null, 204) : refuse(c, r)
    } catch (err) {
      return databaseRefusal(c, err)
    }
  })

  app.post('/:id/addenda', zValidator('json', addendumSchema), async (c) => {
    try {
      const r = await repo(c).addAddendum(c.req.param('id'), c.req.valid('json').body, actor(c))
      return r.ok ? c.json({ ok: true, addendum: r.addendum }, 201) : refuse(c, r)
    } catch (err) {
      return databaseRefusal(c, err)
    }
  })

  app.get('/:id/revisions', async (c) => {
    return c.json({ revisions: await repo(c).listRevisions(c.req.param('id')) })
  })

  app.get('/:id/revisions/:rev', async (c) => {
    const rev = Number(c.req.param('rev'))
    if (!Number.isInteger(rev) || rev < 1) return c.json({ error: 'not found' }, 404)
    const revision = await repo(c).getRevision(c.req.param('id'), rev)
    if (!revision) return c.json({ error: 'not found' }, 404)
    await repo(c).recordAccess(c.req.param('id'), 'note.revision_viewed', actor(c), { revision: rev })
    return c.json({ revision })
  })

  // The report page tells us the clinician printed / saved it as PDF.
  app.post('/:id/printed', async (c) => {
    const ok = await repo(c).recordAccess(c.req.param('id'), 'note.printed', actor(c))
    return ok ? c.body(null, 204) : c.json({ error: 'not found' }, 404)
  })

  return app
}

import {
  INTERVENTIONS, MODALITIES, PROTECTIVE_FACTORS, RISK_ACTIONS, RISK_FACTORS, RISK_HARM_OTHERS, RISK_LEVELS, RISK_SELF_HARM, RISK_SUICIDAL, SESSION_TYPES,
} from '../lib/clinical-vocab'
import { addLocation, asActor, freshDb } from '../test-utils/pglite'

type Db = Awaited<ReturnType<typeof freshDb>>

async function setup() {
  const s = await freshDb()
  const loc = await addLocation(s.db)
  await s.db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana Rivera')", [loc])
  return { ...s, loc }
}

/** Insert a draft note as `op1` and return its id. */
async function newNote(s: Db & { loc: string }, id = 'n1', extra: Record<string, unknown> = {}) {
  await asActor(s.db, 'op1', (tx) =>
    tx.query(
      `INSERT INTO session_notes (id, location_id, contact_id, session_date, created_by) VALUES ($1,$2,'c1','2026-11-05','op1')`,
      [id, s.loc],
    ),
  )
  for (const [k, v] of Object.entries(extra)) await asActor(s.db, 'op1', (tx) => tx.query(`UPDATE session_notes SET ${k} = $2 WHERE id = $1`, [id, v]))
  return id
}

const RISK_OK = "risk_suicidal='denied', risk_self_harm='denied', risk_harm_others='denied', risk_level='low'"
const sign = (s: Db, id = 'n1', set = RISK_OK, actor = 'op1') =>
  asActor(s.db, actor, (tx) => tx.query(`UPDATE session_notes SET ${set}, status='signed', signed_at=now(), signed_by='${actor}' WHERE id=$1`, [id]))

/** Pretend the 72 h window has closed: rewrite locks_at as a superuser who bypasses the triggers (what the test can do and the app never can). */
const closeWindow = (s: Db, id = 'n1') =>
  s.pg.exec(`SET session_replication_role = replica; UPDATE session_notes SET locks_at = now() - interval '1 minute' WHERE id = '${id}'; SET session_replication_role = DEFAULT;`)

// --- the clock ----------------------------------------------------------------------

test('a new note is a draft whose 72 h window the DATABASE starts; the caller cannot pre-sign, backdate or widen it', async () => {
  const s = await setup()
  await asActor(s.db, 'op1', (tx) =>
    tx.query(
      `INSERT INTO session_notes (id, location_id, contact_id, session_date, created_by, status, signed_at, signed_by, created_at, locks_at, signed_late, deleted_at, deleted_by, delete_reason, risk_level)
       VALUES ('n1',$1,'c1','2026-11-05','op1','signed', now(), 'op1', '2001-01-01', '2999-01-01', true, now(), 'x', 'x', 'low')`,
      [s.loc],
    ),
  )
  const [n] = await s.db.query<{ status: string; signed_at: unknown; signed_by: unknown; signed_late: boolean; deleted_at: unknown; hours: number; created: string | Date }>(
    `SELECT status, signed_at, signed_by, signed_late, deleted_at, extract(epoch from (locks_at - created_at))/3600 AS hours, created_at AS created FROM session_notes WHERE id='n1'`,
  )
  expect(n).toMatchObject({ status: 'draft', signed_at: null, signed_by: null, signed_late: false, deleted_at: null })
  expect(Number(n!.hours)).toBe(72)
  expect(new Date(n!.created).getFullYear()).toBeGreaterThan(2020)
})

test('created_at, locks_at, contact and creator can never be changed after creation', async () => {
  const s = await setup()
  await newNote(s)
  const before = (await s.db.query<{ created_at: Date; locks_at: Date; created_by: string; contact_id: string }>('SELECT created_at, locks_at, created_by, contact_id FROM session_notes WHERE id=$1', ['n1']))[0]!
  await s.db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c2',$1,'Other')", [s.loc])
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET created_at='2001-01-01', locks_at='2999-01-01', created_by='someone', contact_id='c2' WHERE id='n1'"))
  const after = (await s.db.query<{ created_at: Date; locks_at: Date; created_by: string; contact_id: string }>('SELECT created_at, locks_at, created_by, contact_id FROM session_notes WHERE id=$1', ['n1']))[0]!
  expect(after).toEqual(before)
})

// --- edit / delete inside and outside the window ----------------------------------------

test('inside the window a draft or signed note can be edited; a signed note cannot go back to draft', async () => {
  const s = await setup()
  await newNote(s)
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET data_subjective='Client reports poor sleep' WHERE id='n1'"))
  await sign(s)
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET assessment='Improving', signed_at=now() WHERE id='n1'"), { reason: 'Clarified assessment' })
  expect((await s.db.query<{ assessment: string; status: string }>("SELECT assessment, status FROM session_notes WHERE id='n1'"))[0]).toEqual({ assessment: 'Improving', status: 'signed' })
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET status='draft' WHERE id='n1'"))).rejects.toThrow(/session_note_unsign/)
})

test('after 72 h the note is frozen: no edit, no soft delete, not even by the author', async () => {
  const s = await setup()
  await newNote(s)
  await sign(s)
  await closeWindow(s)
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET assessment='changed' WHERE id='n1'"))).rejects.toThrow(/session_note_locked/)
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET deleted_at=now(), deleted_by='op1', delete_reason='oops' WHERE id='n1'"))).rejects.toThrow(/session_note_locked/)
  expect((await s.db.query<{ assessment: string | null }>("SELECT assessment FROM session_notes WHERE id='n1'"))[0]!.assessment).toBeNull()
})

test('a draft that was never signed may be signed LATE, but only if nothing else changes', async () => {
  const s = await setup()
  await newNote(s, 'n1', { risk_suicidal: 'denied', risk_self_harm: 'denied', risk_harm_others: 'denied', risk_level: 'low' })
  await closeWindow(s)
  // changing content while signing late is refused…
  await expect(
    asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET assessment='sneaky', status='signed', signed_at=now(), signed_by='op1' WHERE id='n1'")),
  ).rejects.toThrow(/session_note_locked/)
  // …editing without signing is refused…
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET assessment='x' WHERE id='n1'"))).rejects.toThrow(/session_note_locked/)
  // …but the bare signature goes through and is flagged late.
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET status='signed', signed_at=now(), signed_by='op1' WHERE id='n1'"))
  expect((await s.db.query<{ status: string; signed_late: boolean }>("SELECT status, signed_late FROM session_notes WHERE id='n1'"))[0]).toEqual({ status: 'signed', signed_late: true })
  // and now it is frozen for good
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET assessment='x' WHERE id='n1'"))).rejects.toThrow(/session_note_locked/)
})

test('a late signature still needs the complete risk assessment (the CHECK applies)', async () => {
  const s = await setup()
  await newNote(s)
  await closeWindow(s)
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET status='signed', signed_at=now(), signed_by='op1' WHERE id='n1'"))).rejects.toThrow(/session_notes_risk_required/)
})

test('a note is never physically deleted; a soft delete needs a reason, works only inside the window, and ends all further edits', async () => {
  const s = await setup()
  await newNote(s)
  await expect(s.db.query("DELETE FROM session_notes WHERE id='n1'")).rejects.toThrow(/session_note_no_delete/)
  await expect(asActor(s.db, 'op1', (tx) => tx.query("DELETE FROM session_notes WHERE id='n1'"))).rejects.toThrow(/session_note_no_delete/)
  // Postgres refuses first because revisions reference the table; the truncate trigger is the backstop.
  await expect(s.db.query('TRUNCATE session_notes')).rejects.toThrow(/append-only|referenced in a foreign key/)

  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET deleted_at=now(), deleted_by='op1' WHERE id='n1'"))).rejects.toThrow(/session_notes_delete_reason/)
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET deleted_at=now(), deleted_by='op1', delete_reason='Entered on the wrong client' WHERE id='n1'"))
  expect(await s.db.query("SELECT 1 FROM session_notes WHERE id='n1' AND deleted_at IS NOT NULL")).toHaveLength(1) // still there
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET deleted_at=NULL WHERE id='n1'"))).rejects.toThrow(/session_note_deleted/) // cannot be un-deleted
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET assessment='x' WHERE id='n1'"))).rejects.toThrow(/session_note_deleted/)
})

test('a client with clinical notes cannot be deleted (contacts are archived, not removed)', async () => {
  const s = await setup()
  await newNote(s)
  await expect(s.db.query("DELETE FROM contacts WHERE id='c1'")).rejects.toThrow()
})

// --- risk assessment is mandatory to sign ---------------------------------------------

test('signing without a complete risk assessment is refused by the database', async () => {
  const s = await setup()
  await newNote(s)
  await expect(sign(s, 'n1', "risk_level='low'")).rejects.toThrow(/session_notes_risk_required/)
  await expect(sign(s, 'n1', "risk_suicidal='denied', risk_self_harm='denied', risk_level='low'")).rejects.toThrow(/session_notes_risk_required/)
  await expect(sign(s, 'n1', "risk_suicidal='denied', risk_self_harm='denied', risk_harm_others='denied'")).rejects.toThrow(/session_notes_risk_required/)
  await expect(sign(s, 'n1', '')).rejects.toThrow()
  expect((await s.db.query<{ status: string }>("SELECT status FROM session_notes WHERE id='n1'"))[0]!.status).toBe('draft')
  await sign(s) // complete -> fine
  expect((await s.db.query<{ status: string }>("SELECT status FROM session_notes WHERE id='n1'"))[0]!.status).toBe('signed')
})

test('a draft may be saved with the risk section empty or half-filled (only SIGNING requires it)', async () => {
  const s = await setup()
  await newNote(s, 'n1', { risk_suicidal: 'passive' })
  expect((await s.db.query<{ risk_suicidal: string; risk_level: string | null }>("SELECT risk_suicidal, risk_level FROM session_notes WHERE id='n1'"))[0]).toEqual({ risk_suicidal: 'passive', risk_level: null })
})

test('moderate/high/imminent need a rationale and a real action; "none" does not count', async () => {
  const s = await setup()
  for (const level of ['moderate', 'high', 'imminent']) {
    await newNote(s, `n-${level}`)
    const base = `risk_suicidal='passive', risk_self_harm='denied', risk_harm_others='denied', risk_level='${level}'`
    await expect(sign(s, `n-${level}`, base)).rejects.toThrow(/session_notes_risk_elevated/)
    await expect(sign(s, `n-${level}`, `${base}, risk_notes='Reviewed safety plan'`)).rejects.toThrow(/session_notes_risk_elevated/)
    await expect(sign(s, `n-${level}`, `${base}, risk_notes='Reviewed safety plan', risk_actions='{none}'`)).rejects.toThrow(/session_notes_risk_elevated/)
    await expect(sign(s, `n-${level}`, `${base}, risk_notes='   ', risk_actions='{safety_plan_reviewed}'`)).rejects.toThrow(/session_notes_risk_elevated/)
    await sign(s, `n-${level}`, `${base}, risk_notes='Reviewed safety plan', risk_actions='{safety_plan_reviewed,crisis_line_provided}'`)
  }
})

test('"low" with a positive dimension needs a rationale; self-harm history alone does not', async () => {
  const s = await setup()
  await newNote(s, 'a')
  await expect(sign(s, 'a', "risk_suicidal='passive', risk_self_harm='denied', risk_harm_others='denied', risk_level='low'")).rejects.toThrow(/session_notes_risk_low_justified/)
  await sign(s, 'a', "risk_suicidal='passive', risk_self_harm='denied', risk_harm_others='denied', risk_level='low', risk_notes='Fleeting thoughts, no plan'")
  await newNote(s, 'b')
  await sign(s, 'b', "risk_suicidal='denied', risk_self_harm='history', risk_harm_others='denied', risk_level='low'")
})

test('"none" cannot sit beside a real action', async () => {
  const s = await setup()
  await newNote(s)
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET risk_actions='{none,crisis_line_provided}' WHERE id='n1'"))).rejects.toThrow(/session_notes_actions_none_alone/)
})

test('editing a SIGNED note cannot blank out its risk assessment', async () => {
  const s = await setup()
  await newNote(s)
  await sign(s)
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET risk_level=NULL WHERE id='n1'"))).rejects.toThrow(/session_notes_risk_required/)
  await expect(asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET signed_at=NULL WHERE id='n1'"))).rejects.toThrow(/session_notes_signed_fields/)
})

// --- vocabulary: SQL CHECK lists == TypeScript vocabulary --------------------------------

test('every closed set in the SQL CHECK constraints matches the TypeScript vocabulary exactly', async () => {
  const { db } = await setup()
  const defs = Object.fromEntries(
    (await db.query<{ conname: string; def: string }>(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'session_notes'::regclass`)).map((r) => [r.conname, r.def]),
  )
  const valuesIn = (name: string) => new Set([...(defs[name] ?? '').matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]))
  const expected: Record<string, readonly string[]> = {
    session_notes_modality: MODALITIES,
    session_notes_type: SESSION_TYPES,
    session_notes_risk_si: RISK_SUICIDAL,
    session_notes_risk_sh: RISK_SELF_HARM,
    session_notes_risk_hi: RISK_HARM_OTHERS,
    session_notes_risk_level: RISK_LEVELS,
    session_notes_risk_factors: RISK_FACTORS,
    session_notes_protective: PROTECTIVE_FACTORS,
    session_notes_risk_actions: RISK_ACTIONS,
    session_notes_interventions: INTERVENTIONS,
  }
  for (const [name, vocab] of Object.entries(expected)) {
    expect(defs[name], `${name} is missing`).toBeTruthy()
    expect([...valuesIn(name)].sort(), name).toEqual([...vocab].sort())
  }
})

test('values outside the vocabulary are rejected', async () => {
  const s = await setup()
  await newNote(s)
  for (const set of ["modality='hologram'", "risk_level='catastrophic'", "risk_factors='{not_a_factor}'", "interventions='{astrology}'", 'mood_rating=11', 'duration_min=0']) {
    await expect(asActor(s.db, 'op1', (tx) => tx.query(`UPDATE session_notes SET ${set} WHERE id='n1'`)), set).rejects.toThrow()
  }
})

// --- revisions ---------------------------------------------------------------------------

test('every change leaves a full snapshot attributed to who made it, with the reason', async () => {
  const s = await setup()
  await newNote(s)
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET data_subjective='first draft' WHERE id='n1'"))
  await sign(s, 'n1', RISK_OK, 'op2')
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET assessment='Better', signed_at=now(), signed_by='op1' WHERE id='n1'"), { reason: 'Added assessment' })
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET deleted_at=now(), deleted_by='op1', delete_reason='Wrong client' WHERE id='n1'"))

  const revs = await s.db.query<{ revision: number; kind: string; changed_by: string; change_reason: string | null; snapshot: Record<string, unknown> }>(
    'SELECT revision, kind, changed_by, change_reason, snapshot FROM session_note_revisions WHERE note_id=$1 ORDER BY revision',
    ['n1'],
  )
  expect(revs.map((r) => [r.revision, r.kind, r.changed_by])).toEqual([
    [1, 'create', 'op1'],
    [2, 'update', 'op1'],
    [3, 'sign', 'op2'],
    [4, 'update', 'op1'],
    [5, 'delete', 'op1'],
  ])
  expect(revs[3]!.change_reason).toBe('Added assessment')
  expect(revs[1]!.snapshot).toMatchObject({ data_subjective: 'first draft', status: 'draft' })
  expect(revs[2]!.snapshot).toMatchObject({ status: 'signed', signed_by: 'op2', risk_level: 'low' })
  expect(revs[3]!.snapshot).toMatchObject({ assessment: 'Better', data_subjective: 'first draft' }) // a FULL snapshot, not a diff
  expect(revs[4]!.snapshot).toMatchObject({ delete_reason: 'Wrong client' })
})

test('a change with no named actor is refused, so nothing can alter a note anonymously', async () => {
  const s = await setup()
  await expect(s.db.query(`INSERT INTO session_notes (id, location_id, contact_id, session_date, created_by) VALUES ('n9',$1,'c1','2026-11-05','op1')`, [s.loc])).rejects.toThrow(/session_note_actor_required/)
  await newNote(s)
  await expect(s.db.query("UPDATE session_notes SET assessment='x' WHERE id='n1'")).rejects.toThrow(/session_note_actor_required/)
  expect(await s.db.query("SELECT 1 FROM session_notes WHERE id='n9'")).toHaveLength(0)
  expect((await s.db.query<{ assessment: string | null }>("SELECT assessment FROM session_notes WHERE id='n1'"))[0]!.assessment).toBeNull()
})

test('autosave keeps one revision per author per 5 minutes; an explicit save and a different author always record', async () => {
  const s = await setup()
  await newNote(s) // revision 1: create by op1
  const save = (actor: string, text: string, kind?: 'autosave' | 'update') =>
    asActor(s.db, actor, (tx) => tx.query('UPDATE session_notes SET data_subjective=$2 WHERE id=$1', ['n1', text]), { kind })
  await save('op1', 'a', 'autosave') // within 5 min of op1's create -> skipped
  await save('op1', 'ab', 'autosave') // skipped
  await save('op2', 'abc', 'autosave') // a different author -> recorded
  await save('op1', 'abcd', 'update') // explicit save -> always recorded
  const kinds = (await s.db.query<{ kind: string; changed_by: string }>('SELECT kind, changed_by FROM session_note_revisions WHERE note_id=$1 ORDER BY revision', ['n1'])).map((r) => `${r.kind}:${r.changed_by}`)
  expect(kinds).toEqual(['create:op1', 'autosave:op2', 'update:op1'])
  // …yet the note itself always holds the latest text
  expect((await s.db.query<{ data_subjective: string }>("SELECT data_subjective FROM session_notes WHERE id='n1'"))[0]!.data_subjective).toBe('abcd')
})

test('revisions can never be edited, deleted or truncated', async () => {
  const s = await setup()
  await newNote(s)
  await expect(s.db.query("UPDATE session_note_revisions SET changed_by='someone'")).rejects.toThrow(/append-only/)
  await expect(s.db.query('DELETE FROM session_note_revisions')).rejects.toThrow(/append-only/)
  await expect(s.db.query('TRUNCATE session_note_revisions')).rejects.toThrow(/append-only/)
})

// --- addenda -----------------------------------------------------------------------------

test('addenda can be added to a signed or frozen note, are stamped by the database, and are append-only', async () => {
  const s = await setup()
  await newNote(s)
  await sign(s)
  await closeWindow(s)
  await s.db.query("INSERT INTO session_note_addenda (id, location_id, note_id, body, author, created_at) VALUES ('a1',$1,'n1','Client asked to correct the date of the incident','op1','2001-01-01')", [s.loc])
  const [a] = await s.db.query<{ created_at: Date }>("SELECT created_at FROM session_note_addenda WHERE id='a1'")
  expect(a!.created_at.getFullYear()).toBeGreaterThan(2020) // not the backdated value supplied
  await expect(s.db.query("UPDATE session_note_addenda SET body='changed'")).rejects.toThrow(/append-only/)
  await expect(s.db.query('DELETE FROM session_note_addenda')).rejects.toThrow(/append-only/)
  await expect(s.db.query('TRUNCATE session_note_addenda')).rejects.toThrow(/append-only/)
  await expect(s.db.query("INSERT INTO session_note_addenda (id, location_id, note_id, body, author) VALUES ('a2',$1,'n1','   ','op1')", [s.loc])).rejects.toThrow()
})

test('an addendum needs a live note of the same practice', async () => {
  const s = await setup()
  await newNote(s)
  const other = await addLocation(s.db, 'loc_other')
  await expect(s.db.query("INSERT INTO session_note_addenda (id, location_id, note_id, body, author) VALUES ('a1',$1,'n1','x','op1')", [other])).rejects.toThrow(/session_note_not_found/)
  await expect(s.db.query("INSERT INTO session_note_addenda (id, location_id, note_id, body, author) VALUES ('a1',$1,'ghost','x','op1')", [s.loc])).rejects.toThrow()
  await asActor(s.db, 'op1', (tx) => tx.query("UPDATE session_notes SET deleted_at=now(), deleted_by='op1', delete_reason='dup' WHERE id='n1'"))
  await expect(s.db.query("INSERT INTO session_note_addenda (id, location_id, note_id, body, author) VALUES ('a1',$1,'n1','x','op1')", [s.loc])).rejects.toThrow(/session_note_deleted/)
})

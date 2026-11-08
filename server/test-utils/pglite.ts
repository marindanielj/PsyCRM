import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PgliteDatabase } from '../db/pglite-database'

const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')

/** A fresh in-process Postgres with the full schema applied (triggers, CHECKs and
 *  all). The way to test anything that lives in the database rather than in a
 *  repo's SQL strings. Every call is an isolated instance. */
export async function freshDb(): Promise<{ db: PgliteDatabase; pg: PGlite }> {
  const pg = new PGlite()
  await pg.exec(SCHEMA)
  return { db: new PgliteDatabase(pg), pg }
}

/** Insert a bare location (the tenant root) and return its id. */
export async function addLocation(db: PgliteDatabase, id = 'loc_test'): Promise<string> {
  await db.query("INSERT INTO locations (id, name, slug) VALUES ($1,$1,$1) ON CONFLICT DO NOTHING", [id])
  return id
}

/**
 * Run `fn` in a transaction that first names the acting person, as every write to a
 * session note must (the database refuses an anonymous change). `kind`/`reason` set
 * the revision's change kind and reason.
 */
export async function asActor<T>(
  db: PgliteDatabase,
  actor: string,
  fn: (tx: import('../db/database').Database) => Promise<T>,
  opts: { kind?: 'update' | 'autosave'; reason?: string } = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('psycrm.actor', $1, true)", [actor])
    if (opts.kind) await tx.query("SELECT set_config('psycrm.change_kind', $1, true)", [opts.kind])
    if (opts.reason) await tx.query("SELECT set_config('psycrm.change_reason', $1, true)", [opts.reason])
    return fn(tx)
  })
}

/**
 * Pretend the 72 h window of a session note has closed by rewriting `locks_at` as a
 * superuser that bypasses the triggers — something the application can never do.
 */
export function closeNoteWindow(pg: import('@electric-sql/pglite').PGlite, noteId: string): Promise<unknown> {
  return pg.exec(
    `SET session_replication_role = replica; UPDATE session_notes SET locks_at = now() - interval '1 minute' WHERE id = '${noteId}'; SET session_replication_role = DEFAULT;`,
  )
}

/** Pretend a note's window closes in `minutes` minutes (for the "locking soon" list). */
export function setNoteWindow(pg: import('@electric-sql/pglite').PGlite, noteId: string, minutes: number): Promise<unknown> {
  return pg.exec(
    `SET session_replication_role = replica; UPDATE session_notes SET locks_at = now() + interval '${minutes} minutes' WHERE id = '${noteId}'; SET session_replication_role = DEFAULT;`,
  )
}

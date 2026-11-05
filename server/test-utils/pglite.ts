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

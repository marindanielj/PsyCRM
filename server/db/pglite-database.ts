import type { PGlite, Transaction } from '@electric-sql/pglite'
import type { Database } from './database'

/** A Database bound to an open PGlite transaction; nested transaction() joins it. */
class PgliteTxDatabase implements Database {
  constructor(private tx: Transaction) {}
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.tx.query<T>(sql, params as unknown[])
    return res.rows
  }
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

/**
 * Database backed by PGlite (in-process WASM Postgres). Lets the full app run
 * locally against a real Postgres engine with no Docker — used by dev-server.ts
 * for honest local screenshots and by any test that wants a live backend rather
 * than FakeDatabase. Same `$1` params and SQL as PgDatabase, so repos behave
 * identically.
 */
export class PgliteDatabase implements Database {
  constructor(private pg: PGlite) {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pg.query<T>(sql, params as unknown[])
    return res.rows
  }

  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return this.pg.transaction((tx) => fn(new PgliteTxDatabase(tx)))
  }
}

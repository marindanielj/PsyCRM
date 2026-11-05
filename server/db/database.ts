import type { Pool, PoolClient } from 'pg'

/**
 * Thin query surface every repo depends on. Keeping repos behind this interface
 * (rather than a raw pg Pool) is what makes the tenancy invariant unit-testable
 * with FakeDatabase — no live Postgres required to prove location isolation.
 */
export interface Database {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  /**
   * Run `fn` atomically: every query made through the `tx` it receives commits
   * together, or all roll back if `fn` throws. Used to write a change and its
   * audit row as one unit. Re-entrant: calling `transaction` on a `tx` simply
   * joins the transaction already open (no savepoint).
   */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>
}

/** A Database bound to one checked-out connection that is already inside BEGIN. */
class ClientDatabase implements Database {
  constructor(private client: PoolClient) {}
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query(sql, params as unknown[])
    return result.rows as T[]
  }
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return fn(this)
  }
}

/** Production implementation backed by a pg connection pool. */
export class PgDatabase implements Database {
  constructor(private pool: Pool) {}
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params as unknown[])
    return result.rows as T[]
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn(new ClientDatabase(client))
      await client.query('COMMIT')
      return out
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* the original error is the one worth surfacing */
      }
      throw err
    } finally {
      client.release()
    }
  }
}

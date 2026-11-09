import type { Database } from '../db/database'

export interface Operator {
  id: string
  email: string
  name: string | null
  role: string
  password_hash: string
}

export interface Location {
  id: string
  name: string
  slug: string
  client_slug: string | null
  branding: Record<string, unknown>
  settings: Record<string, unknown>
}

/**
 * NOT location-scoped — operators are global identities. Their access to a
 * location is mediated by operator_locations; `hasAccess` is what the
 * location-access middleware calls to decide 403.
 */
export class OperatorsRepo {
  constructor(private db: Database) {}

  async findByEmail(email: string): Promise<Operator | undefined> {
    const rows = await this.db.query<Operator>(
      'SELECT id, email, name, role, password_hash FROM operators WHERE email=$1',
      [email.toLowerCase()],
    )
    return rows[0]
  }

  async getById(id: string): Promise<Operator | undefined> {
    const rows = await this.db.query<Operator>(
      'SELECT id, email, name, role, password_hash FROM operators WHERE id=$1',
      [id],
    )
    return rows[0]
  }

  /** When the operator last changed their password (epoch ms), or null if never. Sessions issued earlier are void. */
  async passwordChangedAt(id: string): Promise<number | null> {
    const rows = await this.db.query<{ ms: number | null }>(
      'SELECT (extract(epoch FROM password_changed_at) * 1000)::float8 AS ms FROM operators WHERE id=$1',
      [id],
    )
    const ms = rows[0]?.ms
    return ms === null || ms === undefined ? null : Number(ms)
  }

  async changePassword(id: string, passwordHash: string, atMs: number): Promise<void> {
    await this.db.query('UPDATE operators SET password_hash=$2, password_changed_at=to_timestamp($3::float8 / 1000.0) WHERE id=$1', [
      id,
      passwordHash,
      atMs,
    ])
  }

  async hasAccess(operatorId: string, locationId: string): Promise<boolean> {
    const rows = await this.db.query(
      'SELECT 1 FROM operator_locations WHERE operator_id=$1 AND location_id=$2',
      [operatorId, locationId],
    )
    return rows.length > 0
  }

  listLocations(operatorId: string): Promise<Location[]> {
    return this.db.query<Location>(
      `SELECT l.id, l.name, l.slug, l.client_slug, l.branding, l.settings
       FROM locations l
       JOIN operator_locations ol ON ol.location_id = l.id
       WHERE ol.operator_id=$1
       ORDER BY l.name`,
      [operatorId],
    )
  }
}

import { nanoid } from 'nanoid'
import { audit } from '../lib/audit'
import type { PacketInput } from '../lib/document-vocab'
import { LocationScopedRepo } from './base-repo'
import { type DocActor, DocumentTemplatesRepo } from './document-templates-repo'

export interface DocumentPacket {
  id: string
  name: string
  description: string | null
  familyIds: string[]
  audience: 'adult' | 'adolescent'
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

interface Row {
  id: string
  name: string
  description: string | null
  family_ids: string[]
  audience: 'adult' | 'adolescent'
  archived_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}
const COLS = 'id, name, description, family_ids, audience, archived_at, created_at, updated_at'
const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString())
const toPacket = (r: Row): DocumentPacket => ({
  id: r.id, name: r.name, description: r.description, familyIds: r.family_ids, audience: r.audience,
  archivedAt: iso(r.archived_at), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
})

export type PacketResult<T> = ({ ok: true } & T) | { ok: false; error: 'not_found' } | { ok: false; error: 'unknown_family'; familyIds: string[] }

export class DocumentPacketsRepo extends LocationScopedRepo {
  async list(opts: { includeArchived?: boolean } = {}): Promise<DocumentPacket[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM document_packets WHERE location_id = $1 ${opts.includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY name`,
      [this.locationId],
    )
    return rows.map(toPacket)
  }

  async get(id: string): Promise<DocumentPacket | null> {
    const rows = await this.db.query<Row>(`SELECT ${COLS} FROM document_packets WHERE location_id = $1 AND id = $2`, [this.locationId, id])
    return rows[0] ? toPacket(rows[0]) : null
  }

  private async missingFamilies(familyIds: string[]): Promise<string[]> {
    const have = await new DocumentTemplatesRepo(this.db, this.locationId).existingFamilies(familyIds)
    return [...new Set(familyIds)].filter((f) => !have.has(f))
  }

  async create(input: PacketInput, actor: DocActor): Promise<PacketResult<{ packet: DocumentPacket }>> {
    const missing = await this.missingFamilies(input.familyIds)
    if (missing.length) return { ok: false, error: 'unknown_family', familyIds: missing }
    const id = nanoid()
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<Row>(
        `INSERT INTO document_packets (id, location_id, name, description, family_ids, audience) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`,
        [id, this.locationId, input.name, input.description ?? null, input.familyIds, input.audience],
      )
      await audit(tx, this.locationId, {
        action: 'packet.created', entityType: 'document_packet', entityId: id,
        details: { audience: input.audience, documents: input.familyIds.length },
        actor: { type: 'operator', id: actor.operatorId }, ip: actor.ip, userAgent: actor.userAgent,
      })
      return { ok: true, packet: toPacket(rows[0]!) }
    })
  }

  async update(id: string, patch: Partial<PacketInput> & { archived?: boolean }, actor: DocActor): Promise<PacketResult<{ packet: DocumentPacket }>> {
    if (patch.familyIds) {
      const missing = await this.missingFamilies(patch.familyIds)
      if (missing.length) return { ok: false, error: 'unknown_family', familyIds: missing }
    }
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM document_packets WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      const next = {
        name: patch.name ?? cur.name,
        description: patch.description === undefined ? cur.description : patch.description,
        familyIds: patch.familyIds ?? cur.family_ids,
        audience: patch.audience ?? cur.audience,
      }
      const archivedSql = patch.archived === undefined ? 'archived_at' : patch.archived ? 'COALESCE(archived_at, now())' : 'NULL'
      const rows = await tx.query<Row>(
        `UPDATE document_packets SET name=$3, description=$4, family_ids=$5, audience=$6, archived_at=${archivedSql}, updated_at=now()
          WHERE location_id=$1 AND id=$2 RETURNING ${COLS}`,
        [this.locationId, id, next.name, next.description, next.familyIds, next.audience],
      )
      await audit(tx, this.locationId, {
        action: 'packet.updated', entityType: 'document_packet', entityId: id,
        details: { changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) },
        actor: { type: 'operator', id: actor.operatorId }, ip: actor.ip, userAgent: actor.userAgent,
      })
      return { ok: true, packet: toPacket(rows[0]!) }
    })
  }
}

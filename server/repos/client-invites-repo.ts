import { nanoid } from 'nanoid'
import { type AuditEntry, audit } from '../lib/audit'
import { LocationScopedRepo } from './base-repo'
import type { DocActorRef } from './document-requests-repo'

export type InviteKind = 'adult' | 'guardian'
export type InviteStatus = 'sent' | 'completed' | 'expired' | 'voided'

export interface ClientInvite {
  id: string
  kind: InviteKind
  name: string
  email: string
  status: InviteStatus
  sentAt: string
  expiresAt: string
  openedAt: string | null
  completedAt: string | null
  contactId: string | null
}

interface Row {
  id: string; kind: InviteKind; name: string; email: string; status: InviteStatus
  sent_at: Date | string; expires_at: Date | string; opened_at: Date | string | null; completed_at: Date | string | null; contact_id: string | null
}
const COLS = 'id, kind, name, email, status, sent_at, expires_at, opened_at, completed_at, contact_id'
const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString())
const toInvite = (r: Row): ClientInvite => ({
  id: r.id, kind: r.kind, name: r.name, email: r.email, status: r.status, sentAt: iso(r.sent_at)!, expiresAt: iso(r.expires_at)!,
  openedAt: iso(r.opened_at), completedAt: iso(r.completed_at), contactId: r.contact_id,
})

export type InviteResult<T> = ({ ok: true } & T) | { ok: false; error: 'not_found' | 'not_open' } | { ok: false; error: 'already_invited'; inviteId: string }

export class ClientInvitesRepo extends LocationScopedRepo {
  private operator(actor: DocActorRef): Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'> {
    return { actor: { type: 'operator', id: actor.operatorId }, ip: actor.ip, userAgent: actor.userAgent }
  }

  async create(input: { kind: InviteKind; name: string; email: string; tokenHash: string }, actor: DocActorRef): Promise<InviteResult<{ invite: ClientInvite }>> {
    const email = input.email.trim().toLowerCase()
    return this.db.transaction(async (tx) => {
      // One open invitation per email: a second click should resend, not pile up links.
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM client_invites WHERE location_id = $1 AND lower(email) = $2 AND status = 'sent' AND expires_at > now() LIMIT 1`, [this.locationId, email],
      )
      if (open[0]) return { ok: false, error: 'already_invited', inviteId: open[0].id }
      const id = nanoid()
      const r = (await tx.query<Row>(
        `INSERT INTO client_invites (id, location_id, kind, name, email, token_hash, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
        [id, this.locationId, input.kind, input.name, email, input.tokenHash, actor.operatorId],
      ))[0]!
      // Names and emails are not logged: the entry says who was invited by id and what kind.
      await audit(tx, this.locationId, { action: 'invite.sent', entityType: 'client_invite', entityId: id, details: { kind: input.kind }, ...this.operator(actor) })
      return { ok: true, invite: toInvite(r) }
    })
  }

  /** Newest first. Past-deadline invitations are closed (and audited) when anyone looks. */
  async list(opts: { limit?: number } = {}): Promise<ClientInvite[]> {
    await this.expireDue()
    const rows = await this.db.query<Row>(`SELECT ${COLS} FROM client_invites WHERE location_id = $1 ORDER BY sent_at DESC LIMIT $2`, [this.locationId, Math.min(opts.limit ?? 50, 200)])
    return rows.map(toInvite)
  }

  async get(id: string): Promise<ClientInvite | null> {
    const r = (await this.db.query<Row>(`SELECT ${COLS} FROM client_invites WHERE location_id = $1 AND id = $2`, [this.locationId, id]))[0]
    return r ? toInvite(r) : null
  }

  async expireDue(now: Date = new Date()): Promise<void> {
    const due = await this.db.query<{ id: string }>(`UPDATE client_invites SET status = 'expired' WHERE location_id = $1 AND status = 'sent' AND expires_at <= $2 RETURNING id`, [this.locationId, now.toISOString()])
    for (const { id } of due) await audit(this.db, this.locationId, { action: 'invite.expired', entityType: 'client_invite', entityId: id, details: {}, actor: { type: 'system', label: 'Invitation expiry' } })
  }

  /** A new link for the same invitation (the old one stops working) and a fresh 14 days. */
  async rotate(id: string, tokenHash: string, actor: DocActorRef): Promise<InviteResult<{ invite: ClientInvite }>> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM client_invites WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      if (cur.status === 'completed' || cur.status === 'voided') return { ok: false, error: 'not_open' }
      const r = (await tx.query<Row>(
        `UPDATE client_invites SET token_hash = $3, status = 'sent', expires_at = now() + interval '14 days', opened_at = NULL WHERE location_id = $1 AND id = $2 RETURNING ${COLS}`, [this.locationId, id, tokenHash],
      ))[0]!
      await audit(tx, this.locationId, { action: 'invite.resent', entityType: 'client_invite', entityId: id, details: { kind: cur.kind }, ...this.operator(actor) })
      return { ok: true, invite: toInvite(r) }
    })
  }

  async void(id: string, actor: DocActorRef): Promise<InviteResult<{ invite: ClientInvite }>> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM client_invites WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      if (cur.status === 'completed' || cur.status === 'voided') return { ok: false, error: 'not_open' }
      const r = (await tx.query<Row>(`UPDATE client_invites SET status = 'voided', voided_at = now() WHERE location_id = $1 AND id = $2 RETURNING ${COLS}`, [this.locationId, id]))[0]!
      await audit(tx, this.locationId, { action: 'invite.voided', entityType: 'client_invite', entityId: id, details: { previousStatus: cur.status }, ...this.operator(actor) })
      return { ok: true, invite: toInvite(r) }
    })
  }
}

// --- public lookup: the person has only a token ---------------------------------------------

export interface InviteContext {
  locationId: string
  invite: ClientInvite
  tokenHash: string
}

/** Find the invitation a link belongs to (one query for every outcome, so a bad token costs the same as a good one). */
export async function findInviteByTokenHash(db: import('../db/database').Database, tokenHash: string): Promise<InviteContext | null> {
  const r = (await db.query<Row & { location_id: string }>(`SELECT ${COLS}, location_id FROM client_invites WHERE token_hash = $1`, [tokenHash]))[0]
  return r ? { locationId: r.location_id, invite: toInvite(r), tokenHash } : null
}

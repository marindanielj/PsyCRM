import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'

/**
 * An invoice or receipt emailed to the client. The email carries only a link; the page behind it needs a one-time code sent
 * to the same address. Only the hash of the link token and of the code are stored, never the token or the code.
 */
type Ctx = Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'>

export type ShareKind = 'invoice' | 'receipt'

export const SHARE_TTL_DAYS = 30

export interface Share {
  id: string
  location_id: string
  contact_id: string
  kind: ShareKind
  document_id: string
  email: string
  otp_hash: string | null
  otp_expires_at: string | null
  otp_attempts: number
  expires_at: string
}

const COLS = 'id, location_id, contact_id, kind, document_id, email, otp_hash, otp_expires_at, otp_attempts, expires_at'

/** The share behind a link, found by the hash of its token (the public page has no session, so no location yet). */
export async function findShareByTokenHash(db: Database, tokenHash: string): Promise<Share | undefined> {
  return (await db.query<Share>(`SELECT ${COLS} FROM billing_shares WHERE token_hash = $1`, [tokenHash]))[0]
}

export class BillingSharesRepo {
  constructor(private readonly db: Database, private readonly locationId: string) {}

  /** The addresses a client has on file: the only places a document may be sent. */
  async contactEmails(contactId: string): Promise<string[] | null> {
    const row = (await this.db.query<{ emails: string[] | null }>('SELECT emails FROM contacts WHERE location_id = $1 AND id = $2', [this.locationId, contactId]))[0]
    return row ? (row.emails ?? []) : null
  }

  async create(
    input: { kind: ShareKind; documentId: string; contactId: string; email: string; tokenHash: string; createdBy: string; number: string; now?: Date },
    ctx: Ctx,
  ): Promise<string> {
    const id = nanoid()
    const expires = new Date((input.now ?? new Date()).getTime() + SHARE_TTL_DAYS * 24 * 3600_000)
    await this.db.query(
      `INSERT INTO billing_shares (id, location_id, contact_id, kind, document_id, email, token_hash, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, this.locationId, input.contactId, input.kind, input.documentId, input.email, input.tokenHash, input.createdBy, expires.toISOString()],
    )
    // The address and the link are never written to the log: only that it was sent, and which document.
    await audit(this.db, this.locationId, { action: `${input.kind}.emailed`, entityType: input.kind, entityId: input.documentId, contactId: input.contactId, details: { number: input.number }, ...ctx })
    return id
  }

  /** A link whose email could not be sent is dropped, so no live link exists that nobody received. */
  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM billing_shares WHERE location_id = $1 AND id = $2', [this.locationId, id])
  }

  /** Stores a new code. The attempt counter is NOT reset: asking for new codes must not give more guesses. */
  async storeOtp(id: string, otpHash: string, expiresAt: Date): Promise<void> {
    await this.db.query('UPDATE billing_shares SET otp_hash = $3, otp_expires_at = $4 WHERE location_id = $1 AND id = $2', [this.locationId, id, otpHash, expiresAt.toISOString()])
  }

  async failOtp(id: string): Promise<number> {
    const r = await this.db.query<{ otp_attempts: number }>('UPDATE billing_shares SET otp_attempts = otp_attempts + 1 WHERE location_id = $1 AND id = $2 RETURNING otp_attempts', [this.locationId, id])
    return r[0]?.otp_attempts ?? 0
  }

  /** The code was right: it is used up, and the client's opening of the document is logged. */
  async markVerified(share: Share, number: string, ctx: Ctx): Promise<void> {
    await this.db.query('UPDATE billing_shares SET otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE location_id = $1 AND id = $2', [this.locationId, share.id])
    await audit(this.db, this.locationId, { action: `${share.kind}.viewed`, entityType: share.kind, entityId: share.document_id, contactId: share.contact_id, details: { number, by: 'client' }, ...ctx })
  }
}

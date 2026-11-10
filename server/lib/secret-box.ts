/**
 * Seal a short secret so it can be stored and read back later by the server, but not by someone holding only a copy of
 * the database.
 *
 * Used for the therapist's private calendar address: that address IS the credential (anyone with it can read the
 * calendar), and the poller must be able to use it, so a one-way hash will not do. AES-256-GCM with a key derived from
 * SESSION_SECRET; the label is mixed into the derivation so a key for one purpose never opens another's data.
 *
 * Rotating SESSION_SECRET makes sealed values unreadable (`open` returns null); the person reconnects the calendar.
 * That is deliberate: no second key to store, and a leaked database alone yields nothing.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const VERSION = 'v1'

function key(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'psycrm-secret-box', label, 32))
}

export function seal(plain: string, secret: string, label: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret, label), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`
}

/** The original text, or null when the value is malformed, was sealed under another secret/label, or was altered. */
export function open(sealed: string, secret: string, label: string): string | null {
  const [v, data] = sealed.split('.')
  if (v !== VERSION || !data) return null
  try {
    const raw = Buffer.from(data, 'base64url')
    if (raw.length < 12 + 16 + 1) return null
    const decipher = createDecipheriv('aes-256-gcm', key(secret, label), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

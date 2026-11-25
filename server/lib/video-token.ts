import { createHmac } from 'node:crypto'
import { hashToken } from './document-tokens'

/**
 * The client's video link token: HMAC-SHA256 over the meeting id, 43 base64url characters (the same
 * shape as the other public links, so `looksLikeToken` accepts it). Derived, not random, so the link
 * can be shown again for a reminder without storing it; the database keeps only its hash.
 */
export const videoToken = (meetingId: string, secret: string): string =>
  createHmac('sha256', secret).update(`video:${meetingId}`).digest('base64url')

export const videoTokenHash = (token: string): string => hashToken(token)

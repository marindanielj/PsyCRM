/**
 * Web copy of RESERVED_KEYS in server/lib/invite-custom-fields.ts: the custom fields the invitation form asks
 * with its own questions (or that hold system bookkeeping), so switching them on or off means nothing.
 * server/lib/invite-custom-fields.test.ts fails if the two lists drift apart.
 */
export const RESERVED_INVITE_KEYS: readonly string[] = ['date_of_birth', 'guardian_name', 'guardian_email', 'guardian_phone', 'intake_conflicts']

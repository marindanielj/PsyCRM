/**
 * Recognise a Postgres unique-constraint violation across both backends we run.
 * node-postgres (prod) and PGlite (dev/tests) each surface SQLSTATE 23505 as
 * `err.code`, so the code check is the reliable path; a message match is a
 * belt-and-suspenders fallback for any wrapper that loses the code. We return
 * false for every other error so callers RETHROW it — a real fault must never be
 * masked as a benign conflict.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  if ((err as { code?: unknown }).code === '23505') return true
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' && /duplicate key value|unique constraint/i.test(message)
}

/**
 * Something else still points at the row being deleted. Postgres reports a plain foreign key as 23503, but
 * `ON DELETE RESTRICT` (which the session notes use on purpose) as 23001, so both count.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  if (code === '23503' || code === '23001') return true
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' && /violates (RESTRICT setting of )?foreign key constraint|violates RESTRICT setting of foreign key/i.test(message)
}

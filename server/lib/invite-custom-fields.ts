import type { Database } from '../db/database'
import { isValidIsoDate } from './age'
import { coerceCustomFieldValue } from './custom-field-key'

/**
 * The practice's custom fields, as the registration form of an invitation asks them.
 *
 * Read when the page is OPENED and again when it is SUBMITTED, never copied when the invitation is
 * created: a field the practice adds today is on the next form, and one it removes is gone from it.
 */

/** Keys the form already asks for itself (or that hold system bookkeeping): never asked twice, never writable from a form. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['date_of_birth', 'guardian_name', 'guardian_email', 'guardian_phone', 'intake_conflicts'])

export const MAX_TEXT = 500
export const MAX_TEXTAREA = 2000
export const MAX_ANSWERS = 50

export interface InviteField {
  key: string
  label: string
  type: string
  options: string[]
  placeholder: string | null
}

export async function inviteFields(db: Database, locationId: string): Promise<InviteField[]> {
  const rows = await db.query<{ key: string; label: string; type: string; options: unknown; placeholder: string | null }>(
    'SELECT key, label, type, options, placeholder FROM custom_fields WHERE location_id = $1 AND show_on_invite ORDER BY position, created_at',
    [locationId],
  )
  return rows
    .filter((r) => !RESERVED_KEYS.has(r.key))
    .map((r) => ({
      key: r.key,
      label: r.label,
      type: r.type,
      options: Array.isArray(r.options) ? r.options.map(String) : [],
      placeholder: r.placeholder,
    }))
}

export type AnswerCheck = { ok: true; values: Record<string, string | number | boolean> } | { ok: false; field: string }

/**
 * What the person typed, checked against the fields the form asks TODAY. Answers for a field that no longer
 * exists (or was hidden after the page was opened) are ignored, an empty answer is no answer, and an unchecked
 * box stores nothing. An answer that does not fit its field's type is refused, naming the field.
 */
export function checkAnswers(fields: InviteField[], raw: Record<string, unknown> | undefined): AnswerCheck {
  const values: Record<string, string | number | boolean> = {}
  for (const f of fields) {
    if (!raw || !(f.key in raw)) continue
    const given = raw[f.key]
    const answer = coerceCustomFieldValue(f.type, given)
    const bad = (): AnswerCheck => ({ ok: false, field: f.label })
    // Empty is no answer; but a value that was typed and could not be read (a number field holding "muchos")
    // is a mistake to correct, not something to drop in silence.
    const typed = !(given === null || given === undefined || (typeof given === 'string' && given.trim() === ''))
    if (answer === null && typed && f.type !== 'checkbox') return bad()
    if (answer === null || answer === false) continue
    switch (f.type) {
      case 'number':
        if (typeof answer !== 'number' || Math.abs(answer) > 1e12) return bad()
        break
      case 'date':
        if (typeof answer !== 'string' || !isValidIsoDate(answer)) return bad()
        break
      case 'dropdown':
        if (typeof answer !== 'string' || !f.options.includes(answer)) return bad()
        break
      case 'textarea':
        if (typeof answer !== 'string' || answer.length > MAX_TEXTAREA) return bad()
        break
      case 'checkbox':
        break // only `true` reaches here
      default:
        if (typeof answer !== 'string' || answer.length > MAX_TEXT) return bad()
    }
    values[f.key] = answer
  }
  return { ok: true, values }
}

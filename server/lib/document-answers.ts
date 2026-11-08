import { DISPLAY_TYPES, type TemplateField } from './document-vocab'

/** Does a field's `showIf` condition hold for the answers so far? (No condition = always shown.) */
export function fieldVisible(f: TemplateField, values: Record<string, unknown> | undefined): boolean {
  if (!f.showIf) return true
  const v = values?.[f.showIf.key]
  if (typeof f.showIf.equals === 'boolean') return v === f.showIf.equals || v === String(f.showIf.equals)
  return v === f.showIf.equals
}

export type AnswerIssue = { key: string; reason: 'required' | 'invalid' }

const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate and clean a signer's answers against a template. Unknown keys and answers to
 * hidden (showIf) fields are dropped; every kept value is normalised to its stored shape:
 * text-like -> string, checkbox -> boolean, checkbox_group -> string[], yes_no -> 'yes'|'no'.
 */
export function cleanAnswers(
  fields: TemplateField[],
  input: Record<string, unknown>,
): { values: Record<string, unknown>; issues: AnswerIssue[] } {
  const values: Record<string, unknown> = {}
  const issues: AnswerIssue[] = []
  for (const f of fields) {
    if (DISPLAY_TYPES.has(f.type)) continue
    if (!fieldVisible(f, values)) continue
    const raw = input[f.key]
    const optionValues = new Set((f.options ?? []).map((o) => o.value))
    let v: unknown
    let empty = false
    switch (f.type) {
      case 'checkbox':
        v = raw === true || raw === 'true'
        empty = f.required === true && v === false // a required checkbox must be ticked
        break
      case 'checkbox_group': {
        const arr = Array.isArray(raw) ? raw.map(String) : []
        if (arr.some((x) => !optionValues.has(x))) { issues.push({ key: f.key, reason: 'invalid' }); continue }
        v = [...new Set(arr)]
        empty = arr.length === 0
        break
      }
      case 'yes_no': {
        const s = raw === true ? 'yes' : raw === false ? 'no' : typeof raw === 'string' ? raw : ''
        if (s !== '' && s !== 'yes' && s !== 'no') { issues.push({ key: f.key, reason: 'invalid' }); continue }
        v = s
        empty = s === ''
        break
      }
      default: {
        const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
        const max = f.type === 'textarea' ? 5000 : f.type === 'initials' ? 6 : 500
        if (s.length > max) { issues.push({ key: f.key, reason: 'invalid' }); continue }
        if (s !== '') {
          if (f.type === 'email' && !EMAIL.test(s)) { issues.push({ key: f.key, reason: 'invalid' }); continue }
          if (f.type === 'number' && !Number.isFinite(Number(s))) { issues.push({ key: f.key, reason: 'invalid' }); continue }
          if (f.type === 'date' && (!ISO_DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)))) { issues.push({ key: f.key, reason: 'invalid' }); continue }
          if ((f.type === 'select' || f.type === 'radio') && !optionValues.has(s)) { issues.push({ key: f.key, reason: 'invalid' }); continue }
        }
        v = s
        empty = s === ''
      }
    }
    if (empty && f.required) { issues.push({ key: f.key, reason: 'required' }); continue }
    if (f.type !== 'checkbox' && empty) continue // an optional blank is simply "not answered"
    values[f.key] = v
  }
  return { values, issues }
}

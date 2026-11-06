import type { PracticeProfile } from '../repos/practice-repo'
import { DISPLAY_TYPES, type SignerRole, type TemplateField } from './document-vocab'
import { escAttr, escText } from './page-html'

/**
 * Renders a document template to HTML. Pure: no I/O. One renderer serves the editor
 * preview (day 5), the public fill page and the frozen signed snapshot (day 6).
 *
 * The body is a restricted markdown (headings, paragraphs, lists, bold, italic,
 * rules). Raw HTML is never passed through: every character is escaped first, so a
 * `<script>` typed into a template is shown as text.
 */

export type RenderMode = 'preview' | 'fill' | 'signed'

export interface RenderableTemplate {
  title: string
  bodyMd: string
  fields: TemplateField[]
  locale: 'es' | 'en'
  signerRoles: SignerRole[]
}

export interface RenderContact {
  first_name: string | null
  last_name: string | null
  name: string | null
  dateOfBirth: string | null
}

export interface RenderContext {
  practice: PracticeProfile
  contact: RenderContact | null
  /** YYYY-MM-DD in practice time. */
  today: string
  mode: RenderMode
  /** Answers by field key (checkbox_group: string[], checkbox/yes_no: boolean|string). */
  values?: Record<string, unknown>
}

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2026-11-05" -> "5 de noviembre de 2026" (es) / "November 5, 2026" (en). Anything else -> ''. */
export function longDate(iso: string | null | undefined, locale: 'es' | 'en'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  if (!m) return ''
  const month = Number(m[2]) - 1
  if (month < 0 || month > 11) return ''
  const day = Number(m[3])
  return locale === 'es' ? `${day} de ${MONTHS_ES[month]} de ${m[1]}` : `${MONTHS_EN[month]} ${day}, ${m[1]}`
}

const UNKNOWN: Record<'es' | 'en', string> = { es: '[[campo desconocido]]', en: '[[unknown field]]' }

function mergeValues(t: RenderableTemplate, ctx: RenderContext): Record<string, string> {
  const c = ctx.contact
  const p = ctx.practice
  return {
    'client.full_name': c?.name ?? '',
    'client.first_name': c?.first_name ?? '',
    'client.date_of_birth': longDate(c?.dateOfBirth, t.locale),
    'practice.name': p.name,
    'practice.therapist': p.therapist,
    'practice.license': p.license,
    'practice.address': p.address,
    'practice.phone': p.phone,
    'fees.session': p.fees.session,
    'fees.intake': p.fees.intake,
    'fees.late_cancel': p.fees.late_cancel,
    'policy.cancel_hours': p.policy.cancel_hours,
    today: longDate(ctx.today, t.locale),
  }
}

/** Substitute merge tokens in already-escaped text. */
function applyMerge(escaped: string, t: RenderableTemplate, ctx: RenderContext, vals: Record<string, string>): string {
  return escaped.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_m, raw: string) => {
    const key = raw.toLowerCase()
    if (key.startsWith('field:')) return _m // placement tokens are handled per block
    if (key in vals) {
      const v = vals[key]!
      // A practice setting nobody filled in would go out as a blank in a legal text: flag it while editing.
      if (v === '' && ctx.mode === 'preview' && /^(practice|fees|policy)\./.test(key)) {
        return `<mark class="doc-unknown">${escText(t.locale === 'es' ? `[falta: ${key}]` : `[missing: ${key}]`)}</mark>`
      }
      return escText(v)
    }
    const text = UNKNOWN[t.locale]
    return ctx.mode === 'preview' ? `<mark class="doc-unknown">${escText(text)}</mark>` : escText(text)
  })
}

function inline(escaped: string): string {
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
}

function renderMarkdown(
  md: string,
  t: RenderableTemplate,
  ctx: RenderContext,
  vals: Record<string, string>,
  fieldHtml: (key: string) => string | null,
): string {
  const fmt = (line: string) => applyMerge(inline(escText(line)), t, ctx, vals)
  const out: string[] = []
  let para: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(fmt).join('<br>')}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${fmt(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const placed = /^\{\{\s*field:([a-z][a-z0-9_]*)\s*\}\}$/i.exec(line.trim())
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    const ul = /^\s*[-*]\s+(.+)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (line.trim() === '') {
      flushPara()
      flushList()
    } else if (placed) {
      flushPara()
      flushList()
      const html = fieldHtml(placed[1]!)
      if (html) out.push(html)
    } else if (/^-{3,}$/.test(line.trim())) {
      flushPara()
      flushList()
      out.push('<hr>')
    } else if (heading) {
      flushPara()
      flushList()
      const level = heading[1]!.length + 1 // h1 is the document title
      out.push(`<h${level}>${fmt(heading[2]!)}</h${level}>`)
    } else if (ul || ol) {
      flushPara()
      const tag = ul ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push((ul ?? ol)![1]!)
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
  flushList()
  return out.join('\n')
}

// --- fields ----------------------------------------------------------------

const YES_NO: Record<'es' | 'en', [string, string]> = { es: ['Sí', 'No'], en: ['Yes', 'No'] }

function valueOf(values: Record<string, unknown> | undefined, key: string): unknown {
  return values?.[key]
}

function showIfHolds(f: TemplateField, values: Record<string, unknown> | undefined): boolean {
  if (!f.showIf) return true
  const v = valueOf(values, f.showIf.key)
  if (typeof f.showIf.equals === 'boolean') return v === f.showIf.equals || v === String(f.showIf.equals)
  return v === f.showIf.equals
}

function optionLabel(f: TemplateField, value: string): string {
  return f.options?.find((o) => o.value === value)?.label ?? value
}

/** Read-only text of an answer (signed mode). */
function answerText(f: TemplateField, v: unknown, locale: 'es' | 'en'): string {
  if (v === undefined || v === null || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.map((x) => optionLabel(f, String(x))).join(', ') : '—'
  if (f.type === 'checkbox') return v === true || v === 'true' ? YES_NO[locale][0] : YES_NO[locale][1]
  if (f.type === 'yes_no') return v === true || v === 'true' || v === 'yes' ? YES_NO[locale][0] : YES_NO[locale][1]
  if (f.type === 'date') return longDate(String(v), locale) || String(v)
  if (f.type === 'select' || f.type === 'radio') return optionLabel(f, String(v))
  return String(v)
}

const INPUT_TYPE: Partial<Record<TemplateField['type'], string>> = { text: 'text', email: 'email', phone: 'tel', date: 'date', number: 'number', initials: 'text' }

function renderOneField(f: TemplateField, t: RenderableTemplate, ctx: RenderContext, vals: Record<string, string>): string {
  const label = applyMerge(escText(f.label), t, ctx, vals)
  if (f.type === 'heading') return `<h3 class="doc-heading">${label}</h3>`
  if (f.type === 'paragraph') return `<p class="doc-paragraph">${label}</p>`

  const showIf = f.showIf ? ` data-show-if-key="${escAttr(f.showIf.key)}" data-show-if-equals="${escAttr(String(f.showIf.equals))}"` : ''
  const cls = `doc-field doc-${f.type}`
  const help = f.help ? `<small class="doc-help">${escText(f.help)}</small>` : ''
  const star = f.required ? '<span class="doc-req" aria-hidden="true"> *</span>' : ''
  const head = `<span class="doc-label">${label}${star}</span>`
  const name = escAttr(f.key)

  if (ctx.mode === 'signed') {
    if (!showIfHolds(f, ctx.values)) return ''
    return `<div class="${cls}"${showIf}>${head}<span class="doc-answer">${escText(answerText(f, valueOf(ctx.values, f.key), t.locale))}</span></div>`
  }

  const disabled = ctx.mode === 'preview' ? ' disabled' : ''
  const req = f.required && ctx.mode === 'fill' ? ' required' : ''
  let control: string
  switch (f.type) {
    case 'textarea':
      control = `<textarea name="${name}" rows="4"${disabled}${req}></textarea>`
      break
    case 'select':
      control = `<select name="${name}"${disabled}${req}><option value=""></option>${(f.options ?? []).map((o) => `<option value="${escAttr(o.value)}">${escText(o.label)}</option>`).join('')}</select>`
      break
    case 'radio':
      control = `<span class="doc-options">${(f.options ?? []).map((o) => `<label><input type="radio" name="${name}" value="${escAttr(o.value)}"${disabled}${req}> ${escText(o.label)}</label>`).join('')}</span>`
      break
    case 'checkbox_group':
      control = `<span class="doc-options">${(f.options ?? []).map((o) => `<label><input type="checkbox" name="${name}" value="${escAttr(o.value)}"${disabled}> ${escText(o.label)}</label>`).join('')}</span>`
      break
    case 'checkbox':
      control = `<label class="doc-check"><input type="checkbox" name="${name}" value="true"${disabled}${req}> ${label}${star}</label>`
      return `<div class="${cls}"${showIf}>${control}${help}</div>`
    case 'yes_no':
      control = `<span class="doc-options"><label><input type="radio" name="${name}" value="yes"${disabled}${req}> ${YES_NO[t.locale][0]}</label><label><input type="radio" name="${name}" value="no"${disabled}${req}> ${YES_NO[t.locale][1]}</label></span>`
      break
    case 'initials':
      control = `<input type="text" name="${name}" maxlength="6" size="6" autocomplete="off"${disabled}${req}>`
      break
    default:
      control = `<input type="${INPUT_TYPE[f.type] ?? 'text'}" name="${name}"${disabled}${req}>`
  }
  return `<div class="${cls}"${showIf}>${head}${control}${help}</div>`
}

const STYLE = `
body{font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;margin:0;background:#fff}
.doc{max-width:720px;margin:0 auto;padding:24px 20px}
.doc h1{font-size:1.5rem;margin:.2em 0 .8em}.doc h2{font-size:1.2rem;margin:1.4em 0 .4em}.doc h3,.doc h4{font-size:1.05rem;margin:1.2em 0 .3em}
.doc p{margin:.6em 0}.doc ul,.doc ol{padding-left:1.4em}.doc hr{border:0;border-top:1px solid #cbd5e1;margin:1.4em 0}
.doc-unknown{background:#fde68a;padding:0 .2em;border-radius:3px}
.doc-field{margin:1em 0;display:block}.doc-label{display:block;font-weight:600;margin-bottom:.25em}.doc-req{color:#be123c}
.doc-field input[type=text],.doc-field input[type=email],.doc-field input[type=tel],.doc-field input[type=date],.doc-field input[type=number],.doc-field select,.doc-field textarea{width:100%;box-sizing:border-box;padding:.5em .6em;border:1px solid #94a3b8;border-radius:6px;font:inherit}
.doc-field input[name]:disabled,.doc-field select:disabled,.doc-field textarea:disabled{background:#f8fafc}
.doc-initials input{width:auto!important}
.doc-options{display:flex;flex-wrap:wrap;gap:.4em 1.2em}.doc-options label,.doc-check{font-weight:400}
.doc-help{display:block;color:#475569;margin-top:.25em}.doc-answer{display:block;padding:.3em 0;border-bottom:1px dotted #94a3b8;white-space:pre-wrap}
.doc-badge{display:inline-block;font-size:.75rem;background:#e2e8f0;color:#334155;border-radius:999px;padding:.1em .6em;margin-left:.5em;vertical-align:middle}
.doc-sep{break-after:page;margin:0}
`

/** The document's HTML fragment (title + body + any fields not placed inline). */
export function renderDocumentBody(t: RenderableTemplate, ctx: RenderContext): string {
  const vals = mergeValues(t, ctx)
  const byKey = new Map(t.fields.map((f) => [f.key, f]))
  const placed = new Set<string>()
  const fieldHtml = (key: string): string | null => {
    const f = byKey.get(key)
    if (!f) return null
    placed.add(key)
    return renderOneField(f, t, ctx, vals)
  }
  const body = renderMarkdown(t.bodyMd, t, ctx, vals, fieldHtml)
  // Fields the author did not place inline follow the body, in order.
  const rest = t.fields.filter((f) => !placed.has(f.key)).map((f) => renderOneField(f, t, ctx, vals)).join('\n')
  const title = applyMerge(escText(t.title), t, ctx, vals)
  return `<article class="doc" lang="${t.locale}"><h1>${title}</h1>\n${body}\n${rest}</article>`
}

export function documentShell(title: string, body: string, locale: 'es' | 'en' = 'es'): string {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escText(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}

export function renderDocumentHtml(t: RenderableTemplate, ctx: RenderContext): string {
  return documentShell(t.title, renderDocumentBody(t, ctx), t.locale)
}

/** Several templates in sequence (packet preview). */
export function renderPacketHtml(templates: RenderableTemplate[], ctx: RenderContext, title: string): string {
  const body = templates.map((t) => renderDocumentBody(t, ctx)).join('\n<hr class="doc-sep">\n')
  return documentShell(title, body, templates[0]?.locale ?? 'es')
}

export { DISPLAY_TYPES }

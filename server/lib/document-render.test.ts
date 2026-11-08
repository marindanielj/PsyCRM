import { EMPTY_PRACTICE } from '../repos/practice-repo'
import { longDate, renderDocumentBody, renderDocumentHtml, renderPacketHtml, type RenderableTemplate, type RenderContext } from './document-render'
import type { TemplateField } from './document-vocab'

const practice = { ...EMPTY_PRACTICE, name: 'Consultorio <Rivera>', therapist: 'Dra. Rivera', license: '1234', fees: { session: '$100', intake: '$150', late_cancel: '$50' }, policy: { cancel_hours: '24' } }
const contact = { first_name: 'Ana', last_name: 'Rivera', name: 'Ana Rivera', dateOfBirth: '1990-04-12' }
const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({ practice, contact, today: '2026-11-05', mode: 'preview', ...over })
const tpl = (bodyMd: string, fields: TemplateField[] = [], over: Partial<RenderableTemplate> = {}): RenderableTemplate => ({
  title: 'Doc', bodyMd, fields, locale: 'es', signerRoles: ['client'], ...over,
})

test('dates are written in long Spanish (and English) form, never shifted by a timezone', () => {
  expect(longDate('2026-11-05', 'es')).toBe('5 de noviembre de 2026')
  expect(longDate('2026-01-01', 'en')).toBe('January 1, 2026')
  expect(longDate('nope', 'es')).toBe('')
  expect(longDate(null, 'es')).toBe('')
})

test('markdown: headings, lists, bold, italic, rules and paragraphs', () => {
  const html = renderDocumentBody(tpl('## Título\n\nTexto **fuerte** y *suave*.\n\n- uno\n- dos\n\n1. a\n2. b\n\n---'), ctx())
  expect(html).toContain('<h3>Título</h3>')
  expect(html).toContain('<strong>fuerte</strong>')
  expect(html).toContain('<em>suave</em>')
  expect(html).toContain('<ul><li>uno</li><li>dos</li></ul>')
  expect(html).toContain('<ol><li>a</li><li>b</li></ol>')
  expect(html).toContain('<hr>')
})

test('raw HTML in a template is shown as text, never executed', () => {
  const html = renderDocumentBody(tpl('<script>alert(1)</script> <img src=x onerror=alert(2)>', [], { title: '<b>x</b>' }), ctx())
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
})

test('merge fields: client, practice, fees, policy and today; values are escaped', () => {
  const html = renderDocumentBody(tpl('{{client.full_name}} · {{client.first_name}} · {{client.date_of_birth}} · {{practice.name}} · {{practice.therapist}} · {{fees.session}} · {{fees.intake}} · {{fees.late_cancel}} · {{policy.cancel_hours}} · {{today}}'), ctx())
  expect(html).toContain('Ana Rivera · Ana · 12 de abril de 1990 · Consultorio &lt;Rivera&gt; · Dra. Rivera · $100 · $150 · $50 · 24 · 5 de noviembre de 2026')
})

test('an unknown merge field is flagged in preview and plain text elsewhere', () => {
  expect(renderDocumentBody(tpl('{{nope.x}}'), ctx())).toContain('<mark class="doc-unknown">[[campo desconocido]]</mark>')
  const fill = renderDocumentBody(tpl('{{nope.x}}'), ctx({ mode: 'fill' }))
  expect(fill).toContain('[[campo desconocido]]')
  expect(fill).not.toContain('<mark')
})

test('every field type renders; preview is disabled, fill is enabled and required', () => {
  const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]
  const fields: TemplateField[] = [
    { key: 't', type: 'text', label: 'Texto', required: true },
    { key: 'ta', type: 'textarea', label: 'Área' },
    { key: 'e', type: 'email', label: 'Email' },
    { key: 'p', type: 'phone', label: 'Tel' },
    { key: 'd', type: 'date', label: 'Fecha' },
    { key: 'n', type: 'number', label: 'Num' },
    { key: 's', type: 'select', label: 'Sel', options: opts },
    { key: 'r', type: 'radio', label: 'Rad', options: opts },
    { key: 'c', type: 'checkbox', label: 'Chk' },
    { key: 'g', type: 'checkbox_group', label: 'Grp', options: opts },
    { key: 'y', type: 'yes_no', label: 'SN' },
    { key: 'i', type: 'initials', label: 'Ini' },
    { key: 'h', type: 'heading', label: 'Encabezado' },
    { key: 'pa', type: 'paragraph', label: 'Párrafo' },
  ]
  const preview = renderDocumentBody(tpl('', fields), ctx())
  for (const f of fields) if (f.type !== 'heading' && f.type !== 'paragraph') expect(preview).toContain(`name="${f.key}"`)
  expect(preview).toContain('<h3 class="doc-heading">Encabezado</h3>')
  expect(preview).toContain('disabled')
  expect(preview).not.toContain(' required')
  const fill = renderDocumentBody(tpl('', fields), ctx({ mode: 'fill' }))
  expect(fill).toContain('required')
  expect(fill).not.toContain('disabled')
  expect(fill).toContain('Sí')
})

test('{{field:key}} places a field inline; the rest follow the body in order', () => {
  const fields: TemplateField[] = [{ key: 'a', type: 'initials', label: 'AAA' }, { key: 'b', type: 'text', label: 'BBB' }]
  const html = renderDocumentBody(tpl('Antes\n\n{{field:b}}\n\nDespués', fields), ctx())
  expect(html.indexOf('BBB')).toBeGreaterThan(html.indexOf('Antes'))
  expect(html.indexOf('BBB')).toBeLessThan(html.indexOf('Después'))
  expect(html.indexOf('AAA')).toBeGreaterThan(html.indexOf('Después'))
  expect(html.match(/name="b"/g)).toHaveLength(1)
})

test('signed mode is read-only: answers shown, hidden conditional fields omitted', () => {
  const fields: TemplateField[] = [
    { key: 'meds', type: 'yes_no', label: 'Medicamentos' },
    { key: 'which', type: 'text', label: 'Cuáles', showIf: { key: 'meds', equals: 'yes' } },
    { key: 'g', type: 'checkbox_group', label: 'Medios', options: [{ value: 'sms', label: 'Texto' }, { value: 'email', label: 'Correo' }] },
  ]
  const shown = renderDocumentBody(tpl('', fields), ctx({ mode: 'signed', values: { meds: 'yes', which: 'Sertralina <50mg>', g: ['sms', 'email'] } }))
  expect(shown).toContain('Sertralina &lt;50mg&gt;')
  expect(shown).toContain('Texto, Correo')
  expect(shown).not.toContain('<input')
  const hidden = renderDocumentBody(tpl('', fields), ctx({ mode: 'signed', values: { meds: 'no' } }))
  expect(hidden).not.toContain('Cuáles')
})

test('a full page and a packet render in sequence', () => {
  expect(renderDocumentHtml(tpl('x'), ctx())).toMatch(/^<!doctype html><html lang="es">/)
  const packet = renderPacketHtml([tpl('uno', [], { title: 'A' }), tpl('dos', [], { title: 'B' })], ctx(), 'Paquete')
  expect(packet.indexOf('>A<')).toBeLessThan(packet.indexOf('>B<'))
  expect(packet).toContain('<title>Paquete</title>')
})

test('with no client, merge fields are blank rather than invented', () => {
  expect(renderDocumentBody(tpl('Hola {{client.first_name}}.'), ctx({ contact: null }))).toContain('<p>Hola .</p>')
})

test('preview flags a practice setting that is still empty, so a blank never slips into a legal text', () => {
  const empty = { ...practice, license: '' }
  expect(renderDocumentBody(tpl('Lic. {{practice.license}}'), ctx({ practice: empty }))).toContain('<mark class="doc-unknown">[falta: practice.license]</mark>')
  expect(renderDocumentBody(tpl('Lic. {{practice.license}}'), ctx({ practice: empty, mode: 'fill' }))).toContain('<p>Lic. </p>')
})

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { DocFieldType, DocTemplateField } from '../../lib/api'
import { cn } from '../../lib/utils'

const TYPE_LABELS: Record<DocFieldType, string> = {
  text: 'Short text', textarea: 'Long text', email: 'Email', phone: 'Phone', date: 'Date', number: 'Number',
  select: 'Dropdown', radio: 'Single choice', checkbox: 'Checkbox', checkbox_group: 'Multiple choice',
  yes_no: 'Yes / No', initials: 'Initials', heading: 'Heading', paragraph: 'Paragraph',
}
const NEEDS_OPTIONS = new Set<DocFieldType>(['select', 'radio', 'checkbox_group'])
const DISPLAY = new Set<DocFieldType>(['heading', 'paragraph'])
const MAPS_TO = [
  ['', "Don't copy"], ['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone'],
  ['custom:date_of_birth', 'Date of birth'], ['custom:emergency_contact_name', 'Emergency contact name'], ['custom:emergency_contact_phone', 'Emergency contact phone'],
] as const

const selectCls = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm'

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)

function nextKey(fields: DocTemplateField[], base: string): string {
  const taken = new Set(fields.map((f) => f.key))
  const b = /^[a-z]/.test(base) ? base : `f_${base}`
  let k = b
  for (let i = 2; taken.has(k); i++) k = `${b}_${i}`
  return k
}

/** Options are edited as one label per line; values are derived from the labels. */
const optionsToText = (f: DocTemplateField) => (f.options ?? []).map((o) => o.label).join('\n')
function textToOptions(text: string): { value: string; label: string }[] {
  const seen = new Set<string>()
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((label, i) => {
    let value = slug(label) || `opcion_${i + 1}`
    while (seen.has(value)) value = `${value}_${i}`
    seen.add(value)
    return { value, label }
  })
}

export function FieldBuilder({
  fields, onChange, types, disabled,
}: { fields: DocTemplateField[]; onChange: (f: DocTemplateField[]) => void; types: DocFieldType[]; disabled?: boolean }) {
  const [open, setOpen] = useState<string | null>(null)
  const set = (i: number, patch: Partial<DocTemplateField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= fields.length) return
    const copy = [...fields]
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
    onChange(copy)
  }
  const remove = (i: number) => {
    const key = fields[i]!.key
    // A later field whose condition pointed at this one would become invalid: drop that condition.
    onChange(fields.filter((_, j) => j !== i).map((f) => (f.showIf?.key === key ? { ...f, showIf: undefined } : f)))
  }
  const add = () => {
    const key = nextKey(fields, 'campo')
    onChange([...fields, { key, type: 'text', label: 'New field' }])
    setOpen(key)
  }

  return (
    <div className="space-y-2">
      {fields.length === 0 && <p className="text-sm text-slate-500">No fields yet. The document is just its text.</p>}
      {fields.map((f, i) => {
        const isOpen = open === f.key
        const earlier = fields.slice(0, i).filter((x) => !DISPLAY.has(x.type))
        return (
          <div key={f.key} className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center gap-2 px-3 py-2">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(isOpen ? null : f.key)} aria-expanded={isOpen}>
                <span className="block truncate text-sm font-medium text-slate-800">{f.label || '(no label)'}</span>
                <span className="text-xs text-slate-500">{TYPE_LABELS[f.type]}{f.required ? ' · required' : ''}{f.showIf ? ' · conditional' : ''}{f.mapsTo ? ' · saved to client' : ''}</span>
              </button>
              <Button type="button" variant="ghost" size="icon" aria-label="Move up" disabled={disabled || i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Move down" disabled={disabled || i === fields.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Remove field" disabled={disabled} onClick={() => remove(i)}><Trash2 className="h-4 w-4" /></Button>
            </div>
            {isOpen && (
              <div className={cn('grid gap-3 border-t border-slate-100 p-3 sm:grid-cols-2')}>
                <div className="sm:col-span-2">
                  <Label htmlFor={`f-label-${i}`}>Label</Label>
                  <Input id={`f-label-${i}`} value={f.label} maxLength={500} disabled={disabled} onChange={(e) => set(i, { label: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor={`f-type-${i}`}>Type</Label>
                  <select id={`f-type-${i}`} className={selectCls} value={f.type} disabled={disabled}
                    onChange={(e) => {
                      const type = e.target.value as DocFieldType
                      set(i, { type, options: NEEDS_OPTIONS.has(type) ? (f.options?.length ? f.options : [{ value: 'opcion_1', label: 'Opción 1' }]) : undefined, mapsTo: DISPLAY.has(type) ? undefined : f.mapsTo, required: DISPLAY.has(type) ? undefined : f.required })
                    }}>
                    {types.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
                <div>
                  <Label htmlFor={`f-key-${i}`}>Key (used by the placeholder)</Label>
                  <Input id={`f-key-${i}`} value={f.key} disabled={disabled} className="font-mono text-xs"
                    onChange={(e) => {
                      const key = slug(e.target.value)
                      if (!key || !/^[a-z]/.test(key) || fields.some((x, j) => j !== i && x.key === key)) return
                      onChange(fields.map((x, j) => (j === i ? { ...x, key } : x.showIf?.key === f.key ? { ...x, showIf: { ...x.showIf, key } } : x)))
                      setOpen(key)
                    }} />
                  <p className="mt-1 text-xs text-slate-500">Place it in the text with <code>{`{{field:${f.key}}}`}</code></p>
                </div>
                {!DISPLAY.has(f.type) && (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={!!f.required} disabled={disabled} onChange={(e) => set(i, { required: e.target.checked || undefined })} /> Required
                    </label>
                    <div>
                      <Label htmlFor={`f-map-${i}`}>Copy the answer to the client record</Label>
                      <select id={`f-map-${i}`} className={selectCls} value={f.mapsTo ?? ''} disabled={disabled} onChange={(e) => set(i, { mapsTo: e.target.value || undefined })}>
                        {MAPS_TO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        {f.mapsTo && !MAPS_TO.some(([v]) => v === f.mapsTo) && <option value={f.mapsTo}>{f.mapsTo}</option>}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor={`f-help-${i}`}>Help text (optional)</Label>
                      <Input id={`f-help-${i}`} value={f.help ?? ''} maxLength={500} disabled={disabled} onChange={(e) => set(i, { help: e.target.value || undefined })} />
                    </div>
                  </>
                )}
                {NEEDS_OPTIONS.has(f.type) && (
                  <div className="sm:col-span-2">
                    <Label htmlFor={`f-opts-${i}`}>Options (one per line)</Label>
                    <textarea id={`f-opts-${i}`} rows={4} disabled={disabled} className="w-full rounded-lg border border-slate-200 p-2 text-sm"
                      defaultValue={optionsToText(f)} onBlur={(e) => set(i, { options: textToOptions(e.target.value) })} />
                  </div>
                )}
                {earlier.length > 0 && (
                  <div className="sm:col-span-2">
                    <Label>Show only if…</Label>
                    <div className="flex flex-wrap items-center gap-2">
                      <select aria-label="Condition field" className={cn(selectCls, 'w-auto')} value={f.showIf?.key ?? ''} disabled={disabled}
                        onChange={(e) => set(i, { showIf: e.target.value ? { key: e.target.value, equals: 'yes' } : undefined })}>
                        <option value="">Always show</option>
                        {earlier.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </select>
                      {f.showIf && (
                        <>
                          <span className="text-sm text-slate-500">equals</span>
                          <Input aria-label="Condition value" className="w-32" value={String(f.showIf.equals)} disabled={disabled}
                            onChange={(e) => set(i, { showIf: { key: f.showIf!.key, equals: e.target.value } })} />
                          <span className="text-xs text-slate-500">(Yes/No answers are <code>yes</code> or <code>no</code>)</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={add}><Plus className="h-4 w-4" /> Add field</Button>
    </div>
  )
}

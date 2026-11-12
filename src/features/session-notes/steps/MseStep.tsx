import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import { MSE_DOMAINS, MSE_DOMAIN_KEYS, MSE_DOMAIN_LABELS, type MseDomain, label } from '../../../lib/clinical-vocab'
import { labelEs } from '../../../lib/intake-form'
import { cn } from '../../../lib/utils'
import { ChipGroup } from '../ChipGroup'
import { applyNormalMse } from '../note-utils'
import type { StepProps } from './step-types'

const TEXT = {
  en: { mood: 'Mood, in the client’s words', moodPh: '“I feel stuck”', rating: 'Mood rating (1–10)', none: 'not recorded', clear: 'Clear', slide: 'Move the slider to record a rating.', exam: 'Mental status exam', normal: 'Within normal limits', normalTitle: 'Fills only the domains you have not completed yet', notePh: 'Note (optional)', addNote: 'Add note', note: 'note' },
  es: { mood: 'Ánimo, en palabras del cliente', moodPh: '“Me siento estancado/a”', rating: 'Escala de ánimo (1–10)', none: 'sin registrar', clear: 'Borrar', slide: 'Mueva el control para registrar un valor.', exam: 'Examen del estado mental', normal: 'Dentro de límites normales', normalTitle: 'Llena solo las áreas que aún no ha completado', notePh: 'Nota (opcional)', addNote: 'Añadir nota', note: 'nota' },
}

/** Step 2: mood in the client's words, a 1–10 rating, and the mental status exam by domain. */
export function MseStep({ form, patch, readOnly, lang = 'en' }: StepProps) {
  const t = TEXT[lang]
  const name = (key: MseDomain) => (lang === 'es' ? labelEs(key) : MSE_DOMAIN_LABELS[key])
  const labelOf = lang === 'es' ? labelEs : label
  const [openNotes, setOpenNotes] = useState<Partial<Record<MseDomain, boolean>>>({})

  const setDomain = (key: MseDomain, next: { values?: string[]; note?: string }) => {
    const cur = form.mse[key] ?? { values: [], note: '' }
    patch({ mse: { ...form.mse, [key]: { values: next.values ?? cur.values, note: next.note ?? cur.note } } })
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="mse-mood">{t.mood}</Label>
          <Input id="mse-mood" disabled={readOnly} maxLength={500} placeholder={t.moodPh} value={form.moodReported} onChange={(e) => patch({ moodReported: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="mse-rating">
            {t.rating}: <span className="font-semibold">{form.moodRating ?? t.none}</span>
          </Label>
          <div className="flex items-center gap-3">
            <input
              id="mse-rating"
              type="range"
              min={1}
              max={10}
              step={1}
              disabled={readOnly}
              value={form.moodRating ?? 5}
              onChange={(e) => patch({ moodRating: Number(e.target.value) })}
              className={cn('h-2 w-full cursor-pointer accent-brand-600', form.moodRating === null && 'opacity-40')}
              aria-valuetext={form.moodRating === null ? t.none : String(form.moodRating)}
            />
            {form.moodRating !== null && !readOnly ? (
              <button type="button" className="shrink-0 text-xs text-slate-500 underline" onClick={() => patch({ moodRating: null })}>
                {t.clear}
              </button>
            ) : null}
          </div>
          {form.moodRating === null ? <p className="mt-1 text-xs text-slate-500">{t.slide}</p> : null}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{t.exam}</h3>
        {!readOnly ? (
          <Button type="button" size="sm" variant="outline" onClick={() => patch({ mse: applyNormalMse(form.mse) })} title={t.normalTitle}>
            {t.normal}
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {MSE_DOMAIN_KEYS.map((key) => {
          const entry = form.mse[key] ?? { values: [], note: '' }
          const noteOpen = openNotes[key] || entry.note !== ''
          return (
            <section key={key} className="rounded-xl border border-slate-200 bg-white p-3">
              <h4 className="mb-2 text-sm font-medium text-slate-800">{name(key)}</h4>
              <ChipGroup ariaLabel={name(key)} labelOf={labelOf} options={MSE_DOMAINS[key]} value={entry.values} onChange={(values) => setDomain(key, { values })} disabled={readOnly} />
              {noteOpen ? (
                <Textarea
                  rows={2}
                  className="mt-2"
                  disabled={readOnly}
                  maxLength={1000}
                  placeholder={t.notePh}
                  value={entry.note}
                  onChange={(e) => setDomain(key, { note: e.target.value })}
                  aria-label={`${name(key)} ${t.note}`}
                />
              ) : !readOnly ? (
                <button type="button" className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => setOpenNotes((o) => ({ ...o, [key]: true }))}>
                  {t.addNote}
                </button>
              ) : null}
            </section>
          )
        })}
      </div>
    </div>
  )
}

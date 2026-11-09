import { ExternalLink, ImagePlus, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { PageSpinner } from '../../components/ui/spinner'
import { Textarea } from '../../components/ui/textarea'
import { ApiError, type PageDay, type PageMode, type PageSlot, type PublicPageInput, type PublicPageState, api } from '../../lib/api'
import { DAYS, DAY_LABEL, DEFAULT_ACKS, LIMITS, MODES, MODE_LABEL, NO_INSURANCE_ACK, SLOTS, SLOT_LABEL, slugOk } from '../../lib/public-page'
import { useTenant } from '../../state/location'

const MAX_BANNER = 700 * 1024

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })

function toInput(s: PublicPageState): PublicPageInput {
  const { bannerVersion: _b, ...rest } = s.page
  return { ...rest, slug: s.slug }
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}

function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-800">
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

const move = <T,>(list: T[], i: number, by: -1 | 1): T[] => {
  const j = i + by
  if (j < 0 || j >= list.length) return list
  const next = [...list]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  return next
}
const toggle = <T,>(list: readonly T[], v: T, on: boolean): T[] => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v))

/** What the server said, in words for the practice. */
function problem(e: unknown): string {
  if (e instanceof ApiError) {
    const b = (e.body ?? {}) as { error?: string; missing?: string[] }
    if (b.error === 'incomplete') return `To publish the page, fill in: ${(b.missing ?? []).map((m) => (m === 'slug' ? 'the address' : 'the headline')).join(' and ')}.`
    if (b.error === 'slug_taken') return 'That address is already used by another page. Choose a different one.'
    if (b.error === 'slug_reserved') return 'That address is reserved. Choose a different one.'
    if (e.status === 400) return 'Something is too long or not valid. Check the fields and try again.'
  }
  return 'Could not save the page. Try again.'
}

/** Settings → Public page: the practice's own page (answers people would otherwise ask by phone) and its request form. */
export function PublicPageSettingsPage() {
  const { current } = useTenant()
  const loc = current?.id
  const [state, setState] = useState<PublicPageState | null>(null)
  const [form, setForm] = useState<PublicPageInput | null>(null)
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!loc) return
    let live = true
    api.publicPage.get(loc).then((s) => {
      if (!live) return
      setState(s)
      const f = toInput(s)
      setForm(f)
      setBase(JSON.stringify(f))
      setBanner(s.bannerUrl)
    }).catch(() => live && setError('Could not load the page settings.'))
    return () => { live = false }
  }, [loc])

  const dirty = useMemo(() => (form ? JSON.stringify(form) !== base : false), [form, base])
  if (!loc || !state || !form) return error ? <p role="alert" className="p-6 text-sm text-rose-700">{error}</p> : <PageSpinner label="Loading the public page" />

  const set = (p: Partial<PublicPageInput>) => { setForm((f) => (f ? { ...f, ...p } : f)); setNote(null) }
  const setFormOpt = (p: Partial<PublicPageInput['form']>) => set({ form: { ...form.form, ...p } })
  const insurance = form.insurance
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  async function save() {
    if (!form || busy) return
    // A row left half-written would be dropped by the server; say so instead of losing it quietly.
    const services = form.services.map((s) => ({ title: s.title.trim(), text: s.text.trim() })).filter((s) => s.title || s.text)
    const faq = form.faq.map((f) => ({ q: f.q.trim(), a: f.a.trim() })).filter((f) => f.q || f.a)
    if (services.some((s) => !s.title)) return setError('Every service needs a title.')
    if (faq.some((f) => !f.q || !f.a)) return setError('Every question needs its answer (or remove the question).')
    const payload: PublicPageInput = {
      ...form,
      slug: form.slug && form.slug.trim() ? form.slug.trim().toLowerCase() : null,
      services,
      faq,
      insurance: { ...form.insurance, plans: form.insurance.plans.map((p) => p.trim()).filter(Boolean) },
      form: { ...form.form, acknowledgements: form.form.acknowledgements.map((a) => a.trim()).filter(Boolean) },
    }
    if (payload.slug && !slugOk(payload.slug)) return setError('The address uses only lowercase letters, numbers and dashes (3 to 40 characters).')
    setBusy(true)
    setError(null)
    try {
      const r = await api.publicPage.save(loc!, payload)
      const next = { ...state!, page: r.page, slug: r.slug, url: r.url }
      setState(next)
      const f = toInput(next)
      setForm(f)
      setBase(JSON.stringify(f))
      setNote(r.page.enabled ? 'Saved. The page is public.' : 'Saved. The page is not public yet.')
    } catch (e) {
      setError(problem(e))
    } finally {
      setBusy(false)
    }
  }

  async function pickBanner(f: File | undefined) {
    if (!f || !loc) return
    setError(null)
    if (f.size > MAX_BANNER) return setError('The picture is too large. Use one under 700 KB.')
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return setError('Use a PNG, JPEG or WebP picture.')
    setBusy(true)
    try {
      const url = await readAsDataUrl(f)
      const r = await api.publicPage.putBanner(loc, url)
      setBanner(url)
      setState((s) => (s ? { ...s, page: r.page } : s))
      setNote('Banner updated.')
    } catch {
      setError('Could not upload the picture. Check that it is a real image.')
    } finally {
      setBusy(false)
    }
  }

  async function dropBanner() {
    if (!loc) return
    setBusy(true)
    try {
      const r = await api.publicPage.removeBanner(loc)
      setBanner(null)
      setState((s) => (s ? { ...s, page: r.page } : s))
    } catch {
      setError('Could not remove the picture.')
    } finally {
      setBusy(false)
    }
  }

  const copy = () => state.url && void navigator.clipboard?.writeText(state.url).then(() => setNote('Link copied.')).catch(() => {})
  const unusedSuggestions = state.suggestedQuestions.filter((q) => !form.faq.some((f) => f.q === q))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-slate-900">Public page</h1>
          <p className="text-xs text-slate-500">A page for people to learn how you work and ask for information or an appointment, so you do not have to answer the same calls.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {error ? <span role="alert" className="max-w-xs text-xs font-medium text-rose-600">{error}</span> : note ? <span role="status" className="text-xs font-medium text-emerald-700">{note}</span> : null}
          <a href={api.publicPage.previewUrl(loc)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
            Preview <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
          <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </header>

      <div className="ol-scroll min-h-0 flex-1 overflow-y-auto bg-slate-50 px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-4">
          <Section title="Publish" hint="The page does not exist for anyone until you turn it on. Preview shows the saved version.">
            <Check checked={form.enabled} onChange={(v) => set({ enabled: v })}>The page is public</Check>
            <div>
              <Label htmlFor="pp-slug">Address</Label>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="text-sm text-slate-500">{origin}/p/</span>
                <Input id="pp-slug" className="max-w-[16rem] font-mono" value={form.slug ?? ''} maxLength={40} placeholder={state.suggestedSlug || 'your-practice'} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
                {!form.slug && state.suggestedSlug ? <Button type="button" variant="ghost" size="sm" onClick={() => set({ slug: state.suggestedSlug })}>Use “{state.suggestedSlug}”</Button> : null}
              </div>
              <p className="mt-1 text-xs text-slate-500">Changing it later breaks links you already shared.</p>
              {state.url && state.page.enabled ? (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <a className="break-all text-brand-700 underline" href={state.url} target="_blank" rel="noreferrer">{state.url}</a>
                  <Button type="button" size="sm" variant="outline" onClick={copy}>Copy link</Button>
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="pp-headline">Headline</Label>
              <Input id="pp-headline" className="mt-1.5" value={form.headline} maxLength={LIMITS.headline} placeholder="Therapy in San Juan, in person and online" onChange={(e) => set({ headline: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="pp-sub">Subtitle</Label>
              <Input id="pp-sub" className="mt-1.5" value={form.subheadline} maxLength={LIMITS.subheadline} placeholder="A calm space to be heard" onChange={(e) => set({ subheadline: e.target.value })} />
            </div>
            <div>
              <Label>Banner picture (optional)</Label>
              <div className="mt-1.5 flex items-center gap-4">
                <div className="flex h-20 w-36 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                  {banner ? <img src={banner} alt="Current banner" className="h-full w-full object-cover" /> : <ImagePlus className="h-6 w-6 text-slate-300" aria-hidden />}
                </div>
                <div className="space-y-1">
                  <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload banner" onChange={(e) => { void pickBanner(e.target.files?.[0]); e.target.value = '' }} />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => file.current?.click()}>{banner ? 'Change' : 'Upload'}</Button>
                    {banner ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void dropBanner()}><Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />Remove</Button> : null}
                  </div>
                  <p className="text-xs text-slate-500">Wide picture, under 700 KB. Without one, the page uses your brand colour.</p>
                </div>
              </div>
            </div>
          </Section>

          <Section title="About and services">
            <div>
              <Label htmlFor="pp-about">About the practice</Label>
              <Textarea id="pp-about" className="mt-1.5" rows={4} value={form.about} maxLength={LIMITS.about} onChange={(e) => set({ about: e.target.value })} />
            </div>
            <div className="space-y-3">
              <Label>Services</Label>
              {form.services.map((s, i) => (
                <div key={i} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex gap-2">
                    <Input aria-label={`Service ${i + 1} title`} value={s.title} maxLength={LIMITS.serviceTitle} placeholder="Individual therapy" onChange={(e) => set({ services: form.services.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                    <Button type="button" size="sm" variant="ghost" aria-label={`Remove service ${i + 1}`} onClick={() => set({ services: form.services.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                  </div>
                  <Textarea aria-label={`Service ${i + 1} description`} className="mt-2" rows={2} value={s.text} maxLength={LIMITS.serviceText} placeholder="50-minute sessions…" onChange={(e) => set({ services: form.services.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                </div>
              ))}
              {form.services.length < LIMITS.services ? <Button type="button" size="sm" variant="outline" onClick={() => set({ services: [...form.services, { title: '', text: '' }] })}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden />Add a service</Button> : null}
            </div>
          </Section>

          <Section title="Fees and insurance" hint="This is what people usually call to ask.">
            <Check checked={form.showFees} onChange={(v) => set({ showFees: v })}>Show my fees on the page</Check>
            <p className="-mt-2 text-xs text-slate-500">
              Fees come from Settings → Practice: intake {state.fees.intake || '(empty)'} · session {state.fees.session || '(empty)'} · late cancellation {state.fees.late_cancel || '(empty)'}. A fee left empty is not shown.
            </p>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-slate-800">Do you accept insurance plans?</legend>
              <label className="mr-5 inline-flex items-center gap-2 text-sm"><input type="radio" name="pp-ins" checked={!insurance.accepted} onChange={() => set({ insurance: { ...insurance, accepted: false } })} /> No</label>
              <label className="inline-flex items-center gap-2 text-sm"><input type="radio" name="pp-ins" checked={insurance.accepted} onChange={() => set({ insurance: { ...insurance, accepted: true } })} /> Yes</label>
            </fieldset>
            {insurance.accepted ? (
              <div>
                <Label htmlFor="pp-plans">Plans you accept (one per line)</Label>
                <Textarea id="pp-plans" className="mt-1.5" rows={4} value={insurance.plans.join('\n')} placeholder={'Triple-S\nMCS'} onChange={(e) => set({ insurance: { ...insurance, plans: e.target.value.split('\n').slice(0, LIMITS.plans) } })} />
              </div>
            ) : (
              <p className="text-xs text-slate-500">The page will say plainly that insurance is not accepted, and the form will ask people to confirm they understand.</p>
            )}
            <div>
              <Label htmlFor="pp-ins-note">Note about payment or reimbursement (optional)</Label>
              <Textarea id="pp-ins-note" className="mt-1.5" rows={2} value={insurance.note} maxLength={LIMITS.insuranceNote} placeholder="We give a receipt you can send to your plan for reimbursement." onChange={(e) => set({ insurance: { ...insurance, note: e.target.value } })} />
            </div>
          </Section>

          <Section title="Frequently asked questions" hint="Answer here what you would otherwise answer by phone. Nothing is published that you did not write.">
            {form.faq.map((f, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3">
                <div className="flex gap-2">
                  <Input aria-label={`Question ${i + 1}`} value={f.q} maxLength={LIMITS.question} placeholder="Do you accept insurance?" onChange={(e) => set({ faq: form.faq.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)) })} />
                  <Button type="button" size="sm" variant="ghost" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => set({ faq: move(form.faq, i, -1) })}>↑</Button>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Move question ${i + 1} down`} disabled={i === form.faq.length - 1} onClick={() => set({ faq: move(form.faq, i, 1) })}>↓</Button>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Remove question ${i + 1}`} onClick={() => set({ faq: form.faq.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                </div>
                <Textarea aria-label={`Answer ${i + 1}`} className="mt-2" rows={3} value={f.a} maxLength={LIMITS.answer} onChange={(e) => set({ faq: form.faq.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)) })} />
              </div>
            ))}
            {form.faq.length < LIMITS.faq ? <Button type="button" size="sm" variant="outline" onClick={() => set({ faq: [...form.faq, { q: '', a: '' }] })}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden />Add a question</Button> : null}
            {unusedSuggestions.length > 0 && form.faq.length < LIMITS.faq ? (
              <div>
                <p className="mb-1 text-xs text-slate-500">Common questions (click to add, then write the answer):</p>
                <div className="flex flex-wrap gap-2">
                  {unusedSuggestions.map((q) => <button key={q} type="button" className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 hover:bg-slate-200" onClick={() => set({ faq: [...form.faq, { q, a: '' }] })}>+ {q}</button>)}
                </div>
              </div>
            ) : null}
          </Section>

          <Section title="Hours and location">
            <div>
              <Label htmlFor="pp-hours">Hours</Label>
              <Textarea id="pp-hours" className="mt-1.5" rows={2} value={form.hours} maxLength={LIMITS.hours} placeholder="Monday and Tuesday, mornings and afternoons" onChange={(e) => set({ hours: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="pp-loc">Where</Label>
              <Textarea id="pp-loc" className="mt-1.5" rows={2} value={form.location} maxLength={LIMITS.location} placeholder="Office in San Juan. Virtual sessions by video call." onChange={(e) => set({ location: e.target.value })} />
            </div>
          </Section>

          <Section title="The request form" hint="People choose from these options, so you only get requests for times you can offer. The form never asks for clinical details.">
            <div>
              <Label htmlFor="pp-intro">Short text above the form (optional)</Label>
              <Input id="pp-intro" className="mt-1.5" value={form.form.intro} maxLength={LIMITS.intro} onChange={(e) => setFormOpt({ intro: e.target.value })} />
            </div>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-slate-800">Modalities offered</legend>
              <div className="flex flex-wrap gap-4">
                {MODES.map((m: PageMode) => <Check key={m} checked={form.form.modes.includes(m)} onChange={(v) => { const modes = toggle(form.form.modes, m, v); if (modes.length) setFormOpt({ modes: MODES.filter((x) => modes.includes(x)) }) }}>{MODE_LABEL[m]}</Check>)}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-slate-800">Days people can pick</legend>
              <div className="flex flex-wrap gap-4">
                {DAYS.map((d: PageDay) => <Check key={d} checked={form.form.days.includes(d)} onChange={(v) => { const days = toggle(form.form.days, d, v); if (days.length) setFormOpt({ days: DAYS.filter((x) => days.includes(x)) }) }}>{DAY_LABEL[d]}</Check>)}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-slate-800">Times of day</legend>
              <div className="flex flex-wrap gap-4">
                {SLOTS.map((s: PageSlot) => <Check key={s} checked={form.form.slots.includes(s)} onChange={(v) => { const slots = toggle(form.form.slots, s, v); if (slots.length) setFormOpt({ slots: SLOTS.filter((x) => slots.includes(x)) }) }}>{SLOT_LABEL[s]}</Check>)}
              </div>
              <p className="mt-1 text-xs text-slate-500">Virtual sessions use the same days and times for now.</p>
            </fieldset>
            {insurance.accepted ? <Check checked={form.form.askInsurance} onChange={(v) => setFormOpt({ askInsurance: v })}>Ask which insurance plan the person has</Check> : null}
            <div className="space-y-2">
              <Label>Statements people must tick before sending</Label>
              <p className="text-xs text-slate-500">So nobody asks without having read what the page answers. What they ticked is saved with their request.</p>
              {form.form.acknowledgements.map((a, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label={`Statement ${i + 1}`} value={a} maxLength={LIMITS.ack} onChange={(e) => setFormOpt({ acknowledgements: form.form.acknowledgements.map((x, j) => (j === i ? e.target.value : x)) })} />
                  <Button type="button" size="sm" variant="ghost" aria-label={`Remove statement ${i + 1}`} onClick={() => setFormOpt({ acknowledgements: form.form.acknowledgements.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" aria-hidden /></Button>
                </div>
              ))}
              {!insurance.accepted ? <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">Added automatically: “{NO_INSURANCE_ACK}”</p> : null}
              <div className="flex flex-wrap gap-2">
                {form.form.acknowledgements.length < LIMITS.acks ? <Button type="button" size="sm" variant="outline" onClick={() => setFormOpt({ acknowledgements: [...form.form.acknowledgements, ''] })}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden />Add a statement</Button> : null}
                <Button type="button" size="sm" variant="ghost" onClick={() => setFormOpt({ acknowledgements: [...DEFAULT_ACKS] })}>Use the suggested ones</Button>
              </div>
            </div>
          </Section>

          <Section title="Also show">
            <Check checked={form.showTherapist} onChange={(v) => set({ showTherapist: v })}>My name and licence number (from Settings → Practice)</Check>
            <Check checked={form.showCrisis} onChange={(v) => set({ showCrisis: v })}>The crisis and emergency numbers (988, 1-800-981-0023, 911) — recommended</Check>
          </Section>
        </div>
      </div>
    </div>
  )
}

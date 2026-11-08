import { CheckCircle2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { PageSpinner } from '../../components/ui/spinner'
import { type PracticeProfile, api } from '../../lib/api'
import { useTenant } from '../../state/location'

/** Practice profile: feeds the letterhead on printed session notes and the merge
 *  fields in client documents (practice name, license, fees, cancellation policy). */
export function PracticeSettingsPage() {
  const { current } = useTenant()
  const loc = current?.id

  const [base, setBase] = useState<PracticeProfile | null>(null)
  const [form, setForm] = useState<PracticeProfile | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!loc) return
    let active = true
    setBase(null)
    setForm(null)
    setError(null)
    setSaved(false)
    api
      .practice(loc)
      .then((r) => {
        if (!active) return
        setBase(r.practice)
        setForm(r.practice)
      })
      .catch(() => active && setError('Could not load the practice profile.'))
    return () => {
      active = false
    }
  }, [loc])

  const dirty = useMemo(() => (base && form ? JSON.stringify(base) !== JSON.stringify(form) : false), [base, form])

  function patch(p: Partial<PracticeProfile>) {
    setForm((f) => (f ? { ...f, ...p } : f))
    setSaved(false)
  }
  const patchFees = (p: Partial<PracticeProfile['fees']>) => form && patch({ fees: { ...form.fees, ...p } })

  async function save() {
    if (!loc || !form || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.savePractice(loc, form)
      setBase(r.practice)
      setForm(r.practice)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not save the practice profile.')
    } finally {
      setBusy(false)
    }
  }

  if (!loc || (!form && !error)) return <PageSpinner label="Loading practice profile" />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Practice</h1>
          <p className="text-xs text-slate-500">Shown on printed session notes and in documents sent to clients.</p>
        </div>
        <div className="flex items-center gap-3">
          {saved && !dirty ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
              <CheckCircle2 className="h-4 w-4" />
              Saved
            </span>
          ) : null}
          <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </header>

      <div className="ol-scroll min-h-0 flex-1 overflow-y-auto bg-slate-50 px-5 py-5">
        <div className="mx-auto max-w-2xl space-y-4">
          {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
          {form ? (
            <>
              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="mb-3 text-sm font-semibold text-slate-900">Practice details</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="p-name" label="Practice name" value={form.name} max={120} onChange={(v) => patch({ name: v })} />
                  <Field id="p-therapist" label="Therapist (as it should print)" value={form.therapist} max={120} placeholder="Dra. Jane Doe, PsyD" onChange={(v) => patch({ therapist: v })} />
                  <Field id="p-license" label="License number" value={form.license} max={60} onChange={(v) => patch({ license: v })} />
                  <Field id="p-phone" label="Phone" value={form.phone} max={40} onChange={(v) => patch({ phone: v })} />
                  <Field id="p-email" label="Email" value={form.email} max={200} onChange={(v) => patch({ email: v })} />
                  <Field id="p-address" label="Address" value={form.address} max={300} onChange={(v) => patch({ address: v })} />
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="mb-1 text-sm font-semibold text-slate-900">Fees &amp; cancellation policy</h2>
                <p className="mb-3 text-xs text-slate-500">
                  Written into client documents as typed (for example "$100"). Leave blank if you prefer to state them yourself.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="p-fee-session" label="Session fee" value={form.fees.session} max={40} onChange={(v) => patchFees({ session: v })} />
                  <Field id="p-fee-intake" label="Intake session fee" value={form.fees.intake} max={40} onChange={(v) => patchFees({ intake: v })} />
                  <Field id="p-fee-late" label="Late cancellation / no-show fee" value={form.fees.late_cancel} max={40} onChange={(v) => patchFees({ late_cancel: v })} />
                  <Field
                    id="p-cancel-hours"
                    label="Notice required to cancel (hours)"
                    value={form.policy.cancel_hours}
                    max={3}
                    onChange={(v) => patch({ policy: { cancel_hours: v.replace(/\D/g, '') } })}
                  />
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Field(props: { id: string; label: string; value: string; max: number; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        className="mt-1.5"
        value={props.value}
        maxLength={props.max}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  )
}

import { Receipt } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { PageSpinner } from '../../components/ui/spinner'
import { ApiError, type BillingMeta, type BillingProfile, api } from '../../lib/api'
import { billingMessage, centsToInput, dollarsToCents } from '../../lib/billing'
import { useTenant } from '../../state/location'

/** Settings → Billing: what a superbill needs about the provider. The tax ID is write-only: it is never shown again. */
export function BillingSettingsPage() {
  const { current } = useTenant()
  const loc = current?.id

  const [profile, setProfile] = useState<BillingProfile | null>(null)
  const [meta, setMeta] = useState<BillingMeta | null>(null)
  const [npi, setNpi] = useState('')
  const [taxonomy, setTaxonomy] = useState('')
  const [pos, setPos] = useState<'10' | '02'>('10')
  const [fees, setFees] = useState<Record<string, string>>({})
  const [newTaxId, setNewTaxId] = useState('')
  const [removeTaxId, setRemoveTaxId] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  function adopt(p: BillingProfile) {
    setProfile(p)
    setNpi(p.npi)
    setTaxonomy(p.taxonomy)
    setPos(p.telehealthPos)
    setFees(Object.fromEntries(Object.entries(p.fees).map(([k, v]) => [k, centsToInput(v)])))
    setNewTaxId('')
    setRemoveTaxId(false)
  }

  useEffect(() => {
    if (!loc) return
    let live = true
    Promise.all([api.billing.profile(loc), api.billing.meta(loc)])
      .then(([p, m]) => {
        if (!live) return
        adopt(p.profile)
        setMeta(m)
      })
      .catch(() => live && setLoadError(true))
    return () => {
      live = false
    }
  }, [loc])

  if (!loc || !profile || !meta) return loadError ? <p role="alert" className="p-6 text-sm text-rose-700">Could not load billing settings.</p> : <PageSpinner />

  const badFee = Object.values(fees).some((v) => v.trim() !== '' && dollarsToCents(v) === null)

  async function save() {
    if (busy || badFee || !loc) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const feeCents: Record<string, number> = {}
      for (const [code, text] of Object.entries(fees)) {
        const c = text.trim() === '' ? null : dollarsToCents(text)
        if (c !== null) feeCents[code] = c
      }
      const r = await api.billing.saveProfile(loc, {
        npi: npi.trim(),
        taxonomy: taxonomy.trim(),
        telehealthPos: pos,
        fees: feeCents,
        ...(newTaxId.trim() ? { taxId: newTaxId.trim() } : removeTaxId ? { taxId: null } : {}),
      })
      adopt(r.profile)
      setNote('Saved.')
    } catch (e) {
      setError(billingMessage(e instanceof ApiError ? e.message : undefined))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ol-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Receipt className="h-5 w-5 text-slate-400" aria-hidden /> Billing</h1>
        <p className="mt-1 text-sm text-slate-600">What a superbill needs about you. Your name, license, address and phone come from <em>Practice</em>.</p>

        <div className="mt-6 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="b-npi">NPI</Label>
              <Input id="b-npi" inputMode="numeric" maxLength={10} value={npi} placeholder="10 digits" onChange={(e) => setNpi(e.target.value.replace(/\D/g, ''))} />
              <p className="mt-1 text-xs text-slate-500">Required to issue a superbill. The last digit is a check digit, so a typo is caught.</p>
            </div>
            <div>
              <Label htmlFor="b-tax">Taxonomy code <span className="font-normal text-slate-400">(optional)</span></Label>
              <Input id="b-tax" maxLength={10} className="uppercase" value={taxonomy} placeholder="e.g. 103TC0700X" onChange={(e) => setTaxonomy(e.target.value.toUpperCase())} />
            </div>
          </div>

          <div>
            <Label htmlFor="b-taxid">Tax ID (EIN or SSN)</Label>
            {profile.hasTaxId && !removeTaxId ? (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">Saved · {profile.taxIdType === 'ssn' ? 'SSN' : 'EIN'} ending in {profile.taxIdLast4}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRemoveTaxId(true)}>Replace or remove</Button>
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <Input id="b-taxid" type="password" autoComplete="off" className="max-w-xs" value={newTaxId} placeholder="12-3456789 or 123-45-6789" onChange={(e) => setNewTaxId(e.target.value)} />
                {removeTaxId && <Button type="button" variant="ghost" size="sm" onClick={() => { setRemoveTaxId(false); setNewTaxId('') }}>Keep the saved one</Button>}
              </div>
            )}
            <p className="mt-1 text-xs text-slate-500">It is stored encrypted and is never shown again here. It appears in full only on a superbill you open. {removeTaxId && !newTaxId.trim() ? 'Saving now will remove it.' : ''}</p>
          </div>

          <div>
            <Label htmlFor="b-pos">Place of service for telehealth</Label>
            <select id="b-pos" value={pos} onChange={(e) => setPos(e.target.value as '10' | '02')} className="mt-1 block rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              {meta.placesOfService.filter((p) => p.code !== '11').map((p) => <option key={p.code} value={p.code}>{p.code} · {p.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-slate-500">Used when a session was held by video or phone. In-person sessions use 11 (office).</p>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-slate-900">Usual fee per session type</h2>
            <p className="mt-1 text-xs text-slate-500">Filled in for you when a charge is added. Leave one blank to enter the fee each time.</p>
            <ul className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {meta.cpt.map((c) => (
                <li key={c.code} className="flex items-center justify-between gap-3 px-3 py-2">
                  <label htmlFor={`fee-${c.code}`} className="min-w-0 text-sm text-slate-700"><span className="font-mono font-medium">{c.code}</span> <span className="text-slate-500">{c.label}</span></label>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-sm text-slate-400">$</span>
                    <Input id={`fee-${c.code}`} inputMode="decimal" className="w-24 text-right" value={fees[c.code] ?? ''} placeholder="—" onChange={(e) => setFees({ ...fees, [c.code]: e.target.value })} />
                  </div>
                </li>
              ))}
            </ul>
            {badFee && <p role="alert" className="mt-1 text-xs font-medium text-rose-600">Use a plain amount like 110 or 110.50.</p>}
          </div>

          {error && <p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}
          {note && <p role="status" className="text-sm font-medium text-emerald-700">{note}</p>}
          <div className="flex gap-2">
            <Button disabled={busy || badFee} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
            <Button variant="outline" disabled={busy} onClick={() => adopt(profile)}>Discard changes</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

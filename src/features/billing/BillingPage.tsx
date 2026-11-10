import { FilePlus2, Plus, Receipt } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { PageSpinner } from '../../components/ui/spinner'
import { type BillingMeta, type BillingProfile, type ChargeRow, type ChargeSuggestion, type SuperbillSummary, api } from '../../lib/api'
import { MODALITY_LABELS, PAYMENT_LABELS, SESSION_TYPE_LABELS, formatServiceDate } from '../../lib/billing'
import { cn, formatMoneyExact } from '../../lib/utils'
import { useTenant } from '../../state/location'
import { type ChargeDraft, ChargeDialog, IssueDialog, PaymentDialog, ReasonDialog, draftFromCharge, draftFromSuggestion } from './BillingDialogs'

type Tab = 'charges' | 'superbills'
type Status = 'unbilled' | 'billed' | 'void' | 'all'

const todayYmd = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Dialog =
  | { kind: 'charge'; draft: ChargeDraft; editingId?: string }
  | { kind: 'payment'; charge: ChargeRow }
  | { kind: 'void'; charge: ChargeRow }
  | { kind: 'issue'; contactId: string; name: string; charges: ChargeRow[] }
  | null

/** Billing: signed sessions ready to bill, the charges written down for them, and the superbills issued from those charges. */
export function BillingPage() {
  const { current } = useTenant()
  const loc = current?.id
  const navigate = useNavigate()

  const [tab, setTab] = useState<Tab>('charges')
  const [status, setStatus] = useState<Status>('unbilled')
  const [clientFilter, setClientFilter] = useState('')
  const [meta, setMeta] = useState<BillingMeta | null>(null)
  const [profile, setProfile] = useState<BillingProfile | null>(null)
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([])
  const [suggestions, setSuggestions] = useState<ChargeSuggestion[]>([])
  const [charges, setCharges] = useState<ChargeRow[]>([])
  const [superbills, setSuperbills] = useState<SuperbillSummary[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!loc) return
    try {
      const [s, c, sb] = await Promise.all([
        api.billing.suggestions(loc),
        api.billing.charges(loc, { status, ...(clientFilter ? { contactId: clientFilter } : {}) }),
        api.billing.superbills(loc, clientFilter || undefined),
      ])
      setSuggestions(s.suggestions)
      setCharges(c.charges)
      setSuperbills(sb.superbills)
      setSelected((cur) => new Set([...cur].filter((id) => c.charges.some((x) => x.id === id && !x.superbill_id && !x.voided_at))))
      setState('ready')
    } catch {
      setState('error')
    }
  }, [loc, status, clientFilter])

  useEffect(() => {
    if (!loc) return
    let live = true
    Promise.all([api.billing.meta(loc), api.billing.profile(loc), api.contacts(loc)])
      .then(([m, p, c]) => {
        if (!live) return
        setMeta(m)
        setProfile(p.profile)
        setContacts(c.contacts.map((x) => ({ id: x.id, name: x.name ?? x.emails[0] ?? 'Client' })).sort((a, b) => a.name.localeCompare(b.name)))
      })
      .catch(() => live && setState('error'))
    return () => {
      live = false
    }
  }, [loc])

  useEffect(() => {
    void reload()
  }, [reload])

  const picked = useMemo(() => charges.filter((c) => selected.has(c.id)), [charges, selected])
  const pickedClients = new Set(picked.map((c) => c.contact_id))
  const oneClient = picked.length > 0 && pickedClients.size === 1

  if (!loc || state === 'loading' || !meta || !profile) return state === 'error' ? <p role="alert" className="p-6 text-sm text-rose-700">Could not load billing.</p> : <PageSpinner />

  const setupMissing = !profile.npi || !profile.hasTaxId
  const toggle = (id: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const done = () => { setDialog(null); void reload() }

  return (
    <div className="ol-scroll h-full overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Receipt className="h-5 w-5 text-slate-400" aria-hidden /> Billing</h1>
            <p className="mt-0.5 text-sm text-slate-600">Write down what was charged and paid, and make a superbill your clients can send to their insurance. Nothing here charges a card.</p>
          </div>
          <Button onClick={() => setDialog({ kind: 'charge', draft: { contactId: clientFilter, serviceDate: todayYmd(), cptCode: '', modifiers: [], placeOfService: '11', units: 1, diagnosisCodes: [], feeCents: null } })}>
            <Plus className="h-4 w-4" /> Add charge
          </Button>
        </div>

        {setupMissing && (
          <div role="note" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            To issue superbills, add your {!profile.npi ? 'NPI' : ''}{!profile.npi && !profile.hasTaxId ? ' and ' : ''}{!profile.hasTaxId ? 'tax ID' : ''} in <Link className="font-medium underline" to="/settings/billing">Settings → Billing</Link>.
          </div>
        )}
        {error && <p role="alert" className="mt-4 text-sm font-medium text-rose-600">{error}</p>}

        {suggestions.length > 0 && (
          <section aria-labelledby="ready" className="mt-6 rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 id="ready" className="text-sm font-semibold text-slate-900">Ready to bill <span className="font-normal text-slate-500">· {suggestions.length} signed {suggestions.length === 1 ? 'session' : 'sessions'} without a charge</span></h2>
              <p className="text-xs text-slate-500">The service code, place and diagnosis are suggested from the session. Review them before adding.</p>
            </div>
            <ul className="divide-y divide-slate-100">
              {suggestions.filter((s) => !clientFilter || s.contact_id === clientFilter).map((s) => (
                <li key={s.note_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0 text-sm">
                    <span className="font-medium text-slate-900">{s.contact_name ?? 'Client'}</span>
                    <span className="text-slate-500"> · {formatServiceDate(s.service_date)} · {SESSION_TYPE_LABELS[s.session_type] ?? s.session_type}, {MODALITY_LABELS[s.modality] ?? s.modality}{s.duration_min ? `, ${s.duration_min} min` : ''}</span>
                    <div className="text-xs text-slate-500">
                      {s.cpt_code ? <>Suggested <span className="font-mono">{s.cpt_code}</span>{s.fee_cents !== null ? ` · ${formatMoneyExact(s.fee_cents)}` : ' · fee not set'}</> : 'Choose the service code'}
                      {s.diagnosis_codes.length > 0 ? ` · ${s.diagnosis_codes.join(', ')}` : ' · no diagnosis on the note'}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'charge', draft: draftFromSuggestion(s) })}>Review &amp; add</Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
            {(['charges', 'superbills'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1.5 text-sm font-medium', tab === t ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}>
                {t === 'charges' ? 'Charges' : `Superbills${superbills.length ? ` (${superbills.length})` : ''}`}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Client" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
              <option value="">All clients</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {tab === 'charges' && (
              <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Status)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
                <option value="unbilled">Not on a superbill</option>
                <option value="billed">On a superbill</option>
                <option value="void">Voided</option>
                <option value="all">All</option>
              </select>
            )}
          </div>
        </div>

        {tab === 'charges' ? (
          <>
            {picked.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
                <span className="text-sm text-slate-700">{picked.length} selected · {formatMoneyExact(picked.reduce((s, c) => s + c.fee_cents, 0))}{!oneClient ? ' · choose charges for one client at a time' : ''}</span>
                <Button size="sm" disabled={!oneClient} onClick={() => setDialog({ kind: 'issue', contactId: picked[0]!.contact_id, name: picked[0]!.contact_name ?? 'client', charges: picked })}>
                  <FilePlus2 className="h-4 w-4" /> Create superbill
                </Button>
              </div>
            )}
            <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[56rem] text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2"><span className="sr-only">Select</span></th>
                    <th className="px-3 py-2">Date</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Service</th>
                    <th className="px-3 py-2">Diagnosis</th><th className="px-3 py-2 text-right">Fee</th><th className="px-3 py-2 text-right">Paid</th>
                    <th className="px-3 py-2">Status</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {charges.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">No charges here yet.</td></tr>}
                  {charges.map((c) => {
                    const open = !c.superbill_id && !c.voided_at
                    return (
                      <tr key={c.id} className={cn(c.voided_at && 'text-slate-400')}>
                        <td className="px-3 py-2">{open && <input type="checkbox" aria-label={`Select ${c.contact_name ?? 'client'} ${c.service_date}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />}</td>
                        <td className="whitespace-nowrap px-3 py-2">{formatServiceDate(c.service_date)}</td>
                        <td className="px-3 py-2">{c.contact_name ?? '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2"><span className="font-mono">{c.cpt_code}</span>{c.modifiers.length ? <span className="text-slate-500">-{c.modifiers.join('-')}</span> : null}<span className="text-slate-400"> · POS {c.place_of_service}</span></td>
                        <td className="px-3 py-2 text-slate-600">{c.diagnosis_codes.length ? c.diagnosis_codes.join(', ') : <span className="text-amber-700">none</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoneyExact(c.fee_cents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.paid_cents > 0 ? <span title={c.payment_method ? PAYMENT_LABELS[c.payment_method] : undefined}>{formatMoneyExact(c.paid_cents)}</span> : <span className="text-slate-400">—</span>}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {c.voided_at ? <span title={c.void_reason ?? undefined} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">Voided</span>
                            : c.superbill_id ? <Link className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-800 hover:underline" to={`/billing/superbills/${c.superbill_id}`}>{c.superbill_number}</Link>
                            : <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">Not billed</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          {!c.voided_at && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'payment', charge: c })}>Payment</Button>}
                          {open && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'charge', draft: draftFromCharge(c), editingId: c.id })}>Edit</Button>}
                          {open && <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setDialog({ kind: 'void', charge: c })}>Void</Button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2">Number</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Services</th><th className="px-3 py-2 text-right">Billed</th><th className="px-3 py-2 text-right">Paid</th><th className="px-3 py-2">Issued</th><th className="px-3 py-2"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {superbills.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">No superbills yet. Select charges and choose “Create superbill”.</td></tr>}
                {superbills.map((s) => (
                  <tr key={s.id} className={cn(s.voided_at && 'text-slate-400')}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{s.number}{s.voided_at && <span title={s.void_reason ?? undefined} className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-sans text-xs">Voided</span>}</td>
                    <td className="px-3 py-2">{s.contact_name ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2">{s.line_count} · {formatServiceDate(s.period_from)}{s.period_to !== s.period_from ? ` – ${formatServiceDate(s.period_to)}` : ''}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoneyExact(s.total_cents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoneyExact(s.paid_cents)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatServiceDate(String(s.issued_at).slice(0, 10))}</td>
                    <td className="px-3 py-2 text-right"><Link className="font-medium text-brand-700 hover:underline" to={`/billing/superbills/${s.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog?.kind === 'charge' && <ChargeDialog loc={loc} meta={meta} contacts={contacts} draft={dialog.draft} editingId={dialog.editingId} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === 'payment' && <PaymentDialog loc={loc} charge={dialog.charge} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === 'void' && (
        <ReasonDialog
          title="Void this charge?"
          intro="A voided charge stays on the list, marked as voided. It cannot be undone."
          confirm="Void charge"
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await api.billing.voidCharge(loc, dialog.charge.id, reason)
            done()
          }}
        />
      )}
      {dialog?.kind === 'issue' && <IssueDialog loc={loc} clientName={dialog.name} contactId={dialog.contactId} charges={dialog.charges} onClose={() => setDialog(null)} onIssued={(id) => navigate(`/billing/superbills/${id}`)} />}
    </div>
  )
}


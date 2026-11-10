import { FilePlus2, FileText, HandCoins, Plus, Receipt } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { PageSpinner } from '../../components/ui/spinner'
import { type BillingMeta, type BillingProfile, type ChargeRow, type ChargeSuggestion, type InvoiceSummary, type ReceiptSummary, type SuperbillSummary, api } from '../../lib/api'
import { INVOICE_STATUS_LABELS, MODALITY_LABELS, PAYMENT_LABELS, SESSION_TYPE_LABELS, formatServiceDate } from '../../lib/billing'
import { cn, formatMoneyExact } from '../../lib/utils'
import { useTenant } from '../../state/location'
import { type ChargeDraft, ChargeDialog, IssueDialog, ReasonDialog, draftFromCharge, draftFromSuggestion } from './BillingDialogs'
import { InvoiceDialog, RecordPaymentDialog } from './PaymentDialogs'

type Tab = 'charges' | 'invoices' | 'receipts' | 'superbills'
type Status = 'active' | 'unpaid' | 'paid' | 'void' | 'all'

const todayYmd = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Group = { contactId: string; name: string; charges: ChargeRow[] }
type Dialog =
  | { kind: 'charge'; draft: ChargeDraft; editingId?: string }
  | { kind: 'pay'; group: Group }
  | { kind: 'void'; charge: ChargeRow }
  | { kind: 'invoice'; group: Group }
  | { kind: 'superbill'; group: Group }
  | null

const owed = (c: ChargeRow) => c.fee_cents - c.paid_cents

/**
 * Billing: signed sessions ready to bill, and the charges written down for them. A charge leads to three documents: an
 * invoice (what the client owes), a receipt (proof of a payment) and a superbill (for the client's insurance).
 */
export function BillingPage() {
  const { current } = useTenant()
  const loc = current?.id
  const navigate = useNavigate()

  const [tab, setTab] = useState<Tab>('charges')
  const [status, setStatus] = useState<Status>('active')
  const [clientFilter, setClientFilter] = useState('')
  const [meta, setMeta] = useState<BillingMeta | null>(null)
  const [profile, setProfile] = useState<BillingProfile | null>(null)
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([])
  const [suggestions, setSuggestions] = useState<ChargeSuggestion[]>([])
  const [charges, setCharges] = useState<ChargeRow[]>([])
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([])
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([])
  const [superbills, setSuperbills] = useState<SuperbillSummary[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  const reload = useCallback(async () => {
    if (!loc) return
    const who = clientFilter || undefined
    try {
      const [s, c, inv, rec, sb] = await Promise.all([
        api.billing.suggestions(loc),
        api.billing.charges(loc, { status, ...(who ? { contactId: who } : {}) }),
        api.billing.invoices(loc, who),
        api.billing.receipts(loc, who),
        api.billing.superbills(loc, who),
      ])
      setSuggestions(s.suggestions)
      setCharges(c.charges)
      setInvoices(inv.invoices)
      setReceipts(rec.receipts)
      setSuperbills(sb.superbills)
      setSelected((cur) => new Set([...cur].filter((id) => c.charges.some((x) => x.id === id && !x.voided_at))))
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
  const oneClient = picked.length > 0 && new Set(picked.map((c) => c.contact_id)).size === 1
  const group: Group | null = oneClient ? { contactId: picked[0]!.contact_id, name: picked[0]!.contact_name ?? 'client', charges: picked } : null
  // What each of the three actions can do for the selection, and why not when it cannot.
  const canPay = Boolean(group) && picked.some((c) => owed(c) > 0)
  const canInvoice = Boolean(group) && picked.every((c) => !c.invoice_id)
  const canSuperbill = Boolean(group) && picked.every((c) => !c.superbill_id)

  if (!loc || state === 'loading' || !meta || !profile) return state === 'error' ? <p role="alert" className="p-6 text-sm text-rose-700">Could not load billing.</p> : <PageSpinner />

  const setupMissing = !profile.npi || !profile.hasTaxId
  const toggle = (id: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const done = () => { setDialog(null); void reload() }
  const today = todayYmd()
  const tabLabel: Record<Tab, string> = {
    charges: 'Charges',
    invoices: `Invoices${invoices.length ? ` (${invoices.length})` : ''}`,
    receipts: `Receipts${receipts.length ? ` (${receipts.length})` : ''}`,
    superbills: `Superbills${superbills.length ? ` (${superbills.length})` : ''}`,
  }

  return (
    <div className="ol-scroll h-full overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Receipt className="h-5 w-5 text-slate-400" aria-hidden /> Billing</h1>
            <p className="mt-0.5 text-sm text-slate-600">Write down what was charged and paid. From a charge you can make an invoice, record a payment and its receipt, and make a superbill for the client’s insurance. Nothing here charges a card.</p>
          </div>
          <Button onClick={() => setDialog({ kind: 'charge', draft: { contactId: clientFilter, serviceDate: today, cptCode: '', modifiers: [], placeOfService: '11', units: 1, diagnosisCodes: [], feeCents: null } })}>
            <Plus className="h-4 w-4" /> Add charge
          </Button>
        </div>

        {setupMissing && (
          <div role="note" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            To issue superbills, add your {!profile.npi ? 'NPI' : ''}{!profile.npi && !profile.hasTaxId ? ' and ' : ''}{!profile.hasTaxId ? 'tax ID' : ''} in <Link className="font-medium underline" to="/settings/billing">Settings → Billing</Link>. Invoices and receipts do not need them.
          </div>
        )}

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
          <div role="tablist" className="inline-flex flex-wrap rounded-lg border border-slate-200 bg-white p-1">
            {(['charges', 'invoices', 'receipts', 'superbills'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1.5 text-sm font-medium', tab === t ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}>
                {tabLabel[t]}
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
                <option value="active">All active</option>
                <option value="unpaid">With a balance</option>
                <option value="paid">Paid in full</option>
                <option value="void">Voided</option>
                <option value="all">Everything</option>
              </select>
            )}
          </div>
        </div>

        {tab === 'charges' && (
          <>
            {picked.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm text-slate-700">{picked.length} selected · {formatMoneyExact(picked.reduce((s, c) => s + c.fee_cents, 0))}{!oneClient ? ' · choose charges for one client at a time' : ''}</span>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={!canPay} onClick={() => group && setDialog({ kind: 'pay', group })}><HandCoins className="h-4 w-4" /> Record payment</Button>
                    <Button size="sm" variant="outline" disabled={!canInvoice} onClick={() => group && setDialog({ kind: 'invoice', group })}><FileText className="h-4 w-4" /> Create invoice</Button>
                    <Button size="sm" disabled={!canSuperbill} onClick={() => group && setDialog({ kind: 'superbill', group })}><FilePlus2 className="h-4 w-4" /> Create superbill</Button>
                  </div>
                </div>
                {oneClient && (!canPay || !canInvoice || !canSuperbill) && (
                  <p className="mt-1.5 text-xs text-slate-500">
                    {!canPay && 'Everything selected is paid. '}{!canInvoice && 'One of these is already on an invoice. '}{!canSuperbill && 'One of these is already on a superbill. '}
                  </p>
                )}
              </div>
            )}
            <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[64rem] text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2"><span className="sr-only">Select</span></th>
                    <th className="px-3 py-2">Date</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Service</th>
                    <th className="px-3 py-2">Diagnosis</th><th className="px-3 py-2 text-right">Fee</th><th className="px-3 py-2 text-right">Paid</th>
                    <th className="px-3 py-2">Status</th><th className="px-3 py-2">Documents</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {charges.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-500">No charges here yet.</td></tr>}
                  {charges.map((c) => {
                    const free = !c.superbill_id && !c.invoice_id && !c.voided_at
                    return (
                      <tr key={c.id} className={cn(c.voided_at && 'text-slate-400')}>
                        <td className="px-3 py-2">{!c.voided_at && <input type="checkbox" aria-label={`Select ${c.contact_name ?? 'client'} ${c.service_date}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />}</td>
                        <td className="whitespace-nowrap px-3 py-2">{formatServiceDate(c.service_date)}</td>
                        <td className="px-3 py-2">{c.contact_name ?? '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2"><span className="font-mono">{c.cpt_code}</span>{c.modifiers.length ? <span className="text-slate-500">-{c.modifiers.join('-')}</span> : null}<span className="text-slate-400"> · POS {c.place_of_service}</span></td>
                        <td className="px-3 py-2 text-slate-600">{c.diagnosis_codes.length ? c.diagnosis_codes.join(', ') : <span className="text-amber-700">none</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoneyExact(c.fee_cents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.paid_cents > 0 ? <span title={c.payment_method ? PAYMENT_LABELS[c.payment_method] : undefined}>{formatMoneyExact(c.paid_cents)}</span> : <span className="text-slate-400">—</span>}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {c.voided_at ? <span title={c.void_reason ?? undefined} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">Voided</span>
                            : c.paid_cents >= c.fee_cents ? <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-800">Paid</span>
                            : c.paid_cents > 0 ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">Partial</span>
                            : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">Unpaid</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <span className="inline-flex flex-wrap gap-1">
                            {c.invoice_id && <Link className="rounded bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-800 hover:underline" to={`/billing/invoices/${c.invoice_id}`}>{c.invoice_number}</Link>}
                            {c.superbill_id && <Link className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-800 hover:underline" to={`/billing/superbills/${c.superbill_id}`}>{c.superbill_number}</Link>}
                            {!c.invoice_id && !c.superbill_id && <span className="text-slate-400">—</span>}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          {!c.voided_at && owed(c) > 0 && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'pay', group: { contactId: c.contact_id, name: c.contact_name ?? 'client', charges: [c] } })}>Payment</Button>}
                          {free && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'charge', draft: draftFromCharge(c), editingId: c.id })}>Edit</Button>}
                          {free && c.paid_cents === 0 && <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setDialog({ kind: 'void', charge: c })}>Void</Button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'invoices' && (
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2">Number</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Services</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Balance</th><th className="px-3 py-2">Due</th><th className="px-3 py-2">Status</th><th className="px-3 py-2"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoices.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500">No invoices yet. Select charges and choose “Create invoice”.</td></tr>}
                {invoices.map((i) => {
                  const overdue = i.status === 'open' && i.due_on !== null && i.due_on < today
                  return (
                    <tr key={i.id} className={cn(i.status === 'void' && 'text-slate-400')}>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{i.number}</td>
                      <td className="px-3 py-2">{i.contact_name ?? '—'}</td>
                      <td className="px-3 py-2">{i.line_count}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoneyExact(i.total_cents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoneyExact(i.balance_cents)}</td>
                      <td className={cn('whitespace-nowrap px-3 py-2', overdue && 'font-medium text-rose-700')}>{i.due_on ? formatServiceDate(i.due_on) : '—'}{overdue && ' · overdue'}</td>
                      <td className="whitespace-nowrap px-3 py-2"><span title={i.void_reason ?? undefined} className={cn('rounded px-1.5 py-0.5 text-xs font-medium', i.status === 'paid' ? 'bg-emerald-50 text-emerald-800' : i.status === 'void' ? 'bg-slate-100' : 'bg-amber-50 text-amber-800')}>{INVOICE_STATUS_LABELS[i.status]}</span></td>
                      <td className="px-3 py-2 text-right"><Link className="font-medium text-brand-700 hover:underline" to={`/billing/invoices/${i.id}`}>Open</Link></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'receipts' && (
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2">Number</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Paid on</th><th className="px-3 py-2">Method</th><th className="px-3 py-2">Services</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {receipts.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">No receipts yet. Recording a payment issues one.</td></tr>}
                {receipts.map((r) => (
                  <tr key={r.id} className={cn(r.voided_at && 'text-slate-400')}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{r.number}{r.voided_at && <span title={r.void_reason ?? undefined} className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-sans text-xs">Voided</span>}</td>
                    <td className="px-3 py-2">{r.contact_name ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatServiceDate(r.paid_on)}</td>
                    <td className="px-3 py-2">{PAYMENT_LABELS[r.method] ?? r.method}</td>
                    <td className="px-3 py-2">{r.line_count}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoneyExact(r.total_cents)}</td>
                    <td className="px-3 py-2 text-right"><Link className="font-medium text-brand-700 hover:underline" to={`/billing/receipts/${r.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'superbills' && (
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
      {dialog?.kind === 'pay' && <RecordPaymentDialog loc={loc} contactId={dialog.group.contactId} clientName={dialog.group.name} charges={dialog.group.charges} onClose={() => setDialog(null)} onRecorded={(id) => navigate(`/billing/receipts/${id}`)} />}
      {dialog?.kind === 'invoice' && <InvoiceDialog loc={loc} clientName={dialog.group.name} contactId={dialog.group.contactId} charges={dialog.group.charges} onClose={() => setDialog(null)} onIssued={(id) => navigate(`/billing/invoices/${id}`)} />}
      {dialog?.kind === 'superbill' && <IssueDialog loc={loc} clientName={dialog.group.name} contactId={dialog.group.contactId} charges={dialog.group.charges} onClose={() => setDialog(null)} onIssued={(id) => navigate(`/billing/superbills/${id}`)} />}
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
    </div>
  )
}

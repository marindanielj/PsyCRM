import { FileText, HandCoins, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import {
  type BillingMeta, type ChargeRow, type ChargeSuggestion, type InvoiceSummary, type ReceiptSummary, type SuperbillSummary, api,
} from '../../lib/api'
import { INVOICE_STATUS_LABELS, formatServiceDate, paymentState, serviceLabel } from '../../lib/billing'
import { cn, formatMoneyExact } from '../../lib/utils'
import { type ChargeDraft, ChargeDialog, draftFromSuggestion } from './BillingDialogs'
import { InvoiceDialog, RecordPaymentDialog } from './PaymentDialogs'

const STATE_STYLE = {
  paid: ['Paid', 'bg-emerald-50 text-emerald-700'],
  partial: ['Partial', 'bg-amber-50 text-amber-800'],
  unpaid: ['Unpaid', 'bg-slate-100 text-slate-600'],
} as const

type Dialog =
  | { kind: 'charge'; draft: ChargeDraft }
  | { kind: 'pay'; charge: ChargeRow }
  | { kind: 'invoice'; charge: ChargeRow }
  | null

const todayYmd = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * A client's billing, kept simple: their charges (generic service name, fee and payment state, never a code or a diagnosis),
 * a payment or invoice from a row, and their documents. Everything else (several charges at once, superbills, filters)
 * lives in the general Billing page, one link away.
 */
export function ContactBilling({ locationId, contactId, contactName, onChanged }: {
  locationId: string
  contactId: string
  contactName: string
  /** Called after anything changes, so the balance chip in the header can refresh. */
  onChanged?: () => void
}) {
  const navigate = useNavigate()
  const [meta, setMeta] = useState<BillingMeta | null>(null)
  const [charges, setCharges] = useState<ChargeRow[]>([])
  const [suggestions, setSuggestions] = useState<ChargeSuggestion[]>([])
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([])
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([])
  const [superbills, setSuperbills] = useState<SuperbillSummary[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [dialog, setDialog] = useState<Dialog>(null)

  const reload = useCallback(async () => {
    try {
      const [c, s, inv, rec, sb] = await Promise.all([
        api.billing.charges(locationId, { status: 'active', contactId }),
        api.billing.suggestions(locationId, contactId),
        api.billing.invoices(locationId, contactId),
        api.billing.receipts(locationId, contactId),
        api.billing.superbills(locationId, contactId),
      ])
      setCharges(c.charges)
      setSuggestions(s.suggestions)
      setInvoices(inv.invoices)
      setReceipts(rec.receipts)
      setSuperbills(sb.superbills)
      setState('ready')
    } catch {
      setState('error')
    }
  }, [locationId, contactId])

  useEffect(() => {
    void reload()
  }, [reload])

  // The charge form needs the code lists; load them only when it is first opened.
  async function openCharge(draft: ChargeDraft) {
    if (!meta) setMeta(await api.billing.meta(locationId))
    setDialog({ kind: 'charge', draft })
  }

  function changed() {
    setDialog(null)
    void reload()
    onChanged?.()
  }

  const docs = [
    ...invoices.map((d) => ({ key: `i${d.id}`, to: `/billing/invoices/${d.id}`, number: d.number, date: d.issued_at, note: d.voided_at ? 'Voided' : INVOICE_STATUS_LABELS[d.status] ?? d.status })),
    ...receipts.map((d) => ({ key: `r${d.id}`, to: `/billing/receipts/${d.id}`, number: d.number, date: d.issued_at, note: d.voided_at ? 'Voided' : formatMoneyExact(d.total_cents) })),
    ...superbills.map((d) => ({ key: `s${d.id}`, to: `/billing/superbills/${d.id}`, number: d.number, date: d.issued_at, note: d.voided_at ? 'Voided' : 'Superbill' })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8)

  return (
    <section aria-labelledby="contact-billing">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id="contact-billing" className="text-sm font-semibold text-slate-900">Billing</h3>
        <div className="flex items-center gap-2">
          <Link to={`/billing?client=${encodeURIComponent(contactId)}`} className="text-xs text-brand-700 underline">Open in Billing</Link>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void openCharge({ contactId, serviceDate: todayYmd(), cptCode: '', modifiers: [], placeOfService: '11', units: 1, diagnosisCodes: [], feeCents: null })}
          >
            <Plus className="h-4 w-4" /> Add charge
          </Button>
        </div>
      </div>

      {state === 'loading' && <p className="text-sm text-slate-400">Loading…</p>}
      {state === 'error' && <p className="text-sm text-slate-500">Billing could not be loaded.</p>}

      {state === 'ready' && (
        <div className="space-y-3">
          {suggestions.length > 0 && (
            <div role="note" className="rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><strong>{suggestions.length}</strong> signed {suggestions.length === 1 ? 'session' : 'sessions'} ready to bill</span>
              </div>
              <ul className="mt-2 space-y-1.5">
                {suggestions.map((s) => (
                  <li key={s.note_id} className="flex items-center justify-between gap-2">
                    <span className="text-slate-600">{formatServiceDate(s.service_date)}</span>
                    <Button size="sm" variant="outline" onClick={() => void openCharge(draftFromSuggestion(s))}>Review &amp; add</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {charges.length === 0 ? (
            <p className="text-sm text-slate-500">No charges yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
              {charges.map((c) => {
                const st = paymentState(c.fee_cents, c.paid_cents)
                const [label, style] = STATE_STYLE[st]
                const open = c.fee_cents - c.paid_cents > 0
                return (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-slate-900">{serviceLabel(c.cpt_code)}</div>
                      <div className="text-xs text-slate-500">{formatServiceDate(c.service_date)}{c.invoice_number ? ` · ${c.invoice_number}` : ''}</div>
                    </div>
                    <span className="tabular-nums text-slate-700">{formatMoneyExact(c.fee_cents)}</span>
                    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', style)}>{label}</span>
                    <div className="flex gap-1">
                      {open && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'pay', charge: c })}><HandCoins className="h-4 w-4" /> Payment</Button>}
                      {open && !c.invoice_id && c.fee_cents > 0 && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'invoice', charge: c })}><FileText className="h-4 w-4" /> Invoice</Button>}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {docs.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Documents</h4>
              <ul className="space-y-1 text-sm">
                {docs.map((d) => (
                  <li key={d.key} className="flex items-center justify-between gap-2">
                    <Link to={d.to} className="font-mono text-brand-700 underline">{d.number}</Link>
                    <span className="text-xs text-slate-500">{d.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {dialog?.kind === 'charge' && meta && (
        <ChargeDialog loc={locationId} meta={meta} contacts={[{ id: contactId, name: contactName }]} draft={dialog.draft} onClose={() => setDialog(null)} onSaved={changed} />
      )}
      {dialog?.kind === 'pay' && (
        <RecordPaymentDialog loc={locationId} contactId={contactId} clientName={contactName} charges={[dialog.charge]} onClose={() => setDialog(null)} onRecorded={(id) => { onChanged?.(); navigate(`/billing/receipts/${id}`) }} />
      )}
      {dialog?.kind === 'invoice' && (
        <InvoiceDialog loc={locationId} contactId={contactId} clientName={contactName} charges={[dialog.charge]} onClose={() => setDialog(null)} onIssued={(id) => { onChanged?.(); navigate(`/billing/invoices/${id}`) }} />
      )}
    </section>
  )
}

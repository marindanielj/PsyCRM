import { ArrowLeft, Ban, Mail, HandCoins, Printer } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { PageSpinner } from '../../components/ui/spinner'
import { type ChargeRow, type InvoiceDetail, api } from '../../lib/api'
import { formatDateEs } from '../../lib/billing'
import { formatMoneyExact } from '../../lib/utils'
import { useAuth } from '../../state/auth'
import { useTenant } from '../../state/location'
import '../session-notes/note-print.css'
import './doc-print.css'
import { ReasonDialog } from './BillingDialogs'
import { RecordPaymentDialog } from './PaymentDialogs'
import { PracticeLogo } from './PracticeLogo'
import { SendDocumentDialog } from './SendDocumentDialog'

/**
 * An issued invoice. The document is in SPANISH because the client reads it (the toolbar around it stays in English, as the
 * therapist's interface). The text is the frozen copy made when it was issued; only the "paid" and "balance" columns follow the
 * payments, so a payment shows at once. It carries no diagnosis, code, tax id or NPI.
 */
export function InvoicePage() {
  const { id = '' } = useParams()
  const { current } = useTenant()
  const { operator } = useAuth()
  const navigate = useNavigate()
  const loc = current?.id
  const [inv, setInv] = useState<InvoiceDetail | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [voiding, setVoiding] = useState(false)
  const [emailing, setEmailing] = useState(false)
  const [paying, setPaying] = useState<ChargeRow[] | null>(null)

  const load = useCallback(async () => {
    if (!loc) return
    try {
      setInv((await api.billing.invoice(loc, id)).invoice)
      setState('ready')
    } catch {
      setState('missing')
    }
  }, [loc, id])

  useEffect(() => {
    void load()
  }, [load])

  if (!loc || state === 'loading') return <PageSpinner label="Loading invoice" />
  if (state === 'missing' || !inv) return <div className="p-10 text-center text-sm text-slate-500">Invoice not found. <Link className="text-brand-700 underline" to="/billing">Back to billing</Link></div>

  const { provider, client, lines, note } = inv.snapshot
  const voided = inv.status === 'void'
  const paid = inv.status === 'paid'
  const paidOf = (chargeId: string) => inv.paid_by_charge[chargeId] ?? 0

  function print() {
    // Record the print (it must never block the dialog), then open it.
    void api.billing.invoicePrinted(loc!, inv!.id).catch(() => {})
    window.print()
  }

  async function startPayment() {
    // The charges of this invoice, as the payment dialog needs them (fee, what is paid, what is owed).
    const all = (await api.billing.charges(loc!, { contactId: inv!.contact_id, status: 'active' })).charges
    setPaying(all.filter((c) => c.invoice_id === inv!.id))
  }

  return (
    <div className="ol-scroll ol-print-reset h-full overflow-y-auto bg-slate-100">
      <div className="ol-noprint sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[8.5in] flex-wrap items-center gap-2 px-4 py-2.5">
          <Link to="/billing" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Billing</Link>
          <span className="font-mono text-sm text-slate-700">{inv.number}</span>
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${voided ? 'bg-rose-50 text-rose-700' : paid ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>{voided ? 'Voided' : paid ? 'Paid' : 'Open'}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            {inv.status === 'open' && <Button size="sm" onClick={() => void startPayment()}><HandCoins className="h-4 w-4" /> Record payment</Button>}
            {!voided && <Button size="sm" variant="outline" onClick={() => setEmailing(true)}><Mail className="h-4 w-4" /> Send by email</Button>}
            <Button size="sm" variant="outline" onClick={print}><Printer className="h-4 w-4" /> Print / Save as PDF</Button>
            {!voided && <Button size="sm" variant="outline" className="text-rose-600 hover:bg-rose-50" onClick={() => setVoiding(true)}><Ban className="h-4 w-4" /> Void</Button>}
          </div>
        </div>
      </div>

      <div className="px-4 py-6">
        {voided && <p className="ol-noprint mx-auto mb-4 max-w-[8.5in] rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-800">This invoice was voided{inv.void_reason ? `: ${inv.void_reason}` : ''}. Its charges are free to put on a new one.</p>}
        <article lang="es" className="billing-doc mx-auto max-w-[8.5in] rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-3">
            <div className="flex items-start gap-4">
              <PracticeLogo loc={loc} />
              <div>
                <h1 className="text-xl font-bold text-slate-900">Factura</h1>
                <p className="text-sm font-semibold text-slate-800">{provider.practiceName || provider.name}</p>
              </div>
            </div>
            <div className="text-right text-sm">
              <div className="font-mono font-semibold">{inv.number}</div>
              <div className="text-slate-600">Emitida el {formatDateEs(String(inv.issued_at).slice(0, 10))}</div>
              {inv.due_on && <div className="text-slate-600">Vence el {formatDateEs(inv.due_on)}</div>}
              {voided && <div className="font-semibold text-rose-700">ANULADA</div>}
              {paid && <div className="font-semibold text-emerald-700">PAGADA</div>}
            </div>
          </header>

          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">De</h2>
              <p className="mt-1 text-sm font-semibold">{provider.name}</p>
              {provider.practiceName && provider.practiceName !== provider.name && <p className="text-sm">{provider.practiceName}</p>}
              <p className="whitespace-pre-line text-sm">{provider.address}</p>
              <p className="text-sm">{[provider.phone, provider.email].filter(Boolean).join(' · ')}</p>
            </section>
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Facturar a</h2>
              <p className="mt-1 text-sm font-semibold">{client.name}</p>
              {client.address && <p className="whitespace-pre-line text-sm">{client.address}</p>}
            </section>
          </div>

          <section className="mt-5">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-400 text-left text-xs uppercase text-slate-600">
                  <th className="py-1 pr-2">Fecha</th><th className="py-1 pr-2">Descripción</th>
                  <th className="py-1 pr-2 text-right">Importe</th><th className="py-1 pr-2 text-right">Pagado</th><th className="py-1 text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const p = voided ? 0 : paidOf(l.chargeId)
                  return (
                    <tr key={l.chargeId} className="border-b border-slate-200 align-top">
                      <td className="whitespace-nowrap py-1 pr-2">{formatDateEs(l.serviceDate)}</td>
                      <td className="py-1 pr-2">{l.description}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{formatMoneyExact(l.feeCents)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{formatMoneyExact(p)}</td>
                      <td className="py-1 text-right tabular-nums">{formatMoneyExact(voided ? 0 : l.feeCents - p)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold"><td colSpan={2} className="pt-2 text-right">Total de la factura</td><td className="pt-2 pr-2 text-right tabular-nums">{formatMoneyExact(inv.snapshot.totals.billedCents)}</td><td /><td /></tr>
                <tr><td colSpan={3} className="text-right text-slate-600">Pagado hasta hoy</td><td className="pr-2 text-right tabular-nums">{formatMoneyExact(inv.paid_cents)}</td><td /></tr>
                <tr className="text-base font-bold"><td colSpan={4} className="pt-1 text-right">Saldo pendiente</td><td className="pt-1 text-right tabular-nums">{formatMoneyExact(inv.balance_cents)}</td></tr>
              </tfoot>
            </table>
          </section>

          {note && <p className="mt-5 whitespace-pre-line text-sm text-slate-700">{note}</p>}

          <footer className="doc-footer mt-8 text-center text-[10px] text-slate-500">
            {inv.number} · {client.name} · impreso el {formatDateEs(new Date().toISOString().slice(0, 10))}{operator?.name ? ` por ${operator.name}` : ''}
          </footer>
        </article>
      </div>

      {paying && (
        <RecordPaymentDialog
          loc={loc}
          contactId={inv.contact_id}
          clientName={client.name}
          charges={paying}
          onClose={() => setPaying(null)}
          onRecorded={(receiptId) => navigate(`/billing/receipts/${receiptId}`)}
        />
      )}
      {emailing && <SendDocumentDialog loc={loc} kind="invoice" documentId={inv.id} contactId={inv.contact_id} clientName={client.name} onClose={() => setEmailing(false)} />}
      {voiding && (
        <ReasonDialog
          title="Void this invoice?"
          intro="It stays in the list, marked as voided, and its charges become free to put on a new invoice. Use this when something on it is wrong. Payments already recorded are not affected."
          confirm="Void invoice"
          onClose={() => setVoiding(false)}
          onSubmit={async (reason) => {
            await api.billing.voidInvoice(loc, inv.id, reason)
            setVoiding(false)
            navigate('/billing')
          }}
        />
      )}
    </div>
  )
}

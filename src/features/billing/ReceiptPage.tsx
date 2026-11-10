import { ArrowLeft, Ban, Printer } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { PageSpinner } from '../../components/ui/spinner'
import { type ReceiptDetail, api } from '../../lib/api'
import { PAYMENT_LABELS_ES, formatDateEs } from '../../lib/billing'
import { formatMoneyExact } from '../../lib/utils'
import { useAuth } from '../../state/auth'
import { useTenant } from '../../state/location'
import '../session-notes/note-print.css'
import './doc-print.css'
import { ReasonDialog } from './BillingDialogs'
import { PracticeLogo } from './PracticeLogo'

/**
 * A receipt: the proof of one payment. Written in SPANISH for the client, and frozen as issued. It says what was paid, when and
 * how, and what is still owed; it carries no diagnosis, code, tax id or NPI. Voiding it (with a reason) also voids the payments it proves.
 */
export function ReceiptPage() {
  const { id = '' } = useParams()
  const { current } = useTenant()
  const { operator } = useAuth()
  const navigate = useNavigate()
  const loc = current?.id
  const [rec, setRec] = useState<ReceiptDetail | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [voiding, setVoiding] = useState(false)

  const load = useCallback(async () => {
    if (!loc) return
    try {
      setRec((await api.billing.receipt(loc, id)).receipt)
      setState('ready')
    } catch {
      setState('missing')
    }
  }, [loc, id])

  useEffect(() => {
    void load()
  }, [load])

  if (!loc || state === 'loading') return <PageSpinner label="Loading receipt" />
  if (state === 'missing' || !rec) return <div className="p-10 text-center text-sm text-slate-500">Receipt not found. <Link className="text-brand-700 underline" to="/billing">Back to billing</Link></div>

  const { provider, client, lines, invoices, totals } = rec.snapshot
  const voided = Boolean(rec.voided_at)
  const method = PAYMENT_LABELS_ES[rec.method] ?? rec.method

  function print() {
    void api.billing.receiptPrinted(loc!, rec!.id).catch(() => {})
    window.print()
  }

  return (
    <div className="ol-scroll ol-print-reset h-full overflow-y-auto bg-slate-100">
      <div className="ol-noprint sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[8.5in] flex-wrap items-center gap-2 px-4 py-2.5">
          <Link to="/billing" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Billing</Link>
          <span className="font-mono text-sm text-slate-700">{rec.number}</span>
          {voided && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700">Voided</span>}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={print}><Printer className="h-4 w-4" /> Print / Save as PDF</Button>
            {!voided && <Button size="sm" variant="outline" className="text-rose-600 hover:bg-rose-50" onClick={() => setVoiding(true)}><Ban className="h-4 w-4" /> Void</Button>}
          </div>
        </div>
      </div>

      <div className="px-4 py-6">
        {voided && <p className="ol-noprint mx-auto mb-4 max-w-[8.5in] rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-800">This receipt was voided{rec.void_reason ? `: ${rec.void_reason}` : ''}. The payments it proved were voided with it.</p>}
        <article lang="es" className="billing-doc mx-auto max-w-[8.5in] rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-3">
            <div className="flex items-start gap-4">
              <PracticeLogo loc={loc} />
              <div>
                <h1 className="text-xl font-bold text-slate-900">Recibo de pago</h1>
                <p className="text-sm font-semibold text-slate-800">{provider.practiceName || provider.name}</p>
              </div>
            </div>
            <div className="text-right text-sm">
              <div className="font-mono font-semibold">{rec.number}</div>
              <div className="text-slate-600">Pagado el {formatDateEs(rec.paid_on)}</div>
              {voided && <div className="font-semibold text-rose-700">ANULADO</div>}
            </div>
          </header>

          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recibido por</h2>
              <p className="mt-1 text-sm font-semibold">{provider.name}</p>
              {provider.practiceName && provider.practiceName !== provider.name && <p className="text-sm">{provider.practiceName}</p>}
              <p className="whitespace-pre-line text-sm">{provider.address}</p>
              <p className="text-sm">{[provider.phone, provider.email].filter(Boolean).join(' · ')}</p>
            </section>
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recibido de</h2>
              <p className="mt-1 text-sm font-semibold">{client.name}</p>
              <dl className="mt-1 text-sm">
                <div><dt className="inline text-slate-500">Forma de pago: </dt><dd className="inline">{method}</dd></div>
                {invoices.length > 0 && <div><dt className="inline text-slate-500">{invoices.length === 1 ? 'Factura' : 'Facturas'}: </dt><dd className="inline font-mono">{invoices.join(', ')}</dd></div>}
              </dl>
            </section>
          </div>

          <section className="mt-5">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-400 text-left text-xs uppercase text-slate-600">
                  <th className="py-1 pr-2">Fecha del servicio</th><th className="py-1 pr-2">Descripción</th>
                  <th className="py-1 pr-2 text-right">Pagado</th><th className="py-1 text-right">Saldo restante</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.chargeId} className="border-b border-slate-200 align-top">
                    <td className="whitespace-nowrap py-1 pr-2">{formatDateEs(l.serviceDate)}</td>
                    <td className="py-1 pr-2">{l.description}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{formatMoneyExact(l.amountCents)}</td>
                    <td className="py-1 text-right tabular-nums">{formatMoneyExact(l.balanceAfterCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-base font-bold"><td colSpan={2} className="pt-2 text-right">Total recibido</td><td className="pt-2 pr-2 text-right tabular-nums">{formatMoneyExact(totals.paidCents)}</td><td /></tr>
              </tfoot>
            </table>
          </section>

          <p className="mt-6 text-sm text-slate-700">Gracias por su pago. Este recibo comprueba el pago de los servicios indicados.</p>

          <footer className="doc-footer mt-8 text-center text-[10px] text-slate-500">
            {rec.number} · {client.name} · impreso el {formatDateEs(new Date().toISOString().slice(0, 10))}{operator?.name ? ` por ${operator.name}` : ''}
          </footer>
        </article>
      </div>

      {voiding && (
        <ReasonDialog
          title="Void this receipt?"
          intro="The payments it proves are voided with it, and what each charge has paid is recalculated. It stays in the list, marked as voided. Use this when a payment was recorded by mistake."
          confirm="Void receipt"
          onClose={() => setVoiding(false)}
          onSubmit={async (reason) => {
            await api.billing.voidReceipt(loc, rec.id, reason)
            setVoiding(false)
            navigate('/billing')
          }}
        />
      )}
    </div>
  )
}

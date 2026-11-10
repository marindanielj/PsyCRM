import { ArrowLeft, Ban, Printer } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { PageSpinner } from '../../components/ui/spinner'
import { type SuperbillDetail, api } from '../../lib/api'
import { formatServiceDate } from '../../lib/billing'
import { formatMoneyExact } from '../../lib/utils'
import { useAuth } from '../../state/auth'
import { useTenant } from '../../state/location'
import '../session-notes/note-print.css'
import './doc-print.css'
import { ReasonDialog } from './BillingDialogs'
import { PracticeLogo } from './PracticeLogo'

const PLACE_LABELS: Record<string, string> = { '11': 'Office', '10': 'Telehealth (home)', '02': 'Telehealth' }

/** An issued superbill: read-only and print-ready. It is the frozen copy made when it was issued. */
export function SuperbillPage() {
  const { id = '' } = useParams()
  const { current } = useTenant()
  const { operator } = useAuth()
  const navigate = useNavigate()
  const loc = current?.id
  const [sb, setSb] = useState<SuperbillDetail | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [voiding, setVoiding] = useState(false)

  const load = useCallback(async () => {
    if (!loc) return
    try {
      setSb((await api.billing.superbill(loc, id)).superbill)
      setState('ready')
    } catch {
      setState('missing')
    }
  }, [loc, id])

  useEffect(() => {
    void load()
  }, [load])

  if (!loc || state === 'loading') return <PageSpinner label="Loading superbill" />
  if (state === 'missing' || !sb) {
    return <div className="p-10 text-center text-sm text-slate-500">Superbill not found. <Link className="text-brand-700 underline" to="/billing">Back to billing</Link></div>
  }

  const { provider, client, diagnoses, lines, totals } = sb.snapshot
  const voided = Boolean(sb.voided_at)

  function print() {
    // Record the print (it must never block the dialog), then open it.
    void api.billing.superbillPrinted(loc!, sb!.id).catch(() => {})
    window.print()
  }

  return (
    <div className="ol-scroll ol-print-reset h-full overflow-y-auto bg-slate-100">
      <div className="ol-noprint sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[8.5in] flex-wrap items-center gap-2 px-4 py-2.5">
          <Link to="/billing" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Billing</Link>
          <span className="font-mono text-sm text-slate-700">{sb.number}</span>
          {voided && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700">Voided</span>}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={print}><Printer className="h-4 w-4" /> Print / Save as PDF</Button>
            {!voided && <Button size="sm" variant="outline" className="text-rose-600 hover:bg-rose-50" onClick={() => setVoiding(true)}><Ban className="h-4 w-4" /> Void</Button>}
          </div>
        </div>
      </div>

      <div className="px-4 py-6">
        {voided && <p className="ol-noprint mx-auto mb-4 max-w-[8.5in] rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-800">This superbill was voided{sb.void_reason ? `: ${sb.void_reason}` : ''}. Its charges are free to put on a new one.</p>}
        <article className="billing-doc mx-auto max-w-[8.5in] rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-center text-[10px] font-semibold uppercase tracking-widest text-slate-500">Confidential — Protected health information</p>
          <header className="mt-2 flex flex-wrap items-start justify-between gap-4 border-b border-slate-300 pb-3">
            <div className="flex items-start gap-4">
              <PracticeLogo loc={loc} />
              <div>
                <h1 className="text-xl font-bold text-slate-900">Superbill</h1>
                <p className="text-sm text-slate-600">Statement of services for out-of-network reimbursement</p>
              </div>
            </div>
            <div className="text-right text-sm">
              <div className="font-mono font-semibold">{sb.number}</div>
              <div className="text-slate-600">Issued {formatServiceDate(String(sb.issued_at).slice(0, 10))}</div>
              {voided && <div className="font-semibold text-rose-700">VOID</div>}
            </div>
          </header>

          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Provider</h2>
              <p className="mt-1 text-sm font-semibold">{provider.name}</p>
              {provider.practiceName && <p className="text-sm">{provider.practiceName}</p>}
              <p className="whitespace-pre-line text-sm">{provider.address}</p>
              <p className="text-sm">{[provider.phone, provider.email].filter(Boolean).join(' · ')}</p>
              <dl className="mt-2 text-sm">
                <div><dt className="inline text-slate-500">License: </dt><dd className="inline">{provider.license}</dd></div>
                <div><dt className="inline text-slate-500">NPI: </dt><dd className="inline font-mono">{provider.npi}</dd></div>
                <div><dt className="inline text-slate-500">{provider.taxIdType === 'ssn' ? 'SSN' : 'EIN'}: </dt><dd className="inline font-mono">{provider.taxId ?? `ending ${provider.taxIdLast4}`}</dd></div>
                {provider.taxonomy && <div><dt className="inline text-slate-500">Taxonomy: </dt><dd className="inline font-mono">{provider.taxonomy}</dd></div>}
              </dl>
            </section>
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Client</h2>
              <p className="mt-1 text-sm font-semibold">{client.name}</p>
              <dl className="mt-1 text-sm">
                <div><dt className="inline text-slate-500">Date of birth: </dt><dd className="inline">{formatServiceDate(client.dateOfBirth)}</dd></div>
                {client.address && <div><dt className="inline text-slate-500">Address: </dt><dd className="inline">{client.address}</dd></div>}
                {client.memberId && <div><dt className="inline text-slate-500">Member ID: </dt><dd className="inline font-mono">{client.memberId}</dd></div>}
              </dl>
            </section>
          </div>

          <section className="mt-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Diagnoses (ICD-10-CM)</h2>
            <ul className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {diagnoses.map((d) => <li key={d.letter}><span className="font-semibold">{d.letter}.</span> <span className="font-mono">{d.code}</span></li>)}
            </ul>
          </section>

          <section className="mt-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Services</h2>
            <table className="mt-1 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-400 text-left text-xs uppercase text-slate-600">
                  <th className="py-1 pr-2">Date</th><th className="py-1 pr-2">Place</th><th className="py-1 pr-2">CPT</th><th className="py-1 pr-2">Mod.</th>
                  <th className="py-1 pr-2">Dx</th><th className="py-1 pr-2 text-right">Units</th><th className="py-1 pr-2 text-right">Fee</th><th className="py-1 text-right">Paid</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.chargeId} className="border-b border-slate-200 align-top">
                    <td className="whitespace-nowrap py-1 pr-2">{formatServiceDate(l.date)}</td>
                    <td className="py-1 pr-2" title={PLACE_LABELS[l.placeOfService]}>{l.placeOfService}</td>
                    <td className="py-1 pr-2"><span className="font-mono">{l.cpt}</span>{l.label && <div className="text-[11px] text-slate-500">{l.label}</div>}</td>
                    <td className="py-1 pr-2 font-mono">{l.modifiers.join(' ')}</td>
                    <td className="py-1 pr-2 font-mono">{l.dxPointers}</td>
                    <td className="py-1 pr-2 text-right">{l.units}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{formatMoneyExact(l.feeCents)}</td>
                    <td className="py-1 text-right tabular-nums">{formatMoneyExact(l.paidCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold"><td colSpan={6} className="pt-2 text-right">Total billed</td><td className="pt-2 pr-2 text-right tabular-nums">{formatMoneyExact(totals.billedCents)}</td><td /></tr>
                <tr><td colSpan={6} className="text-right text-slate-600">Total paid by the client</td><td /><td className="text-right tabular-nums">{formatMoneyExact(totals.paidCents)}</td></tr>
                <tr className="font-semibold"><td colSpan={6} className="text-right">Balance</td><td /><td className="text-right tabular-nums">{formatMoneyExact(totals.balanceCents)}</td></tr>
              </tfoot>
            </table>
          </section>

          <p className="mt-5 text-xs text-slate-600">Services were provided out of network. This document is not a bill and does not guarantee reimbursement; it is provided so the client may submit a claim to their plan. Place of service: 11 office, 10 telehealth with the client at home, 02 telehealth elsewhere.</p>

          <div className="mt-10 grid grid-cols-2 gap-10 text-sm">
            <div><div className="border-b border-slate-500 pt-8" /><div className="mt-1 text-xs text-slate-600">Provider signature</div></div>
            <div><div className="border-b border-slate-500 pt-8" /><div className="mt-1 text-xs text-slate-600">Date</div></div>
          </div>

          <footer className="doc-footer mt-6 text-center text-[10px] text-slate-500">
            {sb.number} · {client.name} · printed {new Date().toLocaleDateString('en-US')}{operator?.name ? ` by ${operator.name}` : ''} · Confidential
          </footer>
        </article>
      </div>

      {voiding && (
        <ReasonDialog
          title="Void this superbill?"
          intro="It stays in the list, marked as voided, and its charges become free to put on a new superbill. Use this when something on it is wrong."
          confirm="Void superbill"
          onClose={() => setVoiding(false)}
          onSubmit={async (reason) => {
            await api.billing.voidSuperbill(loc, sb.id, reason)
            setVoiding(false)
            navigate('/billing')
          }}
        />
      )}
    </div>
  )
}

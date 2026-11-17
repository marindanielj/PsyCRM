import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { type ChargePayment, type ChargeRow, api } from '../../lib/api'
import { PAYMENT_LABELS, formatServiceDate } from '../../lib/billing'
import { formatMoneyExact } from '../../lib/utils'
import { Modal, apiMessage } from './BillingDialogs'

/**
 * Correcting billing mistakes: see who paid a charge and take it out of a payment, or delete a charge with whatever depends
 * on it. Nothing is erased: each step voids, with a reason, and stays in the record ("Voided" in the lists).
 */

const label = (c: ChargeRow) => `${c.cpt_code} · ${formatServiceDate(c.service_date)}`

/** The payments on one charge, each with a way to take this charge out of it. */
export function ChargePaymentsDialog({ loc, charge, onClose, onChanged }: { loc: string; charge: ChargeRow; onClose: () => void; onChanged: () => void }) {
  const [payments, setPayments] = useState<ChargePayment[] | null>(null)
  const [picked, setPicked] = useState<ChargePayment | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const load = () =>
    api.billing
      .chargePayments(loc, charge.id)
      .then((r) => setPayments(r.payments))
      .catch((e) => setError(apiMessage(e)))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, charge.id])

  async function remove() {
    if (!picked || busy || reason.trim().length < 3) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.billing.removeChargeFromReceipt(loc, picked.receipt_id, charge.id, reason.trim())
      setResult(
        r.newReceipt
          ? `Receipt ${r.voided} was voided and the rest of that payment was recorded again as ${r.newReceipt.number}.`
          : `Receipt ${r.voided} was voided.`,
      )
      setPicked(null)
      setReason('')
      onChanged()
      await load()
    } catch (e) {
      setError(apiMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Payments on ${label(charge)}`} onClose={onClose} wide>
      <p className="mt-1 text-sm text-slate-600">
        A receipt is proof of a payment, so it is never edited. Taking this charge out of a payment voids that receipt; if it also paid other charges, those are recorded again on a new receipt (same date, method and amounts).
      </p>
      {result && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{result}</p>}
      {payments === null && !error && <p className="mt-4 text-sm text-slate-400">Loading…</p>}
      {payments?.length === 0 && <p className="mt-4 text-sm text-slate-500">This charge has no payments.</p>}
      {payments && payments.length > 0 && (
        <table className="mt-4 w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <tr><th className="py-1.5 pr-2">Receipt</th><th className="py-1.5 pr-2">Paid on</th><th className="py-1.5 pr-2">Method</th><th className="py-1.5 pr-2 text-right">On this charge</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {payments.map((p) => (
              <tr key={p.receipt_id}>
                <td className="py-2 pr-2">
                  <Link className="font-mono text-brand-700 underline" to={`/billing/receipts/${p.receipt_id}`}>{p.receipt_number}</Link>
                  {p.receipt_charge_count > 1 && <div className="text-xs text-slate-500">Also pays {p.receipt_charge_count - 1} other {p.receipt_charge_count === 2 ? 'charge' : 'charges'} ({formatMoneyExact(p.receipt_total_cents)} in all)</div>}
                </td>
                <td className="py-2 pr-2">{formatServiceDate(p.paid_on)}</td>
                <td className="py-2 pr-2">{PAYMENT_LABELS[p.method] ?? p.method}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatMoneyExact(p.amount_cents)}</td>
                <td className="py-2 text-right">
                  <Button size="sm" variant="outline" className="text-rose-600 hover:bg-rose-50" onClick={() => { setPicked(p); setResult(null) }}>Take out</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {picked && (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50/50 p-3">
          <p className="text-sm text-slate-800">
            Take {formatMoneyExact(picked.amount_cents)} off this charge: receipt <b className="font-mono">{picked.receipt_number}</b> is voided
            {picked.receipt_charge_count > 1 ? ', and its other charges are recorded again on a new receipt.' : '.'}
          </p>
          <Label htmlFor="rm-reason" className="mt-3">Reason</Label>
          <Input id="rm-reason" value={reason} maxLength={300} placeholder="e.g. Applied to the wrong session" onChange={(e) => setReason(e.target.value)} />
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setPicked(null)}>Cancel</Button>
            <Button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void remove()}>{busy ? 'Working…' : 'Take this charge out'}</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
      <div className="mt-5 flex justify-end"><Button variant="outline" onClick={onClose}>Close</Button></div>
    </Modal>
  )
}

/** Delete (void) a charge entered by mistake, together with the receipts, invoice and superbill that depend on it. */
export function DeleteChargeDialog({ loc, charge, onClose, onDeleted }: { loc: string; charge: ChargeRow; onClose: () => void; onDeleted: (voided: string[]) => void }) {
  const [payments, setPayments] = useState<ChargePayment[] | null>(charge.paid_cents > 0 ? null : [])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (charge.paid_cents === 0) return
    api.billing
      .chargePayments(loc, charge.id)
      .then((r) => setPayments(r.payments))
      .catch((e) => setError(apiMessage(e)))
  }, [loc, charge.id, charge.paid_cents])

  const also: string[] = [
    ...(payments ?? []).map((p) =>
      p.receipt_charge_count > 1
        ? `Receipt ${p.receipt_number} is voided. It also paid ${p.receipt_charge_count - 1} other ${p.receipt_charge_count === 2 ? 'charge' : 'charges'}, which become unpaid again: record that payment again if it was real.`
        : `Receipt ${p.receipt_number} (${formatMoneyExact(p.amount_cents)}) is voided.`,
    ),
    ...(charge.invoice_id ? [`Invoice ${charge.invoice_number} is voided; its other charges are freed to go on a new invoice.`] : []),
    ...(charge.superbill_id ? [`Superbill ${charge.superbill_number} is voided; its other charges are freed to go on a new superbill.`] : []),
  ]

  async function go() {
    if (busy || reason.trim().length < 3) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.billing.voidCharge(loc, charge.id, reason.trim(), true)
      onDeleted(r.voidedDocuments)
    } catch (e) {
      setError(apiMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Delete charge ${label(charge)}?`} onClose={onClose}>
      <p className="mt-1 text-sm text-slate-600">
        Use this when the charge was a mistake. It leaves the lists and totals; for the record it is kept as <b>voided</b>, with your reason (Charges → Voided).
      </p>
      {payments === null && !error ? (
        <p className="mt-3 text-sm text-slate-400">Checking its payments…</p>
      ) : also.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">This also:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{also.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      ) : null}
      <div className="mt-4">
        <Label htmlFor="del-reason">Reason</Label>
        <Input id="del-reason" value={reason} maxLength={300} placeholder="e.g. Entered by mistake" onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" className="bg-rose-600 hover:bg-rose-700" disabled={busy || payments === null || reason.trim().length < 3} onClick={() => void go()}>
          {busy ? 'Deleting…' : also.length > 0 ? 'Delete charge and void these' : 'Delete charge'}
        </Button>
      </div>
    </Modal>
  )
}

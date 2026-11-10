import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { ApiError, type ChargeRow, type MissingItem, type PaymentMethod, api } from '../../lib/api'
import { PAYMENT_LABELS, centsToInput, describeMissing, dollarsToCents, formatServiceDate } from '../../lib/billing'
import { formatMoneyExact } from '../../lib/utils'
import { Modal, apiMessage } from './BillingDialogs'

const todayYmd = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const owed = (c: ChargeRow) => c.fee_cents - c.paid_cents

/**
 * Record a payment over one or more of ONE client's charges. It always issues its receipt: that is one act, so the
 * dialog says so and leads to the receipt when it is done. Each amount defaults to what is still owed on that charge.
 */
export function RecordPaymentDialog({ loc, contactId, clientName, charges, onClose, onRecorded }: {
  loc: string
  contactId: string
  clientName: string
  /** The client's charges that still have a balance. */
  charges: ChargeRow[]
  onClose: () => void
  onRecorded: (receiptId: string) => void
}) {
  const open = charges.filter((c) => owed(c) > 0)
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(open.map((c) => [c.id, centsToInput(owed(c))])))
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [paidOn, setPaidOn] = useState(todayYmd())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lines = open.map((c) => ({ c, text: amounts[c.id] ?? '', cents: (amounts[c.id] ?? '').trim() === '' ? 0 : dollarsToCents(amounts[c.id] ?? '') }))
  const bad = lines.some((l) => l.cents === null || (l.cents ?? 0) > owed(l.c))
  const chosen = lines.filter((l) => (l.cents ?? 0) > 0)
  const total = chosen.reduce((s, l) => s + (l.cents ?? 0), 0)

  async function save() {
    if (busy || bad || chosen.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.billing.recordPayment(loc, { contactId, method, paidOn, allocations: chosen.map((l) => ({ chargeId: l.c.id, amountCents: l.cents as number })) })
      onRecorded(r.receipt.id)
    } catch (e) {
      setError(apiMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="Record payment" onClose={onClose} wide>
      <p className="mt-1 text-sm text-slate-600">{clientName}. Recording a payment also issues its receipt.</p>
      {open.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600">Everything selected is already paid.</p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200">
            {lines.map(({ c, cents }) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0 text-sm">
                  <div className="font-medium text-slate-900">{formatServiceDate(c.service_date)} <span className="font-mono text-slate-500">{c.cpt_code}</span></div>
                  <div className="text-xs text-slate-500">Fee {formatMoneyExact(c.fee_cents)} · paid {formatMoneyExact(c.paid_cents)} · owed {formatMoneyExact(owed(c))}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-sm text-slate-400">$</span>
                  <Input aria-label={`Amount for ${formatServiceDate(c.service_date)}`} inputMode="decimal" className="w-28 text-right" value={amounts[c.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })} />
                </div>
                {(cents === null || cents > owed(c)) && <p role="alert" className="w-full text-xs font-medium text-rose-600">{cents === null ? 'Use an amount like 110 or 110.50.' : 'That is more than what is still owed on this charge.'}</p>}
              </li>
            ))}
          </ul>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="pay-method">How it was paid</Label>
              <select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                {Object.entries(PAYMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="pay-date">Date paid</Label>
              <Input id="pay-date" type="date" max={todayYmd()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-700">Total received: <span className="font-semibold">{formatMoneyExact(total)}</span>. Leave a charge’s amount empty to skip it.</p>
        </>
      )}
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" disabled={busy || bad || chosen.length === 0 || !paidOn} onClick={() => void save()}>{busy ? 'Saving…' : 'Record payment & issue receipt'}</Button>
      </div>
    </Modal>
  )
}

/** Issue an invoice (a request for payment, in Spanish, for the client) from charges that are not already on one. */
export function InvoiceDialog({ loc, clientName, contactId, charges, onClose, onIssued }: {
  loc: string
  clientName: string
  contactId: string
  charges: ChargeRow[]
  onClose: () => void
  onIssued: (id: string) => void
}) {
  const [dueOn, setDueOn] = useState('')
  const [note, setNote] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<MissingItem[]>([])
  const billed = charges.reduce((s, c) => s + c.fee_cents, 0)
  const due = charges.reduce((s, c) => s + owed(c), 0)

  async function issue() {
    if (busy) return
    setBusy(true)
    setError(null)
    setMissing([])
    try {
      const r = await api.billing.issueInvoice(loc, { contactId, chargeIds: charges.map((c) => c.id), dueOn: dueOn || null, note: note.trim() || undefined, clientAddress: address.trim() || undefined })
      onIssued(r.invoice.id)
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { missing?: MissingItem[] } | undefined) : undefined
      if (body?.missing?.length) setMissing(body.missing)
      else setError(apiMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Create invoice for ${clientName}`} onClose={onClose}>
      <p className="mt-1 text-sm text-slate-600">{charges.length} {charges.length === 1 ? 'charge' : 'charges'} · total {formatMoneyExact(billed)} · due {formatMoneyExact(due)}. The invoice is written in Spanish for the client and shows no diagnosis or code. Once created it cannot be edited; if something is wrong, void it and make a new one.</p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="inv-due">Due date <span className="font-normal text-slate-400">(optional)</span></Label>
          <Input id="inv-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="inv-note">Note for the client <span className="font-normal text-slate-400">(optional, in Spanish)</span></Label>
          <Input id="inv-note" value={note} maxLength={300} placeholder="Se acepta efectivo, tarjeta, cheque o ATH Móvil." onChange={(e) => setNote(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="inv-address">Client address <span className="font-normal text-slate-400">(optional)</span></Label>
          <Input id="inv-address" value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} />
        </div>
      </div>
      {missing.length > 0 && (
        <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">It cannot be created yet:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{describeMissing(missing).map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" disabled={busy} onClick={() => void issue()}>{busy ? 'Creating…' : 'Create invoice'}</Button>
      </div>
    </Modal>
  )
}

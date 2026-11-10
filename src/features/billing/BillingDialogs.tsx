import { type ReactNode, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { ApiError, type BillingMeta, type ChargeInput, type ChargeRow, type ChargeSuggestion, type MissingItem, api } from '../../lib/api'
import { billingMessage, centsToInput, dollarsToCents, describeMissing } from '../../lib/billing'
import { formatMoneyExact } from '../../lib/utils'

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="ol-noprint fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={`my-auto w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-xl bg-white p-6 shadow-xl`} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function Footer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="mt-5 flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
      {children}
    </div>
  )
}

/** A short code from the API, or a generic line when the form itself was malformed (HTTP 400). */
export function apiMessage(e: unknown): string {
  if (e instanceof ApiError) return e.status === 400 ? 'Check the form: codes must look like 90834 and F41.1, and the fee must be an amount.' : billingMessage(e.message)
  return billingMessage(undefined)
}

// --- add or edit a charge ------------------------------------------------------------------------------------------

export interface ChargeDraft {
  contactId: string
  serviceDate: string
  cptCode: string
  modifiers: string[]
  placeOfService: string
  units: number
  diagnosisCodes: string[]
  feeCents: number | null
  appointmentId?: string | null
  sessionNoteId?: string | null
}

export const draftFromSuggestion = (s: ChargeSuggestion): ChargeDraft => ({
  contactId: s.contact_id, serviceDate: s.service_date, cptCode: s.cpt_code ?? '', modifiers: s.modifiers, placeOfService: s.place_of_service,
  units: 1, diagnosisCodes: s.diagnosis_codes, feeCents: s.fee_cents, appointmentId: s.appointment_id, sessionNoteId: s.note_id,
})

export const draftFromCharge = (c: ChargeRow): ChargeDraft => ({
  contactId: c.contact_id, serviceDate: c.service_date, cptCode: c.cpt_code, modifiers: c.modifiers, placeOfService: c.place_of_service,
  units: c.units, diagnosisCodes: c.diagnosis_codes, feeCents: c.fee_cents,
})

export function ChargeDialog({ loc, meta, contacts, draft, editingId, onClose, onSaved }: {
  loc: string
  meta: BillingMeta
  contacts: { id: string; name: string }[]
  draft: ChargeDraft
  /** Set when editing an existing charge (the client cannot change then). */
  editingId?: string
  onClose: () => void
  onSaved: () => void
}) {
  const known = meta.cpt.some((c) => c.code === draft.cptCode)
  const [contactId, setContactId] = useState(draft.contactId)
  const [date, setDate] = useState(draft.serviceDate)
  const [cptChoice, setCptChoice] = useState(draft.cptCode === '' ? '' : known ? draft.cptCode : 'other')
  const [customCpt, setCustomCpt] = useState(known ? '' : draft.cptCode)
  const [mods, setMods] = useState<string[]>(draft.modifiers)
  const [pos, setPos] = useState(draft.placeOfService)
  const [units, setUnits] = useState(String(draft.units))
  const [dx, setDx] = useState(draft.diagnosisCodes.join(', '))
  const [fee, setFee] = useState(draft.feeCents === null ? '' : centsToInput(draft.feeCents))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cpt = (cptChoice === 'other' ? customCpt : cptChoice).trim().toUpperCase()
  const feeCents = dollarsToCents(fee)
  const unitsN = Number(units)
  const ready = Boolean(contactId && date && cpt && feeCents !== null && Number.isInteger(unitsN) && unitsN >= 1)

  async function save() {
    if (!ready || busy || feeCents === null) return
    setBusy(true)
    setError(null)
    const input: ChargeInput = {
      contactId, serviceDate: date, cptCode: cpt, modifiers: mods, placeOfService: pos, units: unitsN, feeCents,
      diagnosisCodes: dx.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean),
      ...(draft.appointmentId ? { appointmentId: draft.appointmentId } : {}),
      ...(draft.sessionNoteId ? { sessionNoteId: draft.sessionNoteId } : {}),
    }
    try {
      if (editingId) {
        const { contactId: _c, appointmentId: _a, sessionNoteId: _n, ...patch } = input
        await api.billing.updateCharge(loc, editingId, patch)
      } else await api.billing.createCharge(loc, input)
      onSaved()
    } catch (e) {
      setError(apiMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={editingId ? 'Edit charge' : 'Add charge'} onClose={onClose} wide>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="ch-client">Client</Label>
          <select id="ch-client" value={contactId} disabled={Boolean(editingId || draft.sessionNoteId)} onChange={(e) => setContactId(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50">
            <option value="">Choose a client…</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <Label htmlFor="ch-date">Date of service</Label>
          <Input id="ch-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="ch-cpt">Service (CPT code)</Label>
          <select id="ch-cpt" value={cptChoice} onChange={(e) => setCptChoice(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="">Choose…</option>
            {meta.cpt.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.label}</option>)}
            <option value="other">Another code…</option>
          </select>
          {cptChoice === 'other' && <Input aria-label="Other CPT code" className="mt-2 uppercase" maxLength={5} placeholder="e.g. 90785" value={customCpt} onChange={(e) => setCustomCpt(e.target.value)} />}
          {draft.sessionNoteId && !draft.cptCode && <p className="mt-1 text-xs text-amber-700">The length of this session could not tell us the code. Please choose it.</p>}
        </div>
        <div>
          <Label htmlFor="ch-pos">Place of service</Label>
          <select id="ch-pos" value={pos} onChange={(e) => setPos(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
            {meta.placesOfService.map((p) => <option key={p.code} value={p.code}>{p.code} · {p.label}</option>)}
          </select>
        </div>
        <div>
          <span className="text-sm font-medium text-slate-700">Modifiers</span>
          <div className="mt-2 flex flex-wrap gap-3">
            {meta.modifiers.map((m) => (
              <label key={m.code} className="inline-flex items-center gap-1.5 text-sm text-slate-700" title={m.label}>
                <input type="checkbox" checked={mods.includes(m.code)} onChange={(e) => setMods(e.target.checked ? [...mods, m.code] : mods.filter((x) => x !== m.code))} />
                {m.code}
              </label>
            ))}
          </div>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="ch-dx">Diagnosis codes (ICD-10)</Label>
          <Input id="ch-dx" value={dx} placeholder="F41.1, F32.A" onChange={(e) => setDx(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Separate with commas. Up to {meta.maxDiagnoses}. Needed before a superbill can be issued.</p>
        </div>
        <div>
          <Label htmlFor="ch-fee">Fee ($)</Label>
          <Input id="ch-fee" inputMode="decimal" value={fee} placeholder="110.00" onChange={(e) => setFee(e.target.value)} />
          {fee.trim() !== '' && feeCents === null && <p role="alert" className="mt-1 text-xs font-medium text-rose-600">Use an amount like 110 or 110.50.</p>}
        </div>
        <div>
          <Label htmlFor="ch-units">Units</Label>
          <Input id="ch-units" type="number" min={1} max={99} value={units} onChange={(e) => setUnits(e.target.value)} />
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
      <Footer onClose={onClose}>
        <Button type="button" disabled={!ready || busy} onClick={() => void save()}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Add charge'}</Button>
      </Footer>
    </Modal>
  )
}

// (Recording a payment, and issuing an invoice, live in PaymentDialogs.tsx.)

// --- void (a charge, a superbill, an invoice or a receipt) ---------------------------------------------------------------------------------

export function ReasonDialog({ title, intro, confirm, onSubmit, onClose }: { title: string; intro: string; confirm: string; onSubmit: (reason: string) => Promise<void>; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function go() {
    if (busy || reason.trim().length < 3) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(reason.trim())
    } catch (e) {
      setError(apiMessage(e))
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mt-1 text-sm text-slate-600">{intro}</p>
      <div className="mt-4">
        <Label htmlFor="void-reason">Reason</Label>
        <Input id="void-reason" value={reason} maxLength={300} placeholder="e.g. Entered by mistake" onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
      <Footer onClose={onClose}>
        <Button type="button" variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => void go()}>{busy ? 'Working…' : confirm}</Button>
      </Footer>
    </Modal>
  )
}

// --- issue a superbill ---------------------------------------------------------------------------------------------

export function IssueDialog({ loc, clientName, contactId, charges, onClose, onIssued }: {
  loc: string
  clientName: string
  contactId: string
  charges: ChargeRow[]
  onClose: () => void
  onIssued: (id: string) => void
}) {
  const [address, setAddress] = useState('')
  const [memberId, setMemberId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<MissingItem[]>([])
  const total = charges.reduce((s, c) => s + c.fee_cents, 0)
  const paid = charges.reduce((s, c) => s + c.paid_cents, 0)

  async function issue() {
    if (busy) return
    setBusy(true)
    setError(null)
    setMissing([])
    try {
      const r = await api.billing.issueSuperbill(loc, { contactId, chargeIds: charges.map((c) => c.id), clientAddress: address.trim() || undefined, memberId: memberId.trim() || undefined })
      onIssued(r.superbill.id)
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { missing?: MissingItem[] } | undefined) : undefined
      if (body?.missing?.length) setMissing(body.missing)
      else setError(apiMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Create superbill for ${clientName}`} onClose={onClose}>
      <p className="mt-1 text-sm text-slate-600">{charges.length} {charges.length === 1 ? 'charge' : 'charges'} · billed {formatMoneyExact(total)} · paid {formatMoneyExact(paid)}. Once created it cannot be edited; if something is wrong, void it and make a new one.</p>
      <div className="mt-4 space-y-4">
        <div>
          <Label htmlFor="sb-address">Client address <span className="font-normal text-slate-400">(optional)</span></Label>
          <Input id="sb-address" value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="sb-member">Insurance member ID <span className="font-normal text-slate-400">(optional)</span></Label>
          <Input id="sb-member" value={memberId} maxLength={60} onChange={(e) => setMemberId(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">These two are kept only on this superbill, not on the client’s record.</p>
        </div>
      </div>
      {missing.length > 0 && (
        <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">It cannot be created yet:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{describeMissing(missing).map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
      <Footer onClose={onClose}>
        <Button type="button" disabled={busy} onClick={() => void issue()}>{busy ? 'Creating…' : 'Create superbill'}</Button>
      </Footer>
    </Modal>
  )
}

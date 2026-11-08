import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { ApiError, type DocPacket, type DocPacketItem, type SentSigner, type SignerRole, api } from '../../lib/api'
import { ageOn, isMinor, isValidIsoDate } from '../../lib/age'

const ROLE_LABEL: Record<SignerRole, string> = { client: 'Client', guardian: 'Parent / guardian', minor: 'Minor (assent)' }

const MESSAGES: Record<string, string> = {
  packet_audience_mismatch: "That packet doesn't fit the client's age.",
  date_of_birth_required: "The client's date of birth is missing.",
  template_not_active: 'One of the documents has no version in force. Activate it first.',
  no_documents: 'Nothing is left to send.',
  signer_missing: 'A document has nobody to sign it.',
  invalid_signers: 'Check who signs: an adult signs for themselves; a minor needs a parent or guardian.',
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Send onboarding packet" onClick={onClose}>
      <div className="my-auto w-full max-w-xl rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

interface SignerForm { role: SignerRole; name: string; email: string }

/** Send a packet to a client. The packet is chosen by the client's age; the therapist can leave documents out. */
export function SendPacketDialog({
  locationId, contactId, contactName, contactEmail, customFields, onClose, onSent,
}: {
  locationId: string
  contactId: string
  contactName: string
  contactEmail: string | null
  customFields: Record<string, unknown>
  onClose: () => void
  onSent: () => void
}) {
  const dob = customFields.date_of_birth
  const known = isValidIsoDate(dob)
  const minor = known ? isMinor(dob) : null
  const audience: DocPacket['audience'] | null = minor === null ? null : minor ? 'adolescent' : 'adult'

  const [packets, setPackets] = useState<DocPacket[] | null>(null)
  const [packetId, setPacketId] = useState('')
  const [items, setItems] = useState<DocPacketItem[]>([])
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [signers, setSigners] = useState<SignerForm[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<SentSigner[] | null>(null)

  useEffect(() => {
    let live = true
    api.documents.packets(locationId).then((r) => {
      if (!live) return
      const fit = r.packets.filter((p) => p.audience === audience)
      setPackets(fit)
      setPacketId(fit[0]?.id ?? '')
    }).catch(() => live && setPackets([]))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, audience])

  useEffect(() => {
    if (!packetId) { setItems([]); return }
    let live = true
    setExcluded(new Set())
    api.documents.packet(locationId, packetId).then((r) => live && setItems(r.documents)).catch(() => {})
    return () => { live = false }
  }, [locationId, packetId])

  // Who signs: the client for an adult; the guardian (prefilled from the record) plus an optional minor for a minor.
  useEffect(() => {
    if (audience === 'adult') setSigners([{ role: 'client', name: contactName, email: contactEmail ?? '' }])
    else if (audience === 'adolescent') {
      const g = (k: string) => (typeof customFields[k] === 'string' ? (customFields[k] as string) : '')
      setSigners([{ role: 'guardian', name: g('guardian_name'), email: g('guardian_email') }, { role: 'minor', name: contactName, email: '' }])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience, contactName, contactEmail])

  const chosen = useMemo(() => packets?.find((p) => p.id === packetId) ?? null, [packets, packetId])
  const patch = (i: number, p: Partial<SignerForm>) => setSigners((cur) => cur.map((s, j) => (j === i ? { ...s, ...p } : s)))
  const active = signers.filter((s) => s.role !== 'minor' || s.email.trim() !== '')
  const ready = !!chosen && items.some((i) => !excluded.has(i.familyId)) && active.every((s) => s.name.trim() && /.+@.+\..+/.test(s.email.trim())) && active.length > 0 && !items.some((i) => !excluded.has(i.familyId) && !i.active)

  async function send() {
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.documents.sendPacket(locationId, { contactId, packetId: chosen.id, excludeFamilyIds: [...excluded], signers: active.map((s) => ({ role: s.role, name: s.name.trim(), email: s.email.trim() })) })
      setSent(r.signers)
      onSent()
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | undefined) : undefined
      setError(MESSAGES[body?.error ?? ''] ?? 'Could not send. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <Shell onClose={onClose}>
        <h2 className="text-base font-semibold text-slate-900">Packet sent</h2>
        <ul className="mt-3 space-y-3">
          {sent.map((s) => (
            <li key={s.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="font-medium text-slate-800">{s.name} <span className="text-slate-500">· {ROLE_LABEL[s.role]}</span></div>
              {s.emailed ? <p className="text-emerald-700">Emailed to {s.email}.</p> : <p className="text-amber-700">Email not configured ({s.emailIssue}). Copy the link and send it yourself.</p>}
              <CopyLink link={s.link} />
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">Each link is shown only now. If you lose one, use Resend to make a new one.</p>
        <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
      </Shell>
    )
  }

  return (
    <Shell onClose={onClose}>
      <h2 className="text-base font-semibold text-slate-900">Send onboarding packet</h2>
      {!known || audience === null ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Add {contactName}'s date of birth to the record first. It decides which packet is sent.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-600">Age {ageOn(dob)} · DOB {dob as string} → <strong>{audience === 'adult' ? 'Adult' : 'Adolescent'}</strong> packet</p>
          <div className="mt-4">
            <Label htmlFor="sp-packet">Packet</Label>
            {packets === null ? <p className="text-sm text-slate-500">Loading…</p> : packets.length === 0 ? (
              <p className="text-sm text-amber-700">There is no {audience} packet yet. Create one under Documents → Packets.</p>
            ) : (
              <select id="sp-packet" className="h-10 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm" value={packetId} onChange={(e) => setPacketId(e.target.value)}>
                {packets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
          {items.length > 0 && (
            <div className="mt-4">
              <div className="text-sm font-medium text-slate-800">Documents</div>
              <ul className="mt-1 space-y-1">
                {items.map((i) => (
                  <li key={i.familyId} className="flex items-center gap-2 text-sm">
                    <input id={`sp-${i.familyId}`} type="checkbox" checked={!excluded.has(i.familyId)} onChange={(e) => setExcluded((cur) => { const n = new Set(cur); if (e.target.checked) n.delete(i.familyId); else n.add(i.familyId); return n })} />
                    <label htmlFor={`sp-${i.familyId}`} className="flex-1">{i.title}</label>
                    {!i.active && !excluded.has(i.familyId) && <span className="text-xs text-amber-700">no version in force</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 space-y-3">
            <div className="text-sm font-medium text-slate-800">Who signs</div>
            {signers.map((s, i) => (
              <div key={s.role} className="grid gap-2 sm:grid-cols-2">
                <div className="sm:col-span-2 text-xs font-medium text-slate-500">{ROLE_LABEL[s.role]}{s.role === 'minor' ? ' (optional — leave the email empty to skip)' : ''}</div>
                <Input aria-label={`${ROLE_LABEL[s.role]} name`} placeholder="Full name" value={s.name} onChange={(e) => patch(i, { name: e.target.value })} />
                <Input aria-label={`${ROLE_LABEL[s.role]} email`} type="email" placeholder="Email" value={s.email} onChange={(e) => patch(i, { email: e.target.value })} />
              </div>
            ))}
          </div>
        </>
      )}
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => void send()} disabled={!ready || busy}>{busy ? 'Sending…' : 'Send'}</Button>
      </div>
    </Shell>
  )
}

export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-2 flex items-center gap-2">
      <Input readOnly value={link} aria-label="Signing link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => {}) }}>{copied ? 'Copied' : 'Copy link'}</Button>
    </div>
  )
}

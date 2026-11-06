import { useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Textarea } from '../../components/ui/textarea'
import { ApiError, type DocRequest, type DocRequestStatus, api } from '../../lib/api'
import { CopyLink } from './SendPacketDialog'

const STATUS: Record<DocRequestStatus, { label: string; variant: 'blue' | 'amber' | 'green' | 'slate' | 'rose' }> = {
  sent: { label: 'Sent', variant: 'blue' },
  in_progress: { label: 'In progress', variant: 'amber' },
  completed: { label: 'Completed', variant: 'green' },
  expired: { label: 'Expired', variant: 'slate' },
  voided: { label: 'Voided', variant: 'rose' },
}
const ROLE = { client: 'Client', guardian: 'Parent / guardian', minor: 'Minor' } as const
const REVIEW: Record<string, string> = {
  dob_mismatch: 'The date of birth answered in the intake differs from the record.',
  adult_packet_minor: 'An adult packet was sent, but the answered date of birth is under 18.',
  adolescent_packet_adult: 'An adolescent packet was sent, but the answered date of birth is 18 or older.',
}
// Puerto Rico is UTC-4 all year; show dates in practice time whatever the browser's zone.
const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Puerto_Rico', month: 'short', day: 'numeric', year: 'numeric' })
const daysLeft = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)

/** One packet that was sent: where each person is, document by document. */
export function RequestCard({
  locationId, request, onChanged, onOpenSigned, showClient,
}: {
  locationId: string
  request: DocRequest
  onChanged: () => void
  onOpenSigned: (id: string) => void
  showClient?: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<{ signerId: string; link: string; emailed: boolean; issue: string | null } | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState('')
  const open = request.status === 'sent' || request.status === 'in_progress'
  const st = STATUS[request.status]

  async function run(key: string, fn: () => Promise<void>) {
    if (busy) return
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? 'That is no longer possible for this request.' : 'Something went wrong. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4" aria-label={`${request.packetName}, ${st.label}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
          {request.packetName}{showClient && request.contactName ? <span className="font-normal text-slate-500"> · {request.contactName}</span> : null}
        </h4>
        <Badge variant={st.variant}>{st.label}</Badge>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Sent {fmt(request.sentAt)}
        {open ? ` · expires ${fmt(request.expiresAt)} (${Math.max(daysLeft(request.expiresAt), 0)} days)` : ''}
        {request.completedAt ? ` · completed ${fmt(request.completedAt)}` : ''}
      </p>

      {request.needsReview && (
        <div role="note" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Needs your review.</strong> {REVIEW[request.needsReview] ?? 'Something about this packet needs a look.'} Fix the record or send the right packet — or accept it as it is.
          <div className="mt-2"><Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('accept', async () => { await api.documents.acceptReview(locationId, request.id); onChanged() })}>Accept as complete</Button></div>
        </div>
      )}

      <ul className="mt-3 space-y-3">
        {request.signers.map((s) => {
          const docs = request.documents.filter((d) => d.signerId === s.id)
          return (
            <li key={s.id} className="rounded-lg bg-slate-50 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-slate-800">{s.name}</span>
                <span className="text-slate-500">{ROLE[s.role]}</span>
                <span className="ml-auto text-xs text-slate-500">
                  {s.locked ? <span className="font-medium text-rose-600">Locked — resend the link</span> : s.status === 'completed' ? 'Done' : s.verifiedAt ? 'Verified' : s.firstViewedAt ? 'Opened' : 'Not opened'}
                </span>
              </div>
              <ul className="mt-2 space-y-1">
                {docs.map((d) => (
                  <li key={d.templateId} className="flex items-center gap-2 text-sm">
                    <span aria-hidden className={d.signedAt ? 'text-emerald-600' : 'text-slate-400'}>{d.signedAt ? '✓' : s.firstViewedAt ? '👁' : '○'}</span>
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                    {d.signedAt && d.signedDocumentId ? (
                      <button type="button" className="text-xs text-brand-700 underline" onClick={() => onOpenSigned(d.signedDocumentId!)}>Signed {fmt(d.signedAt)}</button>
                    ) : <span className="text-xs text-slate-400">pending</span>}
                  </li>
                ))}
              </ul>
              {open && s.status !== 'completed' && (
                <div className="mt-2">
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(`resend-${s.id}`, async () => {
                    const r = await api.documents.resend(locationId, request.id, s.id)
                    setLink({ signerId: s.id, link: r.signer.link, emailed: r.signer.emailed, issue: r.signer.emailIssue })
                    onChanged()
                  })}>{busy === `resend-${s.id}` ? 'Sending…' : 'Resend'}</Button>
                  {link?.signerId === s.id && (
                    <div className="mt-2 text-xs">
                      {link.emailed ? <p className="text-emerald-700">A new link was emailed to {s.email}. The old one no longer works.</p> : <p className="text-amber-700">Email not configured ({link.issue}). Copy the new link and send it yourself.</p>}
                      <CopyLink link={link.link} />
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {error && <p role="alert" className="mt-2 text-sm font-medium text-rose-600">{error}</p>}
      {open && !voiding && <div className="mt-3"><Button size="sm" variant="ghost" onClick={() => setVoiding(true)}>Void</Button></div>}
      {voiding && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
          <label htmlFor={`void-${request.id}`} className="text-sm font-medium text-rose-900">Why are you voiding it? The links stop working.</label>
          <Textarea id={`void-${request.id}`} rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="danger" disabled={!reason.trim() || busy !== null} onClick={() => void run('void', async () => { await api.documents.voidRequest(locationId, request.id, reason.trim()); setVoiding(false); onChanged() })}>Void request</Button>
            <Button size="sm" variant="outline" onClick={() => setVoiding(false)}>Keep it</Button>
          </div>
        </div>
      )}
    </article>
  )
}

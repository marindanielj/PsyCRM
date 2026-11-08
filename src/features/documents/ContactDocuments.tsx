import { Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { type DocRequest, type SignedDocSummary, api } from '../../lib/api'
import { RequestCard } from './RequestCard'
import { SendPacketDialog } from './SendPacketDialog'
import { SignedDocumentViewer } from './SignedDocumentViewer'

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Puerto_Rico', month: 'short', day: 'numeric', year: 'numeric' })

/** The client's Documents panel: send a packet, follow what was sent, open what was signed. */
export function ContactDocuments({
  locationId, contactId, contactName, contactEmail, customFields,
}: {
  locationId: string
  contactId: string
  contactName: string
  contactEmail: string | null
  customFields: Record<string, unknown>
}) {
  const [requests, setRequests] = useState<DocRequest[] | null>(null)
  const [signed, setSigned] = useState<SignedDocSummary[]>([])
  const [sending, setSending] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.documents.requests(locationId, { contactId }), api.documents.signedList(locationId, contactId)])
      setRequests(r.requests)
      setSigned(s.documents)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [locationId, contactId])

  useEffect(() => {
    setRequests(null)
    void load()
  }, [load])

  return (
    <section aria-label="Documents">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Documents</h3>
        <Button size="sm" onClick={() => setSending(true)}><Send className="h-4 w-4" /> Send onboarding packet</Button>
      </div>
      {failed && <p role="alert" className="text-sm text-rose-700">Could not load documents.</p>}
      {requests === null && !failed ? <p className="text-sm text-slate-500">Loading…</p> : requests?.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing sent yet.</p>
      ) : (
        <div className="space-y-3">{requests?.map((r) => <RequestCard key={r.id} locationId={locationId} request={r} onChanged={() => void load()} onOpenSigned={setViewing} />)}</div>
      )}
      {signed.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Signed documents</h4>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {signed.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => setViewing(d.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-slate-50">
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{d.templateTitle}</span>
                  <span className="text-xs text-slate-500">{d.signerName} · {fmt(d.signedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sending && (
        <SendPacketDialog locationId={locationId} contactId={contactId} contactName={contactName} contactEmail={contactEmail} customFields={customFields}
          onClose={() => setSending(false)} onSent={() => void load()} />
      )}
      {viewing && <SignedDocumentViewer locationId={locationId} id={viewing} onClose={() => setViewing(null)} />}
    </section>
  )
}

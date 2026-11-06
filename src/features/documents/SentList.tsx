import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageSpinner } from '../../components/ui/spinner'
import { type DocRequest, type DocRequestStatus, api } from '../../lib/api'
import { RequestCard } from './RequestCard'
import { SignedDocumentViewer } from './SignedDocumentViewer'

const FILTERS: { key: '' | DocRequestStatus; label: string }[] = [
  { key: '', label: 'All' }, { key: 'sent', label: 'Sent' }, { key: 'in_progress', label: 'In progress' },
  { key: 'completed', label: 'Completed' }, { key: 'expired', label: 'Expired' }, { key: 'voided', label: 'Voided' },
]

/** Documents → Sent: every packet, soonest-to-expire open ones first. */
export function SentList({ locationId }: { locationId: string }) {
  const [status, setStatus] = useState<'' | DocRequestStatus>('')
  const [requests, setRequests] = useState<DocRequest[] | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.documents.requests(locationId, status ? { status } : {})
      // Open requests that expire soonest come first; the rest keep newest-first.
      const isOpen = (x: DocRequest) => x.status === 'sent' || x.status === 'in_progress'
      setRequests([...r.requests.filter(isOpen).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)), ...r.requests.filter((x) => !isOpen(x))])
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [locationId, status])

  useEffect(() => {
    setRequests(null)
    void load()
  }, [load])

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setStatus(f.key)} aria-pressed={status === f.key}
            className={`rounded-full border px-3 py-1 text-sm ${status === f.key ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{f.label}</button>
        ))}
      </div>
      {failed && <p role="alert" className="text-sm text-rose-700">Could not load the list.</p>}
      {requests === null && !failed ? <PageSpinner /> : requests?.length === 0 ? <p className="text-sm text-slate-600">Nothing here.</p> : (
        <div className="space-y-3">
          {requests?.map((r) => (
            <div key={r.id}>
              <RequestCard locationId={locationId} request={r} showClient onChanged={() => void load()} onOpenSigned={setViewing} />
              <Link to={`/contacts/${r.contactId}`} className="mt-1 inline-block text-xs text-brand-700 underline">Open {r.contactName ?? 'client'}</Link>
            </div>
          ))}
        </div>
      )}
      {viewing && <SignedDocumentViewer locationId={locationId} id={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

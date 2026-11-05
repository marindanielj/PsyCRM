import { History } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { moduleEnabled } from '../../lib/modules'
import { useTenant } from '../../state/location'
import { AuditTable } from './AuditTable'
import { useAuditEntries } from './useAuditEntries'

/** A client's own audit history, collapsed until opened (it is only fetched then). */
export function ContactAudit({ locationId, contactId }: { locationId: string; contactId: string }) {
  const { current } = useTenant()
  const [open, setOpen] = useState(false)
  if (!moduleEnabled(current, 'audit')) return null
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <History className="h-4 w-4 text-slate-400" />
        Access &amp; change history
        <span className="text-xs font-normal text-brand-700">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open ? <Loaded locationId={locationId} contactId={contactId} /> : null}
    </div>
  )
}

function Loaded({ locationId, contactId }: { locationId: string; contactId: string }) {
  const { entries, status, hasMore, loadMore, loadingMore } = useAuditEntries(locationId, { contactId }, 25)
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-2">
      {status === 'loading' ? <p className="py-6 text-center text-sm text-slate-400">Loading…</p> : null}
      {status === 'error' ? <p className="py-6 text-center text-sm text-rose-600">Could not load the history.</p> : null}
      {status === 'ready' ? <AuditTable entries={entries} showClient={false} /> : null}
      {status === 'ready' && hasMore ? (
        <div className="flex justify-center border-t border-slate-100 py-3">
          <Button size="sm" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older entries'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { type AuditEntry } from '../../lib/api'
import { auditLabel, auditSummary } from '../../lib/audit-vocab'
import { cn } from '../../lib/utils'

const TZ = 'America/Puerto_Rico'

/** `Nov 5, 2026, 2:03:22 PM AST` — the practice's local time, zone named. */
export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso))
}

function actorText(e: AuditEntry): string {
  if (e.actorName) return e.actorName
  if (e.actorType === 'client') return 'Client'
  if (e.actorType === 'system') return 'System'
  return e.actorType
}

/** The log as a table. Each row expands to the full recorded details. */
export function AuditTable({ entries, showClient = true }: { entries: AuditEntry[]; showClient?: boolean }) {
  const [open, setOpen] = useState<number | null>(null)
  if (entries.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-slate-400">No activity recorded for these filters.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-6 py-2" />
            <th className="py-2 pr-3 font-medium">When</th>
            <th className="py-2 pr-3 font-medium">Who</th>
            <th className="py-2 pr-3 font-medium">Action</th>
            {showClient ? <th className="py-2 pr-3 font-medium">Client</th> : null}
            <th className="py-2 font-medium">Details</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const expanded = open === e.seq
            return (
              <FragmentRow key={e.seq}>
                <tr className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50" onClick={() => setOpen(expanded ? null : e.seq)}>
                  <td className="py-2 pl-1">
                    <ChevronRight className={cn('h-4 w-4 text-slate-400 transition-transform', expanded && 'rotate-90')} />
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-slate-600">{formatWhen(e.occurredAt)}</td>
                  <td className="py-2 pr-3 text-slate-800">{actorText(e)}</td>
                  <td className="py-2 pr-3 font-medium text-slate-900">{auditLabel(e.action)}</td>
                  {showClient ? (
                    <td className="py-2 pr-3">
                      {e.contactId ? (
                        <Link to={`/contacts/${e.contactId}`} className="text-brand-700 hover:underline" onClick={(ev) => ev.stopPropagation()}>
                          {e.contactName ?? 'Removed client'}
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  ) : null}
                  <td className="py-2 text-slate-600">{auditSummary(e.action, e.details)}</td>
                </tr>
                {expanded ? (
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <td />
                    <td colSpan={showClient ? 5 : 4} className="py-3 pr-3">
                      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs text-slate-600">
                        <dt className="font-medium text-slate-500">Entry</dt>
                        <dd>#{e.seq} · {e.action}</dd>
                        <dt className="font-medium text-slate-500">Recorded on</dt>
                        <dd>{e.entityType}{e.entityId ? ` ${e.entityId}` : ''}</dd>
                        {e.ip ? (
                          <>
                            <dt className="font-medium text-slate-500">IP address</dt>
                            <dd>{e.ip}</dd>
                          </>
                        ) : null}
                        <dt className="font-medium text-slate-500">Details</dt>
                        <dd><pre className="whitespace-pre-wrap break-words font-mono">{JSON.stringify(e.details, null, 2)}</pre></dd>
                      </dl>
                    </td>
                  </tr>
                ) : null}
              </FragmentRow>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// A keyed fragment (a <tbody> may not contain wrapper elements).
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

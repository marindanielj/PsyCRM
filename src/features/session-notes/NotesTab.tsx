import { FilePlus2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { type SessionNoteSummary, type SessionWithoutNote, api } from '../../lib/api'
import { label } from '../../lib/clinical-vocab'
import { cn } from '../../lib/utils'
import { LockBadge } from './LockBadge'
import { RiskPill } from './RiskBadge'
import { formatSessionDate } from './note-utils'

/** A client's session notes. A row opens the REPORT (never the editor). */
export function NotesTab({ locationId, contactId }: { locationId: string; contactId: string }) {
  const navigate = useNavigate()
  const [notes, setNotes] = useState<SessionNoteSummary[] | null>(null)
  const [pending, setPending] = useState<SessionWithoutNote | null>(null)
  const [showDeleted, setShowDeleted] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    setNotes(null)
    Promise.all([api.sessionNotes.list(locationId, contactId, showDeleted), api.sessionNotes.withoutNote(locationId, 3)])
      .then(([n, w]) => {
        if (!active) return
        setNotes(n.notes)
        setPending(w.sessions.find((s) => s.contact_id === contactId) ?? null)
      })
      .catch(() => active && setError(true))
    return () => {
      active = false
    }
  }, [locationId, contactId, showDeleted])

  return (
    <section aria-label="Session notes">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Session notes</h3>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
            Show deleted
          </label>
          <Button size="sm" onClick={() => navigate(`/contacts/${contactId}/notes/new${pending ? `?appointmentId=${pending.appointment_id}` : ''}`)}>
            <FilePlus2 className="h-4 w-4" />
            {pending ? 'Note for today’s session' : 'New session note'}
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-rose-600">Could not load the notes.</p> : null}
      {!notes && !error ? <p className="text-sm text-slate-400">Loading…</p> : null}
      {notes && notes.length === 0 ? <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">No session notes yet.</p> : null}
      {notes && notes.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Risk</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Lock</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((n) => (
                <tr key={n.id} className={cn('border-b border-slate-100 last:border-0', n.deleted_at ? 'bg-slate-50 text-slate-400' : 'hover:bg-slate-50')}>
                  <td className="px-3 py-2">
                    {n.deleted_at ? (
                      <span className="line-through">{formatSessionDate(n.session_date)}</span>
                    ) : (
                      <Link to={`/contacts/${contactId}/notes/${n.id}`} className="font-medium text-brand-700 hover:underline">
                        {formatSessionDate(n.session_date)}
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {label(n.session_type)} <span className="text-slate-400">· {label(n.modality)}</span>
                  </td>
                  <td className="px-3 py-2">{n.risk_level ? <RiskPill level={n.risk_level} /> : <span className="text-xs text-slate-400">—</span>}</td>
                  <td className="px-3 py-2">
                    {n.deleted_at ? (
                      <span className="text-xs" title={n.delete_reason ?? undefined}>Deleted{n.delete_reason ? ` — ${n.delete_reason}` : ''}</span>
                    ) : n.status === 'signed' ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">{n.signed_late ? 'Signed late' : 'Signed'}</span>
                    ) : (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">Draft</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{n.deleted_at ? null : <LockBadge lock={n.lock} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

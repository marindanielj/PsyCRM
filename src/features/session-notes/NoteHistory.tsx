import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type NoteRevisionMeta, type PracticeProfile, type SessionNote, api } from '../../lib/api'
import { NoteReport } from './NoteReport'
import { formatStamp } from './note-utils'
import { buildReport, fieldsFromNote } from './report-model'

const KIND_LABEL: Record<NoteRevisionMeta['kind'], string> = {
  create: 'Created',
  update: 'Edited',
  autosave: 'Autosaved',
  sign: 'Signed',
  delete: 'Deleted',
}

/** The note's change history: who changed it, when and why — and a read-only view of each saved version. */
export function NoteHistory({
  loc, noteId, practice, client, onClose,
}: {
  loc: string
  noteId: string
  practice: PracticeProfile
  client: { id: string; name: string; dateOfBirth: string | null }
  onClose: () => void
}) {
  const [revisions, setRevisions] = useState<NoteRevisionMeta[] | null>(null)
  const [open, setOpen] = useState<{ meta: NoteRevisionMeta; snapshot: SessionNote } | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    api.sessionNotes
      .revisions(loc, noteId)
      .then((r) => active && setRevisions(r.revisions))
      .catch(() => active && setError(true))
    return () => {
      active = false
    }
  }, [loc, noteId])

  async function view(meta: NoteRevisionMeta) {
    try {
      const r = await api.sessionNotes.revision(loc, noteId, meta.revision)
      setOpen({ meta, snapshot: r.revision.snapshot as unknown as SessionNote })
    } catch {
      setError(true)
    }
  }

  return (
    <div className="ol-noprint fixed inset-0 z-50 flex justify-end bg-slate-900/40" role="dialog" aria-modal="true" aria-label="Note history" onClick={onClose}>
      <aside className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">{open ? `Version ${open.meta.revision}` : 'History of changes'}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="ol-scroll flex-1 overflow-y-auto p-5">
          {error ? <p className="text-sm text-rose-600">Could not load the history.</p> : null}
          {!revisions && !error ? <p className="text-sm text-slate-400">Loading…</p> : null}
          {open ? (
            <>
              <button type="button" className="mb-3 text-sm text-brand-700 hover:underline" onClick={() => setOpen(null)}>
                ← All versions
              </button>
              <p className="mb-3 rounded bg-slate-100 px-3 py-2 text-xs text-slate-700">
                {KIND_LABEL[open.meta.kind]} by <b>{open.meta.changed_by_name ?? 'Staff'}</b> on {formatStamp(open.meta.changed_at)}
                {open.meta.change_reason ? ` — reason: ${open.meta.change_reason}` : ''}. This is a read-only copy of that version.
              </p>
              <NoteReport
                model={buildReport(fieldsFromNote(open.snapshot), {
                  practice, client, noteId, status: open.snapshot.status, signature: null, amended: null, addenda: [], preview: true,
                })}
              />
            </>
          ) : (
            <ol className="space-y-2">
              {revisions?.map((r) => (
                <li key={r.revision} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <div>
                    <p className="font-medium text-slate-900">
                      {KIND_LABEL[r.kind]} <span className="font-normal text-slate-500">· version {r.revision}</span>
                    </p>
                    <p className="text-xs text-slate-600">
                      {r.changed_by_name ?? 'Staff'} · {formatStamp(r.changed_at)}
                    </p>
                    {r.change_reason ? <p className="mt-0.5 text-xs italic text-slate-600">“{r.change_reason}”</p> : null}
                  </div>
                  <button type="button" className="shrink-0 text-xs font-medium text-brand-700 hover:underline" onClick={() => void view(r)}>
                    View
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  )
}

import { ArrowLeft, History, Pencil, Plus, Printer, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { PageSpinner } from '../../components/ui/spinner'
import { type Contact, type NoteAddendum, type NoteRevisionMeta, type PracticeProfile, type SessionNote, api } from '../../lib/api'
import { useAuth } from '../../state/auth'
import { useTenant } from '../../state/location'
import { LockBadge } from './LockBadge'
import { AddendumDialog, DeleteNoteDialog } from './NoteDialogs'
import { NoteHistory } from './NoteHistory'
import { NoteReport } from './NoteReport'
import { RiskPill } from './RiskBadge'
import { addendaForReport, buildReport, fieldsFromNote, lastAmendment } from './report-model'

interface Loaded {
  note: SessionNote
  addenda: NoteAddendum[]
  contact: Contact
  practice: PracticeProfile
  revisions: NoteRevisionMeta[]
}

/**
 * Opening a note ALWAYS shows the report (read-only, print-ready). Editing is a separate
 * action that exists only while the 72-hour window is open.
 */
export function NoteReportPage() {
  const { id: contactId = '', noteId = '' } = useParams()
  const { current } = useTenant()
  const { operator } = useAuth()
  const navigate = useNavigate()
  const routeState = useLocation().state as { notice?: string } | null
  const loc = current?.id

  const [data, setData] = useState<Loaded | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'deleted'>('loading')
  const [dialog, setDialog] = useState<'addendum' | 'delete' | 'history' | null>(null)

  const load = useCallback(async () => {
    if (!loc) return
    try {
      const [n, c, p, r] = await Promise.all([api.sessionNotes.get(loc, noteId), api.contact(loc, contactId), api.practice(loc), api.sessionNotes.revisions(loc, noteId)])
      setData({ note: n.note, addenda: n.addenda, contact: c.contact, practice: p.practice, revisions: r.revisions })
      setState('ready')
    } catch (e) {
      setState((e as { status?: number }).status === 410 ? 'deleted' : 'missing')
    }
  }, [loc, noteId, contactId])

  useEffect(() => {
    void load()
  }, [load])

  if (!loc || state === 'loading') return <PageSpinner label="Loading note" />
  if (state !== 'ready' || !data) {
    return (
      <div className="p-10 text-center text-sm text-slate-500">
        {state === 'deleted' ? 'This note was deleted. Its history is kept in the audit log.' : 'Note not found.'}{' '}
        <Link className="text-brand-700 underline" to={`/contacts/${contactId}`}>
          Back to the client
        </Link>
      </div>
    )
  }

  const { note, addenda, contact, practice, revisions } = data
  const name = contact.name ?? contact.emails[0] ?? 'Client'
  const dob = typeof contact.custom_fields?.date_of_birth === 'string' ? (contact.custom_fields.date_of_birth as string) : null
  const locked = note.lock.locked

  const model = buildReport(fieldsFromNote(note), {
    practice,
    client: { id: contactId, name, dateOfBirth: dob },
    noteId: note.id,
    status: note.status,
    signature: note.status === 'signed' && note.signed_at
      ? { name: note.signed_by_name ?? practice.therapist ?? 'Clinician', license: practice.license ? `Lic. ${practice.license}` : '', at: note.signed_at, late: note.signed_late }
      : null,
    amended: note.status === 'signed' ? lastAmendment(revisions) : null,
    addenda: addendaForReport(addenda),
  })

  function print() {
    // Record the print (fire and forget: it must never block the dialog), then open it.
    void api.sessionNotes.printed(loc!, note.id).catch(() => {})
    window.print()
  }

  return (
    <div className="ol-scroll ol-print-reset h-full overflow-y-auto bg-slate-100">
      <div className="ol-noprint sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[8.5in] flex-wrap items-center gap-2 px-4 py-2.5">
          <Link to={`/contacts/${contactId}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <ArrowLeft className="h-4 w-4" /> {name}
          </Link>
          <LockBadge lock={note.lock} />
          <RiskPill level={note.risk_level} />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={print}>
              <Printer className="h-4 w-4" /> Print / Save as PDF
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog('history')}>
              <History className="h-4 w-4" /> History
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog('addendum')}>
              <Plus className="h-4 w-4" /> Add addendum
            </Button>
            {!locked ? (
              <>
                <Button size="sm" onClick={() => navigate(`/contacts/${contactId}/notes/${note.id}/edit`)}>
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
                <Button size="sm" variant="outline" className="text-rose-600 hover:bg-rose-50" onClick={() => setDialog('delete')}>
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="px-4 py-6">
        {routeState?.notice ? <p className="ol-noprint mx-auto mb-4 max-w-[8.5in] rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">{routeState.notice}</p> : null}
        {note.status === 'draft' ? (
          <p className="ol-noprint mx-auto mb-4 max-w-[8.5in] rounded-lg bg-slate-200 px-4 py-2 text-sm text-slate-700">
            This note is a <b>draft</b>: it has not been signed. {locked ? 'The editing window has closed.' : 'Use Edit to finish and sign it.'}
          </p>
        ) : null}
        <NoteReport model={model} printedBy={operator?.name ?? operator?.email} />
      </div>

      {dialog === 'addendum' ? (
        <AddendumDialog
          onClose={() => setDialog(null)}
          onSubmit={async (body) => {
            await api.sessionNotes.addAddendum(loc, note.id, body)
            setDialog(null)
            await load()
          }}
        />
      ) : null}
      {dialog === 'delete' ? (
        <DeleteNoteDialog
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await api.sessionNotes.remove(loc, note.id, reason)
            navigate(`/contacts/${contactId}`, { replace: true })
          }}
        />
      ) : null}
      {dialog === 'history' ? <NoteHistory loc={loc} noteId={note.id} practice={practice} client={{ id: contactId, name, dateOfBirth: dob }} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}

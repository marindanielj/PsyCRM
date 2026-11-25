import { CalendarDays, MapPin, Phone, Video } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { ApiError, type Appointment, type AppointmentPatch, type AppointmentStatus, type Calendar, type Contact, api } from '../../lib/api'
import { MODALITIES, label } from '../../lib/clinical-vocab'
import { cn, formatPhone } from '../../lib/utils'
import { VideoActions } from './VideoActions'

const selectClass =
  'h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: 'Scheduled', confirmed: 'Confirmed', checked_in: 'Checked in', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
}
const STATUSES = Object.keys(STATUS_LABELS) as AppointmentStatus[]

type Modality = (typeof MODALITIES)[number]

const pad = (n: number) => String(n).padStart(2, '0')
const dateOf = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const timeOf = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const minutesBetween = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000)

/** What the server says when it refuses, in words for the therapist. */
function explain(err: unknown, what: 'save' | 'delete'): string {
  const msg = err instanceof ApiError ? err.message : ''
  const known: Record<string, string> = {
    'time already booked': 'That time is already booked on this calendar. Pick another.',
    'video session in progress': 'A video session is in progress. End it from the video room first.',
    'completed appointment': "How a completed session was held can't be changed, because billing follows it.",
    'unknown contact': "That client isn't in this practice.",
    'has a session note': "This appointment has a session note, so it can't be deleted. Mark it cancelled instead.",
  }
  return known[msg] ?? (what === 'save' ? 'Could not save. Please try again.' : 'Could not delete. Please try again.')
}

/**
 * An appointment's details, with Edit and Delete. Opens from the agenda and the month view. Editing sends one
 * request with only what changed; the server applies details, a new time and a new status together or not at all.
 */
export function AppointmentDialog({
  appt, calendar, contacts, loc, videoOn, notesOn, onClose, onSaved, onDeleted,
}: {
  appt: Appointment
  calendar?: Calendar
  contacts: Contact[]
  loc: string
  videoOn: boolean
  notesOn: boolean
  onClose: () => void
  onSaved: (appointment: Appointment, warnings: string[]) => void
  onDeleted: (id: string) => void
}) {
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState(appt.title)
  const [contactId, setContactId] = useState(appt.contact_id ?? '')
  const [date, setDate] = useState(dateOf(appt.starts_at))
  const [time, setTime] = useState(timeOf(appt.starts_at))
  const [duration, setDuration] = useState(minutesBetween(appt.starts_at, appt.ends_at))
  const [modality, setModality] = useState<Modality>(appt.modality)
  const [locationText, setLocationText] = useState(appt.location_text ?? '')
  const [notes, setNotes] = useState(appt.notes ?? '')
  const [status, setStatus] = useState<AppointmentStatus>(appt.status)

  const contact = contacts.find((c) => c.id === appt.contact_id)
  const contactName = contact?.name ?? undefined
  const start = new Date(appt.starts_at)
  const when = `${start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}, ${start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} – ${new Date(appt.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  const closed = appt.status === 'cancelled' || appt.status === 'no_show'
  const valid = title.trim().length > 0 && date !== '' && time !== '' && duration > 0

  function startEdit() {
    setTitle(appt.title); setContactId(appt.contact_id ?? ''); setDate(dateOf(appt.starts_at)); setTime(timeOf(appt.starts_at))
    setDuration(minutesBetween(appt.starts_at, appt.ends_at)); setModality(appt.modality); setLocationText(appt.location_text ?? ''); setNotes(appt.notes ?? ''); setStatus(appt.status)
    setError(null); setMode('edit')
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    const startsAt = new Date(`${date}T${time}`)
    if (Number.isNaN(startsAt.getTime())) return
    const patch: AppointmentPatch = {}
    if (title.trim() !== appt.title) patch.title = title.trim()
    if ((contactId || null) !== appt.contact_id) patch.contactId = contactId || null
    if (modality !== appt.modality) patch.modality = modality
    if ((locationText.trim() || null) !== appt.location_text) patch.locationText = locationText.trim() || null
    if ((notes.trim() || null) !== appt.notes) patch.notes = notes.trim() || null
    if (status !== appt.status) patch.status = status
    const endsAt = new Date(startsAt.getTime() + duration * 60_000)
    if (startsAt.toISOString() !== new Date(appt.starts_at).toISOString() || endsAt.toISOString() !== new Date(appt.ends_at).toISOString()) {
      patch.startsAt = startsAt.toISOString()
      patch.endsAt = endsAt.toISOString()
    }
    if (Object.keys(patch).length === 0) { setMode('view'); return }
    setBusy(true); setError(null)
    try {
      const r = await api.updateAppointment(loc, appt.id, patch)
      onSaved(r.appointment, r.warnings ?? [])
      setMode('view')
    } catch (err) {
      setError(explain(err, 'save'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await api.deleteAppointment(loc, appt.id)
      onDeleted(appt.id)
    } catch (err) {
      setError(explain(err, 'delete')); setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div role="dialog" aria-label="Appointment" onClick={(e) => e.stopPropagation()} className="flex max-h-[92vh] w-full max-w-md flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        {mode === 'view' ? (
          <>
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 break-words text-base font-semibold text-slate-900">{appt.title}</h2>
                <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-medium', closed ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-700')}>{STATUS_LABELS[appt.status]}</span>
              </div>
            </div>
            <div className="space-y-3 overflow-y-auto px-5 py-4 text-sm">
              <p className="flex items-start gap-2 text-slate-700"><CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />{when}</p>
              <Row k="Calendar" v={calendar?.name ?? '—'} />
              <Row k="Client" v={appt.contact_id ? <Link className="font-medium text-brand-700 hover:underline" to={`/contacts/${appt.contact_id}`} onClick={onClose}>{contactName ?? 'Open client'}</Link> : '—'} />
              <Row k="Held" v={<span className="inline-flex items-center gap-1.5">{appt.modality === 'phone' ? <Phone className="h-3.5 w-3.5" /> : appt.modality === 'telehealth_video' ? <Video className="h-3.5 w-3.5" /> : null}{label(appt.modality)}</span>} />
              {appt.location_text ? <Row k="Location" v={<span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-slate-400" />{appt.location_text}</span>} /> : null}
              {appt.checked_in_at ? <Row k="Checked in" v={new Date(appt.checked_in_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} /> : null}
              {appt.notes ? <div><p className="text-xs font-medium uppercase tracking-wide text-slate-400">Notes</p><p className="mt-1 whitespace-pre-wrap text-slate-700">{appt.notes}</p></div> : null}
              {(videoOn && appt.modality === 'telehealth_video' && !closed && appt.status !== 'completed') || ((appt.status === 'checked_in' || appt.status === 'completed') && appt.contact_id && notesOn) ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  {videoOn && appt.modality === 'telehealth_video' && !closed && appt.status !== 'completed' ? <VideoActions loc={loc} appt={appt} contactName={contactName} /> : null}
                  {(appt.status === 'checked_in' || appt.status === 'completed') && appt.contact_id && notesOn ? (
                    <Link className="text-sm font-medium text-brand-700 hover:underline" to={`/contacts/${appt.contact_id}/notes/new?appointmentId=${appt.id}`} onClick={onClose}>Session note</Link>
                  ) : null}
                </div>
              ) : null}
              {error ? <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-3.5">
              {confirmDelete ? (
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-slate-700">Delete this appointment? This can't be undone.</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep it</Button>
                    <Button size="sm" className="bg-rose-600 hover:bg-rose-700" onClick={() => void remove()} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</Button>
                  </div>
                </div>
              ) : (
                <>
                  <Button size="sm" variant="outline" className="text-rose-700" onClick={() => { setError(null); setConfirmDelete(true) }}>Delete</Button>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
                    <Button size="sm" onClick={startEdit}>Edit</Button>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <form onSubmit={save} className="flex min-h-0 flex-col">
            <div className="border-b border-slate-100 px-5 py-4"><h2 className="text-base font-semibold text-slate-900">Edit appointment</h2></div>
            <div className="space-y-4 overflow-y-auto px-5 py-4">
              <div><Label htmlFor="ea-title">Title</Label><Input id="ea-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus /></div>
              <div className="grid grid-cols-[1fr_1fr_auto] gap-3">
                <div><Label htmlFor="ea-date">Date</Label><Input id="ea-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                <div><Label htmlFor="ea-time">Time</Label><Input id="ea-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
                <div className="w-20"><Label htmlFor="ea-dur">Mins</Label><Input id="ea-dur" type="number" min={5} step={5} value={duration} onChange={(e) => setDuration(Number.parseInt(e.target.value, 10) || 0)} /></div>
              </div>
              <div>
                <Label htmlFor="ea-contact">Client</Label>
                <select id="ea-contact" value={contactId} onChange={(e) => setContactId(e.target.value)} className={selectClass}>
                  <option value="">— None —</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.name ?? formatPhone(c.phones[0]) ?? 'Unknown'}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="ea-mod">How it's held</Label>
                  <select id="ea-mod" value={modality} onChange={(e) => setModality(e.target.value as Modality)} className={selectClass}>
                    {MODALITIES.map((m) => <option key={m} value={m}>{label(m)}</option>)}
                  </select>
                </div>
                <div>
                  <Label htmlFor="ea-status">Status</Label>
                  <select id="ea-status" value={status} onChange={(e) => setStatus(e.target.value as AppointmentStatus)} className={selectClass}>
                    {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                  </select>
                </div>
              </div>
              <div><Label htmlFor="ea-loc">Location</Label><Input id="ea-loc" value={locationText} maxLength={300} onChange={(e) => setLocationText(e.target.value)} placeholder="Address or meeting link" /></div>
              <div><Label htmlFor="ea-notes">Notes</Label><Textarea id="ea-notes" value={notes} maxLength={5000} rows={3} onChange={(e) => setNotes(e.target.value)} /></div>
              {error ? <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
              <Button type="button" variant="outline" size="sm" onClick={() => { setError(null); setMode('view') }} disabled={busy}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">{k}</span>
      <span className="min-w-0 text-slate-700">{v}</span>
    </div>
  )
}

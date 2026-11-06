import { ChevronDown, ChevronUp, ClipboardPen, LogIn, ShieldAlert, Timer } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { type Appointment, type ElevatedRiskClient, type SessionNoteSummary, type SessionWithoutNote, api } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'
import { cn } from '../../lib/utils'
import { useTenant } from '../../state/location'
import { LockBadge } from './LockBadge'
import { RiskPill } from './RiskBadge'
import { formatSessionDate, todayInPractice } from './note-utils'

const time = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))

const STATUS_PILL: Record<string, string> = {
  scheduled: 'bg-slate-100 text-slate-700',
  confirmed: 'bg-brand-50 text-brand-700',
  checked_in: 'bg-sky-50 text-sky-700',
  completed: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-amber-50 text-amber-700',
  no_show: 'bg-rose-50 text-rose-700',
}
const STATUS_TEXT: Record<string, string> = { scheduled: 'Scheduled', confirmed: 'Confirmed', checked_in: 'Checked in', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' }

function Card({ title, icon, tone, children }: { title: string; icon: React.ReactNode; tone?: 'danger' | 'warn'; children: React.ReactNode }) {
  return (
    <section className={cn('rounded-xl border bg-white p-3 shadow-sm', tone === 'danger' ? 'border-rose-200' : tone === 'warn' ? 'border-amber-200' : 'border-slate-200')}>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

/**
 * The practice's daily dashboard on the agenda: today's sessions with a one-tap check-in,
 * clients whose latest risk is moderate or worse, notes about to lock, and sessions that
 * happened but have no note yet.
 */
export function TodayPanel() {
  const { current } = useTenant()
  const loc = current?.id
  const notesOn = moduleEnabled(current, 'session_notes')
  const [open, setOpen] = useState(true)
  const [today, setToday] = useState<Appointment[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [elevated, setElevated] = useState<ElevatedRiskClient[]>([])
  const [locking, setLocking] = useState<SessionNoteSummary[]>([])
  const [missing, setMissing] = useState<SessionWithoutNote[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!loc) return
    const day = todayInPractice()
    const next = new Date(`${day}T12:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    const from = `${day}T00:00:00-04:00`
    const to = `${next.toISOString().slice(0, 10)}T00:00:00-04:00`
    const [appts, contacts, risk, soon, backlog] = await Promise.allSettled([
      api.appointments(loc, from, to),
      api.contacts(loc),
      notesOn ? api.sessionNotes.elevatedRisk(loc) : Promise.reject(new Error('off')),
      notesOn ? api.sessionNotes.lockingSoon(loc, 24) : Promise.reject(new Error('off')),
      notesOn ? api.sessionNotes.withoutNote(loc, 3) : Promise.reject(new Error('off')),
    ])
    if (appts.status === 'fulfilled') setToday(appts.value.appointments.filter((a) => a.status !== 'cancelled'))
    if (contacts.status === 'fulfilled') setNames(Object.fromEntries(contacts.value.contacts.map((c) => [c.id, c.name ?? c.emails[0] ?? 'Client'])))
    setElevated(risk.status === 'fulfilled' ? risk.value.elevated : [])
    setLocking(soon.status === 'fulfilled' ? soon.value.notes : [])
    setMissing(backlog.status === 'fulfilled' ? backlog.value.sessions : [])
  }, [loc, notesOn])

  useEffect(() => {
    void load()
  }, [load])

  async function checkIn(id: string) {
    if (!loc) return
    setBusy(id)
    try {
      await api.checkInAppointment(loc, id)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const nothingElse = elevated.length + locking.length + missing.length === 0
  return (
    <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-3 lg:px-6">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left" aria-expanded={open}>
        <span className="text-sm font-semibold text-slate-900">
          Today <span className="font-normal text-slate-500">· {formatSessionDate(todayInPractice())}</span>
          {!open && elevated.length > 0 ? <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">{elevated.length} elevated risk</span> : null}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
      </button>

      {open ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
          <Card title="Today’s sessions" icon={<LogIn className="h-3.5 w-3.5" />}>
            {today.length === 0 ? (
              <p className="text-sm text-slate-400">No sessions today.</p>
            ) : (
              <ul className="space-y-2">
                {today.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-sm">
                    <span className="w-16 shrink-0 font-medium text-slate-900">{time(a.starts_at)}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-700">{a.contact_id ? (names[a.contact_id] ?? a.title) : a.title}</span>
                    {(a.status === 'scheduled' || a.status === 'confirmed') && a.contact_id ? (
                      <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => void checkIn(a.id)}>
                        Check in
                      </Button>
                    ) : a.status === 'checked_in' && a.contact_id && notesOn ? (
                      <Link className="shrink-0 text-xs font-medium text-brand-700 hover:underline" to={`/contacts/${a.contact_id}/notes/new?appointmentId=${a.id}`}>
                        Start note
                      </Link>
                    ) : (
                      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', STATUS_PILL[a.status])}>{STATUS_TEXT[a.status] ?? a.status}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {elevated.length > 0 ? (
            <Card title="Elevated risk" tone="danger" icon={<ShieldAlert className="h-3.5 w-3.5 text-rose-600" />}>
              <ul className="space-y-2">
                {elevated.map((c) => (
                  <li key={c.contact_id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
                    <Link to={`/contacts/${c.contact_id}`} className="min-w-0 truncate font-medium text-slate-900 hover:underline">
                      {c.contact_name ?? 'Client'}
                    </Link>
                    <RiskPill level={c.risk_level} date={c.session_date} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {locking.length > 0 ? (
            <Card title="Notes locking soon" tone="warn" icon={<Timer className="h-3.5 w-3.5 text-amber-600" />}>
              <ul className="space-y-2">
                {locking.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
                    <Link to={`/contacts/${n.contact_id}/notes/${n.id}`} className="min-w-0 truncate font-medium text-slate-900 hover:underline">
                      {n.contact_name ?? 'Client'} <span className="font-normal text-slate-500">· {formatSessionDate(n.session_date)}</span>
                    </Link>
                    <LockBadge lock={n.lock} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {missing.length > 0 ? (
            <Card title="Sessions without a note" icon={<ClipboardPen className="h-3.5 w-3.5" />}>
              <ul className="space-y-2">
                {missing.map((s) => (
                  <li key={s.appointment_id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
                    <span className="min-w-0 truncate text-slate-800">
                      {s.contact_name ?? 'Client'} <span className="text-slate-500">· {formatSessionDate(s.starts_at.slice(0, 10))}</span>
                    </span>
                    <Link className="shrink-0 text-xs font-medium text-brand-700 hover:underline" to={`/contacts/${s.contact_id}/notes/new?appointmentId=${s.appointment_id}`}>
                      Write note
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {notesOn && nothingElse ? <p className="self-center text-sm text-slate-400 md:col-span-1 xl:col-span-3">Nothing needs your attention: no elevated risk, no notes about to lock, no undocumented sessions.</p> : null}
        </div>
      ) : null}
    </div>
  )
}

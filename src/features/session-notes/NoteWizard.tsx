import { AlertTriangle, ArrowLeft, Check, ChevronLeft, ChevronRight, Loader2, Lock } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { PageSpinner } from '../../components/ui/spinner'
import {
  type Appointment, ApiError, type Contact, type NoteLock, type PracticeProfile, type SessionNote, type SessionNoteInput, api,
} from '../../lib/api'
import { cn } from '../../lib/utils'
import { useAuth } from '../../state/auth'
import { useTenant } from '../../state/location'
import { LockBadge } from './LockBadge'
import { type NoteForm, changedInput, emptyForm, formFromNote, formToInput, formatLockRemaining, reviewChecklist, riskStatus, todayInPractice } from './note-utils'
import { buildReport, fieldsFromForm } from './report-model'
import { ContextStep } from './steps/ContextStep'
import { DapStep } from './steps/DapStep'
import { MseStep } from './steps/MseStep'
import { ReviewStep } from './steps/ReviewStep'
import { RiskStep } from './steps/RiskStep'

const STEPS = ['Context', 'Mental status', 'Risk', 'DAP', 'Review & sign'] as const
const AUTOSAVE_DEBOUNCE_MS = 2_000
const AUTOSAVE_MIN_GAP_MS = 10_000

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'locked'

interface Loaded {
  contact: Contact
  practice: PracticeProfile
  appointments: Appointment[]
  previousRisk: { level: string; date: string } | null
  note: SessionNote | null
}

const prTime = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Puerto_Rico', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
const prDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(new Date(iso))

/** The 5-step note editor. `/contacts/:id/notes/new` creates a draft on the first change; `/…/:noteId/edit` edits one. */
export function NoteWizardPage({ mode }: { mode: 'new' | 'edit' }) {
  const { id: contactId = '', noteId: routeNoteId } = useParams()
  const [search] = useSearchParams()
  const { current } = useTenant()
  const loc = current?.id
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!loc) return
    let active = true
    const from = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const to = new Date(Date.now() + 2 * 86_400_000).toISOString()
    Promise.all([
      api.contact(loc, contactId),
      api.practice(loc),
      api.appointments(loc, from, to),
      api.sessionNotes.latestRisk(loc, contactId),
      mode === 'edit' && routeNoteId ? api.sessionNotes.get(loc, routeNoteId) : Promise.resolve(null),
    ])
      .then(([c, p, a, r, n]) => {
        if (!active) return
        setLoaded({
          contact: c.contact,
          practice: p.practice,
          appointments: a.appointments.filter((x) => x.contact_id === contactId && x.status !== 'cancelled' && x.status !== 'no_show'),
          previousRisk: r.risk ? { level: r.risk.risk_level, date: r.risk.session_date } : null,
          note: n ? n.note : null,
        })
      })
      .catch(() => active && setLoadError(true))
    return () => {
      active = false
    }
  }, [loc, contactId, mode, routeNoteId])

  if (loadError) return <p className="p-8 text-center text-sm text-slate-500">This note could not be loaded.</p>
  if (!loc || !loaded) return <PageSpinner label="Loading note" />
  // A locked, deleted or missing note is never edited: send the reader to the report.
  if (mode === 'edit' && (!loaded.note || loaded.note.lock.locked)) {
    return <Navigate to={`/contacts/${contactId}/notes/${routeNoteId}`} replace state={{ notice: 'This note is locked and can no longer be edited. You can add an addendum.' }} />
  }
  return <Wizard loc={loc} contactId={contactId} loaded={loaded} initialAppointmentId={search.get('appointmentId')} />
}

function Wizard({ loc, contactId, loaded, initialAppointmentId }: { loc: string; contactId: string; loaded: Loaded; initialAppointmentId: string | null }) {
  const navigate = useNavigate()
  const { operator } = useAuth()
  const { contact, practice, appointments, previousRisk, note: existing } = loaded
  const clientName = contact.name ?? contact.emails[0] ?? 'Client'
  const dob = typeof contact.custom_fields?.date_of_birth === 'string' ? (contact.custom_fields.date_of_birth as string) : null

  // ---- the working copy ------------------------------------------------------------
  const initialForm = useMemo<NoteForm>(() => {
    if (existing) return formFromNote(existing)
    const appt = appointments.find((a) => a.id === initialAppointmentId)
    const base = emptyForm(todayInPractice())
    if (!appt) return base
    const minutes = Math.round((new Date(appt.ends_at).getTime() - new Date(appt.starts_at).getTime()) / 60_000)
    return { ...base, appointmentId: appt.id, sessionDate: prDate(appt.starts_at), startTime: prTime(appt.starts_at), durationMin: String(minutes || 50) }
  }, [existing, appointments, initialAppointmentId])

  const [form, setForm] = useState<NoteForm>(initialForm)
  const [step, setStep] = useState(0)
  const [showErrors, setShowErrors] = useState(false)
  const [changeReason, setChangeReason] = useState('')
  const [showReasonError, setShowReasonError] = useState(false)
  const [signing, setSigning] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [lock, setLock] = useState<NoteLock | null>(existing?.lock ?? null)
  const status: 'draft' | 'signed' = existing?.status ?? 'draft'

  const noteIdRef = useRef<string | null>(existing?.id ?? null)
  const baselineRef = useRef<SessionNoteInput>(formToInput(initialForm)) // what the server has (or, for a new note, the untouched form)
  const lastAutosaveRef = useRef(0)
  const inFlightRef = useRef(false)
  const formRef = useRef(form)
  formRef.current = form

  const input = useMemo(() => formToInput(form), [form])
  const dirty = JSON.stringify(input) !== JSON.stringify(baselineRef.current)
  const signed = status === 'signed'
  const readOnly = saveState === 'locked'

  const patch = useCallback((p: Partial<NoteForm>) => setForm((f) => ({ ...f, ...p })), [])

  const onPickAppointment = (id: string | null) => {
    const appt = appointments.find((a) => a.id === id)
    if (!appt) return patch({ appointmentId: null })
    const minutes = Math.round((new Date(appt.ends_at).getTime() - new Date(appt.starts_at).getTime()) / 60_000)
    patch({ appointmentId: appt.id, sessionDate: prDate(appt.starts_at), startTime: prTime(appt.starts_at), durationMin: String(minutes || 50) })
  }

  // ---- saving ----------------------------------------------------------------------
  /** Create the draft (first save) or send what changed. Returns true when the server has the current text. */
  const save = useCallback(
    async (opts: { autosave: boolean; reason?: string } = { autosave: false }): Promise<boolean> => {
      if (inFlightRef.current) return false
      const current = formToInput(formRef.current)
      if (noteIdRef.current && JSON.stringify(current) === JSON.stringify(baselineRef.current)) return true
      inFlightRef.current = true
      setSaveState('saving')
      try {
        if (!noteIdRef.current) {
          const r = await api.sessionNotes.create(loc, { ...current, contactId, sessionDate: current.sessionDate ?? todayInPractice() })
          noteIdRef.current = r.note.id
          setLock(r.note.lock)
          // From now on this note has an address: a reload (or a bookmark) must reopen THIS
          // draft, not start a second one. replaceState changes the URL without remounting.
          window.history.replaceState(window.history.state, '', `/contacts/${contactId}/notes/${r.note.id}/edit`)
        } else {
          const delta = changedInput(baselineRef.current, current)
          const r = await api.sessionNotes.update(loc, noteIdRef.current, { ...delta, autosave: opts.autosave && !signed ? true : undefined, changeReason: opts.reason })
          setLock(r.note.lock)
        }
        baselineRef.current = current
        if (opts.autosave) lastAutosaveRef.current = Date.now()
        setSavedAt(Date.now())
        setSaveState('saved')
        setProblem(null)
        return true
      } catch (e) {
        if (e instanceof ApiError && e.message === 'note_locked') {
          setSaveState('locked')
          setProblem('The 72-hour editing window has closed: this note is now locked. Your last saved version is kept; you can add an addendum from the report.')
        } else {
          setSaveState('error')
          setProblem(e instanceof ApiError && e.message ? `Could not save: ${e.message}` : 'Could not save — check your connection. Your text is still on screen.')
        }
        return false
      } finally {
        inFlightRef.current = false
      }
    },
    [loc, contactId, signed],
  )

  // Background save: a drafts-only convenience. A signed note is saved explicitly, with a reason.
  useEffect(() => {
    if (!dirty || signed || saveState === 'locked' || saveState === 'saving') return
    const wait = Math.max(AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MIN_GAP_MS - (Date.now() - lastAutosaveRef.current))
    const t = window.setTimeout(() => void save({ autosave: true }), wait)
    return () => window.clearTimeout(t)
  }, [input, dirty, signed, saveState, save])

  // Never lose typed text silently.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Keep the countdown honest while the editor stays open.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => window.clearInterval(t)
  }, [])
  const liveLock: NoteLock | null = lock ? { ...lock, msRemaining: Math.max(0, lock.msRemaining - (savedAt ? Date.now() - savedAt : 0)) } : null

  // ---- moving around -----------------------------------------------------------------
  const goTo = async (next: number) => {
    if (next > 2) setShowErrors(true)
    if (dirty && !signed && saveState !== 'locked') await save({ autosave: false })
    setStep(Math.max(0, Math.min(STEPS.length - 1, next)))
    window.scrollTo?.({ top: 0 })
  }

  // ---- signing / saving a signed note ----------------------------------------------------
  const blockers = reviewChecklist(form).filter((i) => i.level === 'blocker')

  async function finish() {
    setProblem(null)
    if (signed && !changeReason.trim()) {
      setShowReasonError(true)
      return
    }
    setSigning(true)
    try {
      const ok = await save({ autosave: false, reason: signed ? changeReason.trim() : undefined })
      if (!ok) return
      if (!signed) await api.sessionNotes.sign(loc, noteIdRef.current!)
      navigate(`/contacts/${contactId}/notes/${noteIdRef.current}`, { replace: true })
    } catch (e) {
      const missing = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { missing?: string[] }).missing : undefined
      if (e instanceof ApiError && e.message === 'risk_incomplete') {
        setShowErrors(true)
        setStep(2)
        setProblem(missing?.length ? 'The risk assessment is still incomplete.' : 'The risk assessment is incomplete.')
      } else {
        setProblem(e instanceof ApiError && e.message ? `Could not sign: ${e.message}` : 'Could not sign the note.')
      }
    } finally {
      setSigning(false)
      setConfirmOpen(false)
    }
  }

  const reportModel = useMemo(
    () =>
      buildReport(fieldsFromForm(form), {
        practice,
        client: { id: contactId, name: clientName, dateOfBirth: dob },
        noteId: noteIdRef.current,
        status,
        signature: null,
        amended: null,
        addenda: [],
        preview: true,
      }),
    [form, practice, contactId, clientName, dob, status],
  )

  const risk = riskStatus(form)
  const saveLabel =
    saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : saveState === 'locked' ? 'Locked' : signed && dirty ? 'Unsaved changes' : dirty ? 'Unsaved changes' : savedAt ? `Saved ${Math.max(0, Math.round((Date.now() - savedAt) / 1000))}s ago` : noteIdRef.current ? 'Saved' : 'Not started'

  return (
    <div className="ol-scroll h-full overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-5 pb-28">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <Link to={`/contacts/${contactId}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <ArrowLeft className="h-4 w-4" /> {clientName}
          </Link>
          <h1 className="text-lg font-semibold text-slate-900">{existing ? 'Edit session note' : 'New session note'}</h1>
          {signed ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Signed</span> : <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">Draft</span>}
          {liveLock ? <LockBadge lock={liveLock} /> : <span className="text-xs text-slate-500">The 72-hour edit window starts when you first save.</span>}
        </header>

        {/* Stepper */}
        <nav aria-label="Steps" className="mb-5 flex flex-wrap gap-1.5">
          {STEPS.map((name, i) => {
            const riskWarn = i === 2 && !risk.complete
            return (
              <button
                key={name}
                type="button"
                onClick={() => void goTo(i)}
                aria-current={i === step ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  i === step ? 'bg-brand-600 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100',
                )}
              >
                <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[11px]', i === step ? 'bg-white/20' : 'bg-slate-100')}>{i + 1}</span>
                {name}
                {riskWarn ? <AlertTriangle className={cn('h-3.5 w-3.5', i === step ? 'text-amber-200' : 'text-amber-500')} aria-label="Incomplete" /> : null}
              </button>
            )
          })}
        </nav>

        {problem ? (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {saveState === 'locked' ? <Lock className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <div>
              {problem}
              {saveState === 'locked' && noteIdRef.current ? (
                <>
                  {' '}
                  <Link className="font-medium underline" to={`/contacts/${contactId}/notes/${noteIdRef.current}`}>
                    Open the report
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          {step === 0 && <ContextStep form={form} patch={patch} readOnly={readOnly} appointments={appointments} onPickAppointment={onPickAppointment} />}
          {step === 1 && <MseStep form={form} patch={patch} readOnly={readOnly} />}
          {step === 2 && <RiskStep form={form} patch={patch} readOnly={readOnly} showErrors={showErrors} previous={previousRisk} />}
          {step === 3 && <DapStep form={form} patch={patch} readOnly={readOnly} />}
          {step === 4 && <ReviewStep form={form} model={reportModel} signed={signed} changeReason={changeReason} onChangeReason={setChangeReason} showReasonError={showReasonError} />}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur lg:left-64">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <span className={cn('flex items-center gap-1.5 text-xs', saveState === 'error' ? 'text-rose-600' : 'text-slate-500')} aria-live="polite">
            {saveState === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saveState === 'saved' && !dirty ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : null}
            {saveLabel}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" disabled={step === 0} onClick={() => void goTo(step - 1)}>
              <ChevronLeft className="h-4 w-4" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" onClick={() => void goTo(step + 1)}>
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                disabled={blockers.length > 0 || signing || readOnly || (signed && !dirty)}
                title={blockers.length > 0 ? 'Complete the risk assessment to sign' : undefined}
                onClick={() => (signed ? void finish() : setConfirmOpen(true))}
              >
                {signing ? 'Saving…' : signed ? 'Save changes' : 'Sign note'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="sign-title">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 id="sign-title" className="text-base font-semibold text-slate-900">
              Sign this note?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              You are signing as <b>{operator?.name ?? operator?.email ?? 'you'}</b>.
              {liveLock && !liveLock.locked ? (
                <>
                  {' '}
                  You can still amend it for <b>{formatLockRemaining(liveLock.msRemaining).replace(' left', '')}</b>; after that the note locks permanently and can only receive addenda.
                </>
              ) : (
                <> After the 72-hour window the note locks permanently and can only receive addenda.</>
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={signing}>
                Cancel
              </Button>
              <Button onClick={() => void finish()} disabled={signing}>
                {signing ? 'Signing…' : 'Sign note'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

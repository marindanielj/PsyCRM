import { CalendarCheck2, Check, Copy, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { PageSpinner } from '../../components/ui/spinner'
import { ApiError, type CalendarSyncState, type ExternalCalendar, type FeedTitle, api } from '../../lib/api'
import { syncMessage as message } from '../../lib/calendar-sync'
import { relativeTime } from '../../lib/utils'
import { useTenant } from '../../state/location'

/** Settings → Calendar sync: see appointments on the phone, and keep personal time free. Only time blocks cross. */
export function CalendarSyncSettingsPage() {
  const { current } = useTenant()
  const loc = current?.id

  const [state, setState] = useState<CalendarSyncState | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** The feed address exists in readable form only in the response that created it. */
  const [shownUrl, setShownUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState('')

  useEffect(() => {
    if (!loc) return
    let live = true
    setState(null)
    setShownUrl(null)
    api.calendarSync
      .get(loc)
      .then((s) => live && setState(s))
      .catch((e) => {
        if (!live) return
        // The routes do not exist at all when the deployment has not turned calendar sync on.
        if (e instanceof ApiError && e.status === 404) setUnavailable(true)
        else setLoadError('Could not load calendar sync.')
      })
    return () => {
      live = false
    }
  }, [loc])

  if (unavailable) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold text-slate-900">Calendar sync</h1>
        <p className="mt-2 max-w-xl text-sm text-slate-600">Calendar sync is not turned on for this installation yet. It is switched on by whoever manages the deployment, after a short review (see the integrations guide).</p>
      </div>
    )
  }
  if (!loc || !state) return loadError ? <p role="alert" className="p-6 text-sm text-rose-700">{loadError}</p> : <PageSpinner />

  const refresh = async () => setState(await api.calendarSync.get(loc))

  async function run(fn: () => Promise<string | void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const ok = await fn()
      if (ok) setNote(ok)
    } catch (e) {
      setError(message(e instanceof ApiError ? e.message : undefined))
    } finally {
      // Also after a failure: a failed "Sync now" is recorded on the row and should show.
      await refresh().catch(() => undefined)
      setBusy(false)
    }
  }

  const feed = state.feed

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* the address is selectable in the box, so copying by hand still works */
    }
  }

  function connect(e: FormEvent) {
    e.preventDefault()
    if (!address.trim()) return
    void run(async () => {
      const r = await api.calendarSync.addCalendar(loc!, { label: label.trim() || 'My calendar', url: address.trim() })
      setAddress('')
      setLabel('')
      if (!r.sync.ok) return undefined
      return r.sync.blocks === 0 ? 'Connected. No busy time was found in the next 90 days.' : `Connected. Found ${r.sync.blocks} busy ${r.sync.blocks === 1 ? 'block' : 'blocks'} in the next 90 days.`
    })
  }

  return (
    <div className="ol-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><CalendarCheck2 className="h-5 w-5 text-slate-400" aria-hidden /> Calendar sync</h1>
        <p className="mt-1 text-sm text-slate-600">Keep your phone calendar and this agenda aware of each other, without sharing anything about your clients.</p>

        <div role="note" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <strong>Only busy times cross, never details.</strong> Your phone only learns <em>when</em> you have an appointment, under a generic title. This app only learns <em>when</em> you are busy: it discards the titles and notes of your personal events as it reads them.
        </div>

        {error && <p role="alert" className="mt-4 text-sm font-medium text-rose-600">{error}</p>}
        {note && <p role="status" className="mt-4 text-sm font-medium text-emerald-700">{note}</p>}

        {/* --- outbound ------------------------------------------------------------------------------------------ */}
        <section className="mt-8" aria-labelledby="cs-out">
          <h2 id="cs-out" className="text-base font-semibold text-slate-900">Show my appointments on my phone</h2>
          <p className="mt-1 text-sm text-slate-600">You get a private address. Add it to your phone’s calendar as a subscribed calendar and your appointments appear there as “{feed?.title ?? 'Cita'}”.</p>

          {!feed && (
            <div className="mt-3">
              <Button disabled={busy} onClick={() => void run(async () => { const r = await api.calendarSync.createFeed(loc); setShownUrl(r.url) })}>Create my calendar address</Button>
            </div>
          )}

          {shownUrl && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">Copy this address now: it is shown only once.</p>
              <div className="mt-2 flex gap-2">
                <Input readOnly aria-label="Your calendar address" value={shownUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onClick={() => void copy(shownUrl)}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}<span className="ml-1">{copied ? 'Copied' : 'Copy'}</span></Button>
              </div>
              <p className="mt-2 text-xs text-amber-900">Anyone who has this address can see when you have appointments (not with whom). If it leaks, replace it below.</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
                <li><strong>iPhone:</strong> Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, then paste the address.</li>
                <li><strong>Google Calendar:</strong> on a computer, Other calendars (+) → From URL, then paste the address.</li>
              </ul>
            </div>
          )}

          {feed && (
            <div className="mt-4 space-y-4 rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm text-slate-700">
                Your address is on. {feed.last_fetched_at ? <>Your phone last read it {relativeTime(feed.last_fetched_at)}.</> : <>Nothing has read it yet.</>}{' '}
                <span className="text-slate-500">It is not shown again; to see a new one, replace it.</span>
              </p>
              <div>
                <Label htmlFor="cs-title">Title shown on your phone</Label>
                <select id="cs-title" value={feed.title} disabled={busy} onChange={(e) => void run(async () => { await api.calendarSync.setFeedTitle(loc, e.target.value as FeedTitle); return 'Title changed.' })} className="mt-1 block rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                  {state.titles.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm('Replace the address? The old one stops working right away, and you will have to subscribe again on your phone.')) void run(async () => { const r = await api.calendarSync.createFeed(loc, true); setShownUrl(r.url) }) }}><RefreshCw className="h-4 w-4" /> Replace address</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (window.confirm('Turn the calendar address off? Your phone will stop showing these appointments.')) void run(async () => { await api.calendarSync.revokeFeed(loc); setShownUrl(null); return 'Turned off.' }) }}><Trash2 className="h-4 w-4" /> Turn off</Button>
              </div>
            </div>
          )}

          <p className="mt-3 text-xs text-slate-500">Not instant: Google can take many hours to refresh a subscribed calendar, and Apple refreshes more often. A change made here can take a while to appear on your phone.</p>
        </section>

        {/* --- inbound ------------------------------------------------------------------------------------------- */}
        <section className="mt-10" aria-labelledby="cs-in">
          <h2 id="cs-in" className="text-base font-semibold text-slate-900">Keep my personal time free</h2>
          <p className="mt-1 text-sm text-slate-600">Connect your personal calendar so the times you are busy are not offered to clients and you are warned if you book over them. The app reads it every few minutes.</p>

          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li><strong>Google:</strong> Calendar settings → your calendar → Integrate calendar → copy “Secret address in iCal format”.</li>
            <li><strong>iCloud:</strong> in the Calendar app, share the calendar, turn on Public Calendar and copy the link (it starts with webcal://).</li>
          </ul>
          <p className="mt-2 text-xs text-slate-500">That address works like a password for your calendar: it is stored encrypted and is never shown again, here or anywhere.</p>

          {state.calendars.length > 0 && (
            <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white" aria-label="Connected calendars">
              {state.calendars.map((c) => <CalendarRow key={c.id} cal={c} busy={busy} loc={loc} run={run} />)}
            </ul>
          )}

          {state.calendars.length < state.limits.maxCalendars ? (
            <form onSubmit={connect} className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                <div>
                  <Label htmlFor="cs-label">Name</Label>
                  <Input id="cs-label" value={label} maxLength={60} placeholder="Personal" onChange={(e) => setLabel(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="cs-url">Calendar address</Label>
                  <Input id="cs-url" type="password" autoComplete="off" spellCheck={false} value={address} placeholder="https://… or webcal://…" onChange={(e) => setAddress(e.target.value)} />
                </div>
              </div>
              <Button type="submit" disabled={busy || !address.trim()}>{busy ? 'Connecting…' : 'Connect calendar'}</Button>
            </form>
          ) : (
            <p className="mt-4 text-sm text-slate-500">You have connected the maximum of {state.limits.maxCalendars} calendars.</p>
          )}
        </section>
      </div>
    </div>
  )
}

function CalendarRow({ cal, busy, loc, run }: { cal: ExternalCalendar; busy: boolean; loc: string; run: (fn: () => Promise<string | void>) => Promise<void> }) {
  const status = !cal.enabled ? 'Paused' : cal.last_status === 'error' ? message(cal.last_error ?? undefined) : cal.last_synced_at ? `Read ${relativeTime(cal.last_synced_at)} · ${cal.block_count} busy ${cal.block_count === 1 ? 'block' : 'blocks'} ahead` : 'Not read yet'
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-slate-900">{cal.label} <span className="font-normal text-slate-500">· {cal.host}</span></div>
        <div className={cal.last_status === 'error' && cal.enabled ? 'text-xs text-rose-700' : 'text-xs text-slate-500'}>{status}</div>
        {cal.last_status === 'error' && cal.enabled && cal.last_synced_at && <div className="text-xs text-slate-500">Showing what was read {relativeTime(cal.last_synced_at)}.</div>}
      </div>
      <div className="flex shrink-0 gap-1">
        {cal.enabled && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => { const r = await api.calendarSync.syncCalendar(loc, cal.id); if (!r.ok) throw new ApiError(422, r.error ?? '') ; return 'Updated.' })}><RefreshCw className="h-4 w-4" /> Sync now</Button>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => { await api.calendarSync.updateCalendar(loc, cal.id, { enabled: !cal.enabled }) })}>{cal.enabled ? <><Pause className="h-4 w-4" /> Pause</> : <><Play className="h-4 w-4" /> Resume</>}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (window.confirm(`Disconnect “${cal.label}”? Its busy times stop blocking your agenda.`)) void run(async () => { await api.calendarSync.removeCalendar(loc, cal.id); return 'Disconnected.' }) }}><Trash2 className="h-4 w-4" /> Remove</Button>
      </div>
    </li>
  )
}

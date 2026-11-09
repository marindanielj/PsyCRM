import { useCallback, useEffect, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { type Inquiry, type InviteSendResult, api } from '../../lib/api'
import { DAY_LABEL, MODE_LABEL, SLOT_LABEL } from '../../lib/public-page'
import { InviteClientDialog } from './InviteClientDialog'

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Puerto_Rico', month: 'short', day: 'numeric' })
const list = (xs: string[], labels: Record<string, string>) => xs.map((x) => labels[x] ?? x).join(', ')

/**
 * Requests that came from the public page. They are not clients yet: no record, no date of birth. She reads
 * them here and invites the ones she wants to see; the person then registers through the invitation.
 */
export function InquiriesPanel({ locationId, onInvited }: { locationId: string; onInvited: () => void }) {
  const [items, setItems] = useState<Inquiry[]>([])
  const [showHandled, setShowHandled] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviting, setInviting] = useState<Inquiry | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems((await api.inquiries.list(locationId)).inquiries)
    } catch {
      /* the panel is a convenience; the contact list keeps working */
    }
  }, [locationId])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  const open = items.filter((i) => i.status !== 'handled')
  const handled = items.filter((i) => i.status === 'handled')
  if (open.length === 0 && handled.length === 0) return null

  async function act(id: string, fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(id)
    setError(null)
    try {
      await fn()
      await load()
    } catch {
      setError('That did not work. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  const row = (i: Inquiry) => (
    <li key={i.id} className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{i.name}</span>
        {i.status === 'new' ? <Badge variant="amber">New</Badge> : i.status === 'invited' ? <Badge variant="blue">Invited</Badge> : <Badge variant="slate">Handled</Badge>}
      </div>
      <p className="mt-0.5 text-xs text-slate-600">
        {MODE_LABEL[i.mode]} · {list(i.days, DAY_LABEL)} · {list(i.slots, SLOT_LABEL)}{i.who === 'minor' ? ' · for a minor' : ''}{i.insurance ? ` · ${i.insurance}` : ''}
      </p>
      <p className="truncate text-xs text-slate-500">
        <a className="underline" href={`mailto:${i.email}`}>{i.email}</a>{i.phone ? <> · <a className="underline" href={`tel:${i.phone}`}>{i.phone}</a></> : null} · {fmt(i.createdAt)}
      </p>
      {i.message ? <p className="mt-1 text-xs italic text-slate-600">“{i.message}”</p> : null}
      {i.acknowledged.length > 0 ? (
        <details className="mt-1 text-xs text-slate-500">
          <summary className="cursor-pointer">Confirmed {i.acknowledged.length} statements</summary>
          <ul className="mt-1 list-disc pl-4">{i.acknowledged.map((a) => <li key={a}>{a}</li>)}</ul>
        </details>
      ) : null}
      {confirm === i.id ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-rose-700">Delete this request for good?</span>
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void act(i.id, async () => { await api.inquiries.remove(locationId, i.id); setConfirm(null) })}>Delete</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Keep</Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {i.status !== 'invited' && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setInviting(i)}>Invite</Button>}
          {i.status === 'handled'
            ? <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(i.id, () => api.inquiries.setHandled(locationId, i.id, false))}>Reopen</Button>
            : <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(i.id, () => api.inquiries.setHandled(locationId, i.id, true))}>Handled</Button>}
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm(i.id)}>Delete</Button>
        </div>
      )}
    </li>
  )

  return (
    <section aria-label="Requests from your public page" className="border-b border-slate-100 bg-amber-50/40 p-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Requests · {open.length}</h2>
      {error && <p role="alert" className="mb-2 text-xs font-medium text-rose-600">{error}</p>}
      {open.length === 0 ? <p className="text-xs text-slate-500">Nothing waiting.</p> : <ul className="space-y-2">{open.map(row)}</ul>}
      {handled.length > 0 && (
        <div className="mt-2">
          <button type="button" className="text-xs text-slate-500 underline" onClick={() => setShowHandled((v) => !v)}>{showHandled ? 'Hide' : 'Show'} handled ({handled.length})</button>
          {showHandled && <ul className="mt-2 space-y-2">{handled.map(row)}</ul>}
        </div>
      )}
      {inviting && (
        <InviteClientDialog
          locationId={locationId}
          initial={{ name: inviting.name, email: inviting.email, kind: inviting.who === 'minor' ? 'guardian' : 'adult' }}
          onClose={() => setInviting(null)}
          onSent={(r: InviteSendResult) => {
            const id = inviting.id
            void api.inquiries.markInvited(locationId, id, r.invite.id).then(() => { void load(); onInvited() }).catch(() => setError('The invitation was sent, but the request was not marked as invited.'))
          }}
        />
      )}
    </section>
  )
}

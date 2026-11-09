import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { type ClientInvite, type InviteSendResult, api } from '../../lib/api'
import { brandName } from '../../lib/brand'
import { inviteMessage } from '../../lib/link-messages'
import { useTenant } from '../../state/location'
import { CopyLink } from '../documents/SendPacketDialog'

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Puerto_Rico', month: 'short', day: 'numeric' })

/** Invitations still waiting for the client (or expired), with Resend and Cancel. A finished one turns into a contact. */
export function InvitationsPanel({ locationId, refreshKey, onCompleted }: { locationId: string; refreshKey: number; onCompleted: () => void }) {
  const [invites, setInvites] = useState<ClientInvite[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [link, setLink] = useState<{ id: string; res: InviteSendResult; copyOnly: boolean } | null>(null)
  const { current } = useTenant()
  const [error, setError] = useState<string | null>(null)
  const seenCompleted = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.invites.list(locationId)
      setInvites(r.invites)
      // A registration finished since last time: the new client should appear in the list.
      const done = r.invites.filter((i) => i.status === 'completed').length
      if (seenCompleted.current !== null && done > seenCompleted.current) onCompleted()
      seenCompleted.current = done
    } catch {
      /* the panel is a convenience; the contact list keeps working */
    }
  }, [locationId, onCompleted])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [load, refreshKey])

  const waiting = invites.filter((i) => i.status === 'sent' || i.status === 'expired')
  if (waiting.length === 0) return null

  async function act(id: string, fn: () => Promise<void>) {
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

  return (
    <section aria-label="Pending invitations" className="border-b border-slate-100 bg-slate-50 p-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Invitations · {waiting.length}</h2>
      {error && <p role="alert" className="mb-2 text-xs font-medium text-rose-600">{error}</p>}
      <ul className="space-y-2">
        {waiting.map((i) => (
          <li key={i.id} className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{i.name}</span>
              {i.status === 'expired' ? <Badge variant="slate">Expired</Badge> : i.openedAt ? <Badge variant="blue">Opened</Badge> : <Badge variant="amber">Sent</Badge>}
            </div>
            <p className="truncate text-xs text-slate-500">{i.email} · {i.kind === 'guardian' ? 'parent/guardian' : 'adult'} · {i.status === 'expired' ? `expired ${fmt(i.expiresAt)}` : `expires ${fmt(i.expiresAt)}`}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(i.id, async () => setLink({ id: i.id, res: await api.invites.resend(locationId, i.id, 'none'), copyOnly: true }))}>Copy link</Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(i.id, async () => setLink({ id: i.id, res: await api.invites.resend(locationId, i.id), copyOnly: false }))}>Resend</Button>
              {i.status === 'sent' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(i.id, async () => { await api.invites.void(locationId, i.id) })}>Cancel</Button>}
            </div>
            {link?.id === i.id && (
              <div className="mt-2 text-xs">
                {link.copyOnly ? <p className="text-slate-600">New link ready; nothing was emailed. The old one no longer works.</p> : link.res.emailed ? <p className="text-emerald-700">A new link was emailed. The old one no longer works.</p> : <p className="text-amber-700">Email not configured ({link.res.emailIssue}). Copy the new link.</p>}
                <CopyLink link={link.res.link} message={inviteMessage({ practice: brandName(current), name: i.name, link: link.res.link })} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

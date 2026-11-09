import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { ApiError, type InviteSendResult, api } from '../../lib/api'
import { brandName } from '../../lib/brand'
import { inviteMessage } from '../../lib/link-messages'
import { useTenant } from '../../state/location'
import { CopyLink } from '../documents/SendPacketDialog'

/**
 * Invite a client: the therapist types a name and an email and the person fills in the rest on
 * their own page. No contact exists until they do, so every record starts with a date of birth.
 */
export function InviteClientDialog({ locationId, onClose, onSent }: { locationId: string; onClose: () => void; onSent: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [kind, setKind] = useState<'adult' | 'guardian'>('adult')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<InviteSendResult | null>(null)
  const { current } = useTenant()

  const ready = name.trim().length > 0 && /.+@.+\..+/.test(email.trim())

  async function send() {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      setSent(await api.invites.create(locationId, { name: name.trim(), email: email.trim(), kind }))
      onSent()
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | undefined) : undefined
      setError(body?.error === 'already_invited' ? 'This email already has an open invitation. Use Resend in the list.' : 'Could not send the invitation. Check the email and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Invite client" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {sent ? (
          <>
            <h2 className="text-base font-semibold text-slate-900">Invitation sent</h2>
            {sent.emailed ? (
              <p className="mt-2 text-sm text-emerald-700">Emailed to {sent.invite.email}. When they finish, the client record is created and the documents go out by themselves.</p>
            ) : (
              <p className="mt-2 text-sm text-amber-700">Email not configured ({sent.emailIssue}). Copy the link and send it yourself.</p>
            )}
            <CopyLink link={sent.link} message={inviteMessage({ practice: brandName(current), name: sent.invite.name, link: sent.link })} />
            <p className="mt-2 text-xs text-slate-500">The link works once and expires in 14 days. It is shown only now; “Copy link” in the list makes a new one. “Copy message” gives you the text ready to paste into WhatsApp or a text.</p>
            <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-slate-900">Invite client</h2>
            <p className="mt-1 text-sm text-slate-600">They get a link to enter their own details. You only need a name and an email.</p>
            <div className="mt-4 space-y-3">
              <div>
                <Label htmlFor="inv-name">Name</Label>
                <Input id="inv-name" autoFocus value={name} maxLength={120} placeholder="Full name" onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="inv-email">Email</Label>
                <Input id="inv-email" type="email" value={email} maxLength={200} placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} />
              </div>
              <fieldset>
                <legend className="mb-1 text-sm font-medium text-slate-800">Who fills it in?</legend>
                <label className="flex items-start gap-2 py-1 text-sm text-slate-700">
                  <input type="radio" name="inv-kind" checked={kind === 'adult'} onChange={() => setKind('adult')} className="mt-0.5" />
                  <span><span className="font-medium">The client</span> <span className="text-slate-500">(18 or older)</span></span>
                </label>
                <label className="flex items-start gap-2 py-1 text-sm text-slate-700">
                  <input type="radio" name="inv-kind" checked={kind === 'guardian'} onChange={() => setKind('guardian')} className="mt-0.5" />
                  <span><span className="font-medium">A parent or guardian</span> <span className="text-slate-500">(the client is under 18)</span></span>
                </label>
              </fieldset>
            </div>
            {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button onClick={() => void send()} disabled={!ready || busy}>{busy ? 'Sending…' : 'Send invitation'}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

import { Mail } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import { Modal, apiMessage } from './BillingDialogs'

/**
 * Email an invoice or receipt to the client. Only an address already on the client's record can be used. The email carries a
 * link, not the document: the client opens it with a code sent to that same address.
 */
export function SendDocumentDialog({ loc, kind, documentId, contactId, clientName, onClose }: {
  loc: string
  kind: 'invoice' | 'receipt'
  documentId: string
  contactId: string
  clientName: string
  onClose: () => void
}) {
  const noun = kind === 'invoice' ? 'invoice' : 'receipt'
  const [emails, setEmails] = useState<string[] | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .contact(loc, contactId)
      .then((r) => {
        if (!live) return
        const list = r.contact.emails.filter(Boolean)
        setEmails(list)
        setEmail(list[0] ?? '')
      })
      .catch(() => live && setError('The client’s record could not be loaded.'))
    return () => {
      live = false
    }
  }, [loc, contactId])

  async function send() {
    setBusy(true)
    setError(null)
    try {
      if (kind === 'invoice') await api.billing.sendInvoice(loc, documentId, email)
      else await api.billing.sendReceipt(loc, documentId, email)
      setSentTo(email)
    } catch (e) {
      setError(apiMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Email this ${noun}`} onClose={onClose}>
      {sentTo ? (
        <>
          <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Sent to {sentTo}.</p>
          <p className="mt-2 text-xs text-slate-500">{clientName} gets a link, and opens the {noun} with a code sent to that same address. The link works for 30 days, and stops working if the {noun} is voided.</p>
          <div className="mt-5 flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-slate-600">The email has only a link, with no amounts or details. {clientName} verifies with a code sent to the same address, then can read it and save it as a PDF.</p>
          {emails === null && !error && <p className="mt-3 text-sm text-slate-400">Loading…</p>}
          {emails !== null && emails.length === 0 && (
            <p role="note" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">This client has no email address on their record. Add one in their record, then try again.</p>
          )}
          {emails !== null && emails.length > 0 && (
            <div className="mt-3">
              <label htmlFor="send-to" className="mb-1 block text-sm font-medium text-slate-700">Send to</label>
              <select id="send-to" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                {emails.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="button" disabled={busy || !email} onClick={() => void send()}><Mail className="h-4 w-4" /> {busy ? 'Sending…' : 'Send email'}</Button>
          </div>
        </>
      )}
    </Modal>
  )
}

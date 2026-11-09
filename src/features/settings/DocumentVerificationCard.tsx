import { useEffect, useState } from 'react'
import { resetTherapistCodes } from '../documents/useTherapistCodes'
import { api } from '../../lib/api'

/**
 * Settings → Practice: whether the therapist may give a client a verification code herself.
 * Off by default. The documents ask for a code; normally it is emailed. With this on, she can ask for a
 * code in the app and read it out, so the flow does not stop while email is unavailable.
 */
export function DocumentVerificationCard({ locationId }: { locationId: string }) {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.documents.verification(locationId).then((r) => live && setOn(r.therapistCode)).catch(() => live && setError('Could not load this setting.'))
    return () => { live = false }
  }, [locationId])

  async function toggle(next: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setOn((await api.documents.setVerification(locationId, next)).therapistCode)
      resetTherapistCodes()
    } catch {
      setError('Could not save the change. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="dv-title">
      <h2 id="dv-title" className="text-sm font-semibold text-slate-900">Verification codes for documents</h2>
      <p className="mt-1 text-xs text-slate-500">
        To open their documents, a client enters a 6-digit code. Normally it is emailed to them.
      </p>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-slate-300"
          checked={on === true}
          disabled={on === null || busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>
          Let me give a client the code myself (by phone or in person)
          <span className="mt-1 block text-xs text-slate-500">
            Use it while email to clients is not working. It is weaker than the emailed code: it no longer proves the person controls that email address, it relies on you knowing who you are speaking with. Each document signed this way says so, and every code you give is recorded in the audit log. Give the code through a different channel than the link. It expires in 30 minutes.
          </span>
        </span>
      </label>
      {error && <p role="alert" className="mt-2 text-xs font-medium text-rose-600">{error}</p>}
    </section>
  )
}

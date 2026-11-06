import { UserPlus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { ApiError } from '../../lib/api'

/**
 * Add a contact by hand (the Contacts header button). The operator types any of
 * name / phone / email; at least one is required — the submit stays disabled
 * until then, and the server rejects an all-blank body anyway.
 *
 * Adding a phone (or email) that already belongs to a contact lands on THAT
 * record instead of making a duplicate, so the copy says "Add contact", never
 * "created": the page just navigates to whichever record came back, which is
 * honest whether the save inserted a new row or matched an existing one.
 */
export function AddContactDialog({
  onCancel,
  onCreate,
  requireDateOfBirth = true,
}: {
  onCancel: () => void
  /** Saves the contact; the page owns navigating to the result. */
  onCreate: (input: { name?: string; phone?: string; email?: string; dateOfBirth?: string }) => Promise<void>
  /** The onboarding packet is chosen by age, so a date of birth is mandatory (default). */
  requireDateOfBirth?: boolean
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [dob, setDob] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasInput = Boolean(name.trim() || phone.trim() || email.trim())
  const ready = hasInput && (!requireDateOfBirth || Boolean(dob))
  // Latest selectable day: today (local). A birth date cannot be in the future.
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)

  async function save() {
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    try {
      await onCreate({
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        dateOfBirth: dob || undefined,
      })
    } catch (e) {
      setError(e instanceof ApiError && e.message ? e.message : 'Could not add the contact.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl"
      >
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">Add contact</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Enter a name, phone, or email. A phone that already belongs to a contact opens that
            record instead of making a duplicate.
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <Label htmlFor="add-name">Name</Label>
            <Input
              id="add-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
            />
          </div>
          <div>
            <Label htmlFor="add-phone">Phone</Label>
            <Input
              id="add-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 555-0142"
              inputMode="tel"
            />
          </div>
          <div>
            <Label htmlFor="add-email">Email</Label>
            <Input
              id="add-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              inputMode="email"
            />
          </div>
          {requireDateOfBirth ? (
            <div>
              <Label htmlFor="add-dob">Date of birth</Label>
              <Input
                id="add-dob"
                type="date"
                value={dob}
                max={today}
                onChange={(e) => setDob(e.target.value)}
                required
              />
              <p className="mt-1 text-xs text-slate-500">
                Needed to send the right onboarding documents (adult or minor).
              </p>
            </div>
          ) : null}
          {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!ready || saving}
            onClick={() => void save()}
          >
            <UserPlus className="h-4 w-4" />
            {saving ? 'Adding…' : 'Add contact'}
          </Button>
        </div>
      </div>
    </div>
  )
}

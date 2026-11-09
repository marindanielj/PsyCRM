import { type FormEvent, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { ApiError, api } from '../../lib/api'
import { useAuth } from '../../state/auth'

const MIN = 12
const MAX = 128

/** Turns what the server says into something a person can act on. */
export function passwordProblem(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your current password is not correct.'
    if (err.status === 429) return 'Too many attempts. Wait a few minutes and try again.'
    if (err.status === 400 && err.message === 'same password') return 'Choose a password different from the current one.'
    if (err.status === 400) return `The new password must be between ${MIN} and ${MAX} characters and cannot be your email.`
  }
  return 'Could not change the password. Try again.'
}

/** Settings → Account: the signed-in person's own sign-in. */
export function AccountSettingsPage() {
  const { operator, passwordChangedAt, markPasswordChanged } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const tooShort = next.length > 0 && next.length < MIN
  const mismatch = again.length > 0 && next !== again
  const ready = current.length > 0 && next.length >= MIN && next.length <= MAX && next === again && !busy

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await api.changePassword(current, next)
      setCurrent('')
      setNext('')
      setAgain('')
      setDone(true)
      markPasswordChanged()
    } catch (err) {
      setError(passwordProblem(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ol-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <h1 className="text-xl font-semibold text-slate-900">Account</h1>
        <p className="mt-1 text-sm text-slate-500">
          Signed in as <span className="font-medium text-slate-700">{operator?.email}</span>
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="pw-title">
          <div>
            <h2 id="pw-title" className="text-base font-semibold text-slate-900">Change your password</h2>
            <p className="mt-1 text-xs text-slate-500">
              {passwordChangedAt === null
                ? 'You are still using the password this account was created with. Choose your own.'
                : 'Choose a new password. Other devices where you are signed in will be signed out.'}
            </p>
          </div>

          <div>
            <Label htmlFor="pw-current">Current password</Label>
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setError(null) }} />
          </div>

          <div>
            <Label htmlFor="pw-new">New password</Label>
            <Input id="pw-new" type="password" autoComplete="new-password" value={next} maxLength={MAX} aria-describedby="pw-hint" onChange={(e) => { setNext(e.target.value); setError(null) }} />
            <p id="pw-hint" className={`mt-1 text-xs ${tooShort ? 'font-medium text-rose-600' : 'text-slate-500'}`}>
              At least {MIN} characters. Four unrelated words is easy to remember and hard to guess.
            </p>
          </div>

          <div>
            <Label htmlFor="pw-again">Repeat the new password</Label>
            <Input id="pw-again" type="password" autoComplete="new-password" value={again} maxLength={MAX} onChange={(e) => { setAgain(e.target.value); setError(null) }} />
            {mismatch && <p role="alert" className="mt-1 text-xs font-medium text-rose-600">The two passwords do not match.</p>}
          </div>

          {error && <p role="alert" className="text-sm font-medium text-rose-700">{error}</p>}
          {done && (
            <p role="status" className="text-sm font-medium text-emerald-700">
              Password changed. You stay signed in here; other devices were signed out.
            </p>
          )}

          <Button type="submit" disabled={!ready}>{busy ? 'Saving…' : 'Change password'}</Button>
        </form>
      </div>
    </div>
  )
}

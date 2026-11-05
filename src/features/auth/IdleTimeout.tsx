import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button'
import { api } from '../../lib/api'
import { useAuth } from '../../state/auth'

/** Must match the server's IDLE_TTL_MS (server/lib/session.ts). */
export const IDLE_LIMIT_MS = 30 * 60_000
/** Show the "still there?" prompt this long before signing out. */
export const WARN_BEFORE_MS = 5 * 60_000
/** While the user is active, touch the API at most this often so the server's own
 *  idle window keeps sliding even on screens that make no API calls. */
const KEEPALIVE_MS = 4 * 60_000
const TICK_MS = 5_000
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Signs the operator out after IDLE_LIMIT_MS without any interaction, warning for
 * the last WARN_BEFORE_MS. Mount once inside the authenticated shell. Clinical
 * data is on screen, so an unattended laptop must not stay signed in. All timing
 * uses Date.now() (not counting ticks) so a throttled background tab or a laptop
 * that slept still signs out on time.
 */
export function IdleTimeout() {
  const { logout } = useAuth()
  const lastActivity = useRef(Date.now())
  const lastPing = useRef(Date.now())
  const [remainingMs, setRemainingMs] = useState<number | null>(null)

  const stay = useCallback(() => {
    lastActivity.current = Date.now()
    lastPing.current = Date.now()
    setRemainingMs(null)
    // A 401 here is handled globally (api.ts), which signs the user out.
    void api.me().catch(() => {})
  }, [])

  useEffect(() => {
    const onActivity = () => {
      // Once the warning is up, only the explicit button counts: stray scrolling
      // must not silently cancel a sign-out the user has not acknowledged.
      if (Date.now() - lastActivity.current < IDLE_LIMIT_MS - WARN_BEFORE_MS) lastActivity.current = Date.now()
    }
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true, capture: true })

    const timer = window.setInterval(() => {
      const now = Date.now()
      const idle = now - lastActivity.current
      if (idle >= IDLE_LIMIT_MS) {
        window.clearInterval(timer)
        void logout()
        return
      }
      if (idle >= IDLE_LIMIT_MS - WARN_BEFORE_MS) {
        setRemainingMs(IDLE_LIMIT_MS - idle)
        return
      }
      setRemainingMs(null)
      if (now - lastPing.current >= KEEPALIVE_MS && idle < KEEPALIVE_MS) {
        lastPing.current = now
        void api.me().catch(() => {})
      }
    }, TICK_MS)

    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, { capture: true })
      window.clearInterval(timer)
    }
  }, [logout])

  if (remainingMs === null) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 id="idle-title" className="text-base font-semibold text-slate-900">
          Still there?
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          For the privacy of your clients' information you'll be signed out in{' '}
          <span className="font-semibold tabular-nums text-slate-900">{formatCountdown(remainingMs)}</span>.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => void logout()}>
            Sign out now
          </Button>
          <Button onClick={stay}>Stay signed in</Button>
        </div>
      </div>
    </div>
  )
}

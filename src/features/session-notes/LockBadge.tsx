import { Lock, Timer } from 'lucide-react'
import type { NoteLock } from '../../lib/api'
import { cn } from '../../lib/utils'
import { formatLockRemaining, lockTone } from './note-utils'

/** "Unsigned draft" (no clock yet) / "Editable · 2d 14h left" / amber under 24 h / "Locked 🔒". */
export function LockBadge({ lock, className }: { lock: NoteLock; className?: string }) {
  if (lock.msRemaining === null && !lock.locked) {
    return (
      <span title="A draft stays editable until it is signed. The 72-hour editing window starts at the signature." className={cn('inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700', className)}>
        <Timer className="h-3 w-3" />
        Unsigned draft
      </span>
    )
  }
  const tone = lockTone(lock.msRemaining ?? 0)
  const text = tone === 'locked' ? 'Locked' : `Editable · ${formatLockRemaining(lock.msRemaining ?? 0)}`
  return (
    <span
      title="A signed note can be amended for 72 hours after it is signed. After that it is locked permanently; you can still add an addendum."
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'locked' && 'bg-slate-200 text-slate-700',
        tone === 'soon' && 'bg-amber-50 text-amber-800 ring-1 ring-amber-300',
        tone === 'open' && 'bg-emerald-50 text-emerald-700',
        className,
      )}
    >
      {tone === 'locked' ? <Lock className="h-3 w-3" /> : <Timer className="h-3 w-3" />}
      {text}
    </span>
  )
}

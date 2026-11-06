import { Lock, Timer } from 'lucide-react'
import type { NoteLock } from '../../lib/api'
import { cn } from '../../lib/utils'
import { formatLockRemaining, lockTone } from './note-utils'

/** "Editable · 2d 14h left" / amber under 24 h / "Locked 🔒". */
export function LockBadge({ lock, className }: { lock: NoteLock; className?: string }) {
  const tone = lockTone(lock.msRemaining)
  const text = tone === 'locked' ? 'Locked' : `Editable · ${formatLockRemaining(lock.msRemaining)}`
  return (
    <span
      title="Notes can be edited for 72 hours after they are created. After that they are locked permanently; you can still add an addendum."
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

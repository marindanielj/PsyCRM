import { Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'
import { formatMoneyExact } from '../../lib/utils'
import { useTenant } from '../../state/location'

/** What a client owes, for the header of their record. Shown only when something is owed, so a settled client has no extra noise. */
export function ClientBalanceBadge({ contactId, refreshKey }: { contactId: string; refreshKey?: unknown }) {
  const { current } = useTenant()
  const loc = current?.id
  const on = moduleEnabled(current, 'billing')
  const [cents, setCents] = useState(0)

  useEffect(() => {
    if (!loc || !on) return
    let active = true
    api.billing
      .balance(loc, contactId)
      .then((r) => active && setCents(r.balanceCents))
      .catch(() => active && setCents(0))
    return () => {
      active = false
    }
  }, [loc, on, contactId, refreshKey])

  if (!on || cents <= 0) return null
  return (
    <Link
      to={`/billing?client=${encodeURIComponent(contactId)}`}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100"
    >
      <Wallet className="h-3.5 w-3.5" />
      Balance {formatMoneyExact(cents)}
    </Link>
  )
}

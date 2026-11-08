import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'
import { cn } from '../../lib/utils'
import { useTenant } from '../../state/location'
import { formatSessionDate, riskStyle } from './note-utils'

/** The pill itself (no data fetching): a level, or "No risk assessment yet". */
export function RiskPill({ level, date, className }: { level: string | null | undefined; date?: string | null; className?: string }) {
  const style = riskStyle(level)
  const elevated = level === 'moderate' || level === 'high' || level === 'imminent'
  const Icon = elevated ? ShieldAlert : ShieldCheck
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1', style.badge, className)}>
      <Icon className="h-3.5 w-3.5" />
      {level ? `Risk: ${style.label}` : 'No risk assessment yet'}
      {level && date ? <span className="font-normal opacity-80">· {formatSessionDate(date)}</span> : null}
    </span>
  )
}

/** A client's current risk (their latest signed note), for the header of their record. */
export function ClientRiskBadge({ contactId, refreshKey }: { contactId: string; refreshKey?: unknown }) {
  const { current } = useTenant()
  const loc = current?.id
  const [risk, setRisk] = useState<{ risk_level: string; session_date: string } | null | undefined>(undefined)

  useEffect(() => {
    if (!loc || !moduleEnabled(current, 'session_notes')) return
    let active = true
    api
      .sessionNotes.latestRisk(loc, contactId)
      .then((r) => active && setRisk(r.risk))
      .catch(() => active && setRisk(undefined))
    return () => {
      active = false
    }
  }, [loc, contactId, current, refreshKey])

  if (!moduleEnabled(current, 'session_notes') || risk === undefined) return null
  return <RiskPill level={risk?.risk_level} date={risk?.session_date} />
}

import { ClipboardList } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { type IntakeStatus, api } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'
import { useTenant } from '../../state/location'

/**
 * "Intake pendiente" in the header of a new client's record, until their intake note is signed. A client who already has
 * signed notes (from before the intake form existed) gets no flag. A draft says so and opens it.
 */
export function IntakeBadge({ contactId }: { contactId: string }) {
  const { current } = useTenant()
  const loc = current?.id
  const on = moduleEnabled(current, 'session_notes')
  const [status, setStatus] = useState<IntakeStatus | null>(null)

  useEffect(() => {
    if (!loc || !on) return
    let active = true
    api.sessionNotes
      .intake(loc, contactId)
      .then((r) => active && setStatus(r.intake))
      .catch(() => active && setStatus(null))
    return () => {
      active = false
    }
  }, [loc, on, contactId])

  if (!on || !status) return null
  const style = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1'
  if (status.status === 'draft' && status.noteId) {
    return (
      <Link to={`/contacts/${contactId}/notes/${status.noteId}/edit`} className={`${style} bg-sky-50 text-sky-800 ring-sky-200 hover:bg-sky-100`}>
        <ClipboardList className="h-3.5 w-3.5" /> Intake en borrador
      </Link>
    )
  }
  if (status.status === 'none' && status.otherSignedNotes === 0) {
    return (
      <Link to={`/contacts/${contactId}/notes/new?type=intake`} className={`${style} bg-violet-50 text-violet-800 ring-violet-200 hover:bg-violet-100`}>
        <ClipboardList className="h-3.5 w-3.5" /> Intake pendiente
      </Link>
    )
  }
  return null
}

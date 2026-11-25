import { Video } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { type Appointment, api } from '../../lib/api'
import { brandName } from '../../lib/brand'
import { videoMessage } from '../../lib/link-messages'
import { useTenant } from '../../state/location'

/** Join video (opens the room in a new tab) and Copy message (the ready-to-paste text with the client's link). */
export function VideoActions({ loc, appt, contactName }: { loc: string; appt: Appointment; contactName?: string }) {
  const { current } = useTenant()
  const [note, setNote] = useState<string | null>(null)

  async function copyMessage() {
    try {
      const { video } = await api.appointmentVideo(loc, appt.id)
      const link = new URL(video.link, window.location.origin).href
      await navigator.clipboard.writeText(videoMessage({ practice: brandName(current), name: contactName ?? '', link, startsAt: appt.starts_at }))
      setNote('Message copied')
    } catch {
      setNote('Could not copy')
    }
    window.setTimeout(() => setNote(null), 1600)
  }

  return (
    <>
      <Button size="sm" onClick={() => window.open(`/api/loc/${loc}/video/appointments/${appt.id}/room`, '_blank', 'noopener')}>
        <Video className="h-3.5 w-3.5" /> Join video
      </Button>
      <Button size="sm" variant="outline" onClick={() => void copyMessage()}>
        {note ?? 'Copy message'}
      </Button>
    </>
  )
}

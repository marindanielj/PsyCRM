import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

// Every packet card asks the same question; ask once and remember it for a short while.
const cache = new Map<string, { at: number; value: Promise<boolean> }>()
const TTL_MS = 30_000

/** Forget the answer (Settings calls it after the switch is flipped). */
export function resetTherapistCodes(): void {
  cache.clear()
}

/** Whether this practice lets the therapist give clients a verification code herself (off by default). */
export function useTherapistCodes(locationId: string): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    const hit = cache.get(locationId)
    const value = hit && Date.now() - hit.at < TTL_MS ? hit.value : api.documents.verification(locationId).then((r) => r.therapistCode).catch(() => false)
    if (!hit || value !== hit.value) cache.set(locationId, { at: Date.now(), value })
    void value.then((v) => live && setOn(v))
    return () => { live = false }
  }, [locationId])
  return on
}

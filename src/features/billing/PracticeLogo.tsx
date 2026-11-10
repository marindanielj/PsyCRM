import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

/**
 * The practice's logo (the one set in Settings → Branding) for the top of a billing document, or nothing at all when none
 * was uploaded, so a practice without a logo gets exactly the document it had before. It is a letterhead, not part of what
 * was issued: it is read when the page is shown, so a new logo appears on older documents when they are reprinted.
 */
export function PracticeLogo({ loc }: { loc: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.branding
      .get(loc)
      .then((r) => live && setUrl(r.branding.logoUrl))
      .catch(() => undefined) // no logo is a perfectly good document
    return () => {
      live = false
    }
  }, [loc])
  if (!url) return null
  // Decorative: the practice's name is printed right beside it.
  return <img src={url} alt="" className="h-16 w-auto max-w-[11rem] shrink-0 object-contain" />
}

import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { type SignedDoc, api } from '../../lib/api'

/** A signed document exactly as it was signed: read-only, in a frame that cannot run scripts. Opening it is audited. */
export function SignedDocumentViewer({ locationId, id, onClose }: { locationId: string; id: string; onClose: () => void }) {
  const [doc, setDoc] = useState<SignedDoc | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api.documents.signed(locationId, id).then((r) => live && setDoc(r.document)).catch(() => live && setFailed(true))
    return () => { live = false }
  }, [locationId, id])

  function print() {
    if (!doc) return
    // A separate page of the same document: printing an iframe prints the wrong thing.
    const url = URL.createObjectURL(new Blob([doc.renderedHtml], { type: 'text/html' }))
    const w = window.open(url, '_blank')
    if (w) w.addEventListener('load', () => { w.print(); setTimeout(() => URL.revokeObjectURL(url), 60_000) })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Signed document" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {failed ? <p className="text-sm text-rose-700">Could not open this document.</p> : !doc ? <p className="text-sm text-slate-500">Loading…</p> : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900">{doc.templateTitle} <span className="font-normal text-slate-500">· v{doc.templateVersion}</span></h2>
              <Button size="sm" variant="outline" onClick={print}>Print</Button>
              <Button size="sm" onClick={onClose}>Close</Button>
            </div>
            <p className="mb-2 text-xs text-slate-500">
              Signed by {doc.signerName} · IP {doc.signerIp} · {doc.verifiedVia === 'therapist_code' ? <span className="font-medium text-amber-700">verified with a code given by the therapist</span> : <span>verified by emailed code</span>} · {doc.intact ? <span className="text-emerald-700">record intact</span> : <span className="font-semibold text-rose-700">record does NOT match its fingerprint</span>} · SHA-256 <span className="font-mono">{doc.contentSha256.slice(0, 16)}…</span>
            </p>
            <iframe title="Signed document" sandbox="" srcDoc={doc.renderedHtml} className="min-h-[50vh] w-full flex-1 rounded-lg border border-slate-200" />
          </>
        )}
      </div>
    </div>
  )
}

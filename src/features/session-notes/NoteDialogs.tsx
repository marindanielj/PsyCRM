import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { ApiError } from '../../lib/api'

function Shell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="ol-noprint fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** A text prompt with a mandatory answer (an addendum, a deletion reason). */
function TextPrompt({
  title, intro, label, placeholder, confirmLabel, danger, onSubmit, onClose,
}: {
  title: string
  intro: string
  label: string
  placeholder: string
  confirmLabel: string
  danger?: boolean
  onSubmit: (text: string) => Promise<void>
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit() {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text.trim())
    } catch (e) {
      setError(e instanceof ApiError && e.message ? friendly(e.message) : 'Something went wrong. Try again.')
      setBusy(false)
    }
  }
  return (
    <Shell title={title} onClose={onClose}>
      <p className="mt-1 text-sm text-slate-600">{intro}</p>
      <div className="mt-4">
        <Label htmlFor="prompt-text">{label}</Label>
        <Textarea id="prompt-text" rows={5} autoFocus value={text} placeholder={placeholder} maxLength={10_000} onChange={(e) => setText(e.target.value)} />
      </div>
      {error ? <p className="mt-2 text-xs font-medium text-rose-600">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'brand'} onClick={() => void submit()} disabled={!text.trim() || busy}>
          {busy ? 'Saving…' : confirmLabel}
        </Button>
      </div>
    </Shell>
  )
}

const friendly = (code: string) =>
  ({
    note_locked: 'The 72-hour window has closed, so this note can no longer be deleted.',
    note_deleted: 'This note has already been deleted.',
  })[code] ?? code

/** After the 72 h window (or any time) a note is added to, never rewritten. */
export function AddendumDialog({ onSubmit, onClose }: { onSubmit: (body: string) => Promise<void>; onClose: () => void }) {
  return (
    <TextPrompt
      title="Add an addendum"
      intro="The original note is not changed. Your addendum is added below it with your name and the date, and stays on the record permanently."
      label="Addendum"
      placeholder="For example: the client asked to correct the date of the incident to March."
      confirmLabel="Add addendum"
      onSubmit={onSubmit}
      onClose={onClose}
    />
  )
}

/** Deleting is only possible during the 72 h window, and always with a reason. */
export function DeleteNoteDialog({ onSubmit, onClose }: { onSubmit: (reason: string) => Promise<void>; onClose: () => void }) {
  return (
    <TextPrompt
      title="Delete this note?"
      intro="The note disappears from the client’s record, but it is never destroyed: it is kept, with your reason, in the audit history. This is only possible during the 72-hour editing window."
      label="Reason for deleting (required)"
      placeholder="For example: entered on the wrong client."
      confirmLabel="Delete note"
      danger
      onSubmit={onSubmit}
      onClose={onClose}
    />
  )
}

import { ArrowLeft, History, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { PageSpinner } from '../../components/ui/spinner'
import { ApiError, type Contact, type DocMeta, type DocTemplate, type SignerRole, api } from '../../lib/api'
import { useTenant } from '../../state/location'
import { FieldBuilder } from './FieldBuilder'
import { PreviewFrame } from './PreviewFrame'

const ROLE_LABELS: Record<SignerRole, string> = { client: 'Client', guardian: 'Parent / guardian', minor: 'Minor (assent)' }
export const STATUS_VARIANT = { draft: 'amber', active: 'green', retired: 'slate' } as const

type Save = 'idle' | 'saving' | 'saved' | 'error'

/** Edit one template: text, fields and signature on the left, a live preview on the right. */
export function TemplateEditorPage() {
  const { id } = useParams()
  const { current } = useTenant()
  const loc = current?.id
  const nav = useNavigate()

  const [t, setT] = useState<DocTemplate | null>(null)
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [versions, setVersions] = useState<DocTemplate[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [asContact, setAsContact] = useState('')
  const [html, setHtml] = useState<string | null>(null)
  const [save, setSave] = useState<Save>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [missing, setMissing] = useState(false)
  const dirty = useRef(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!loc || !id) return
    let live = true
    dirty.current = false
    setT(null)
    setMissing(false)
    Promise.all([api.documents.template(loc, id), api.documents.meta(loc)])
      .then(([r, m]) => {
        if (!live) return
        setT(r.template)
        setMeta(m)
        api.documents.history(loc, r.template.familyId).then((h) => live && setVersions(h.versions)).catch(() => {})
      })
      .catch(() => live && setMissing(true))
    api.contacts(loc).then((r) => live && setContacts(r.contacts)).catch(() => {})
    return () => {
      live = false
    }
  }, [loc, id])

  const refreshPreview = useCallback(async () => {
    if (!loc || !id) return
    try {
      setHtml((await api.documents.preview(loc, id, asContact || undefined)).html)
    } catch {
      /* the preview is a convenience; the editor keeps working */
    }
  }, [loc, id, asContact])

  useEffect(() => {
    if (t) void refreshPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id, asContact])

  // Drafts save themselves shortly after the last change; active and retired versions never change.
  const editable = t?.status === 'draft'
  useEffect(() => {
    if (!t || !loc || !editable || !dirty.current) return
    const timer = setTimeout(async () => {
      setSave('saving')
      try {
        await api.documents.update(loc, t.id, { title: t.title, kind: t.kind, bodyMd: t.bodyMd, fields: t.fields, signature: t.signature, signerRoles: t.signerRoles, locale: t.locale })
        dirty.current = false
        setSave('saved')
        setError(null)
        void refreshPreview()
      } catch (e) {
        setSave('error')
        setError(e instanceof ApiError && e.status === 400 ? 'Some field is not valid yet (every field needs a label; choices need options).' : 'Could not save. Your changes are still on this page.')
      }
    }, 1200)
    return () => clearTimeout(timer)
  }, [t, loc, editable, refreshPreview])

  const change = (patch: Partial<DocTemplate>) => {
    dirty.current = true
    setSave('idle')
    setT((cur) => (cur ? { ...cur, ...patch } : cur))
  }

  async function act(fn: () => Promise<DocTemplate | null>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (dirty.current && t && loc && editable) {
        await api.documents.update(loc, t.id, { title: t.title, kind: t.kind, bodyMd: t.bodyMd, fields: t.fields, signature: t.signature, signerRoles: t.signerRoles, locale: t.locale })
        dirty.current = false
      }
      const next = await fn()
      if (next && loc) api.documents.history(loc, next.familyId).then((h) => setVersions(h.versions)).catch(() => {})
      if (next && next.id === t?.id) setT(next) // same row (e.g. just activated): show its new, read-only state
      else if (next) nav(`/documents/templates/${next.id}`)
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? (e.message === 'draft_exists' ? 'There is already a draft of a newer version.' : 'That version can no longer be changed.') : 'That did not work. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function insertAtCursor(text: string) {
    if (!t) return
    const el = bodyRef.current
    const at = el?.selectionStart ?? t.bodyMd.length
    const end = el?.selectionEnd ?? at
    change({ bodyMd: t.bodyMd.slice(0, at) + text + t.bodyMd.slice(end) })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + text.length, at + text.length)
    })
  }

  if (missing) return <div className="p-6 text-sm text-slate-600">Template not found. <Link className="text-brand-700 underline" to="/documents">Back to documents</Link></div>
  if (!t || !meta || !loc) return <PageSpinner />

  const readOnly = !editable
  const isStarter = t.familyId.startsWith('seed_') && t.status === 'draft'
  const toggleRole = (r: SignerRole) => {
    const has = t.signerRoles.includes(r)
    if (has && t.signerRoles.length === 1) return
    change({ signerRoles: has ? t.signerRoles.filter((x) => x !== r) : [...t.signerRoles, r] })
  }

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <Link to="/documents" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> Documents</Link>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 min-w-0 flex-1 truncate text-xl font-semibold text-slate-900">{t.title || 'Untitled'}</h1>
        <Badge variant={STATUS_VARIANT[t.status]}>{t.status} · v{t.version}</Badge>
        <Badge variant="outline">{t.locale.toUpperCase()}</Badge>
        {editable && (
          <span className="text-xs text-slate-500" aria-live="polite">
            {save === 'saving' ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Saving…</span> : save === 'saved' ? 'Saved' : ''}
          </span>
        )}
        {versions.length > 1 && (
          <label className="inline-flex items-center gap-1 text-sm text-slate-600">
            <History className="h-4 w-4" aria-hidden />
            <span className="sr-only">Version history</span>
            <select className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm" value={t.id} onChange={(e) => nav(`/documents/templates/${e.target.value}`)}>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.status}</option>)}
            </select>
          </label>
        )}
        {t.status === 'draft' && <Button disabled={busy} onClick={() => act(async () => (await api.documents.activate(loc, t.id)).template)}>Activate</Button>}
        {t.status === 'active' && <Button variant="outline" disabled={busy} onClick={() => act(async () => (await api.documents.newVersion(loc, t.id)).template)}>New version</Button>}
        {t.status === 'active' && <Button variant="ghost" disabled={busy} onClick={() => act(async () => { await api.documents.retire(loc, t.id); const r = await api.documents.template(loc, t.id); setT(r.template); return null })}>Retire</Button>}
        {t.status === 'retired' && <Button variant="outline" disabled={busy} onClick={() => act(async () => (await api.documents.newVersion(loc, t.id)).template)}>New version</Button>}
      </div>

      {isStarter && (
        <div role="note" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Template – legal review required.</strong> This is a starting point, not legal advice. Read it, adapt it to your practice and local law (or have it reviewed) before you activate it.
        </div>
      )}
      {readOnly && (
        <div role="note" className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          This version is {t.status} and can no longer be changed, so every signed copy keeps its exact text. Use <strong>New version</strong> to edit.
        </div>
      )}
      {error && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-2">
        <fieldset disabled={readOnly} className="min-w-0 space-y-5">
          <div>
            <Label htmlFor="t-title">Title</Label>
            <Input id="t-title" value={t.title} maxLength={200} onChange={(e) => change({ title: e.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="t-kind">Type</Label>
              <select id="t-kind" className="h-10 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm" value={t.kind} onChange={(e) => change({ kind: e.target.value as DocTemplate['kind'] })}>
                <option value="agreement">Agreement</option>
                <option value="intake_form">Intake form</option>
              </select>
            </div>
            <div>
              <Label htmlFor="t-locale">Language</Label>
              <select id="t-locale" className="h-10 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm" value={t.locale} onChange={(e) => change({ locale: e.target.value as 'es' | 'en' })}>
                <option value="es">Spanish</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" checked={t.signature.drawn} onChange={(e) => change({ signature: { ...t.signature, drawn: e.target.checked } })} /> Require drawn signature
              </label>
            </div>
          </div>
          <div>
            <Label>Who signs</Label>
            <div className="flex flex-wrap gap-4">
              {(Object.keys(ROLE_LABELS) as SignerRole[]).map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={t.signerRoles.includes(r)} onChange={() => toggleRole(r)} /> {ROLE_LABELS[r]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="t-body">Text (Markdown)</Label>
              <select aria-label="Insert merge field" className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm" value="" disabled={readOnly}
                onChange={(e) => e.target.value && insertAtCursor(e.target.value)}>
                <option value="">Insert merge field…</option>
                {meta.mergeFields.map((m) => <option key={m.token} value={m.token}>{m.label}</option>)}
              </select>
            </div>
            <textarea id="t-body" ref={bodyRef} rows={16} value={t.bodyMd} onChange={(e) => change({ bodyMd: e.target.value })}
              className="w-full rounded-lg border border-slate-200 p-3 font-mono text-sm leading-relaxed" spellCheck />
            <p className="mt-1 text-xs text-slate-500">Headings with <code>##</code>, lists with <code>-</code>, <code>**bold**</code>, <code>*italic*</code>, <code>---</code> for a rule. HTML is shown as text.</p>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-800">Fields the client fills in</h2>
            <FieldBuilder fields={t.fields} types={meta.fieldTypes} disabled={readOnly} onChange={(fields) => change({ fields })} />
          </div>
        </fieldset>

        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">Preview</h2>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              Preview as
              <select className="h-8 max-w-[14rem] rounded-lg border border-slate-200 bg-white px-2 text-sm" value={asContact} onChange={(e) => setAsContact(e.target.value)}>
                <option value="">Sample client</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
              </select>
            </label>
          </div>
          <PreviewFrame html={html} title="Document preview" />
          <p className="mt-2 text-xs text-slate-500">Highlighted text means a merge field the system doesn't know. Fields are shown disabled here.</p>
        </div>
      </div>
    </div>
  )
}

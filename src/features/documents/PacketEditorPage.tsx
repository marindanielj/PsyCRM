import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { PageSpinner } from '../../components/ui/spinner'
import { ApiError, type Contact, type DocPacket, type DocTemplateSummary, api } from '../../lib/api'
import { useTenant } from '../../state/location'
import { PreviewFrame } from './PreviewFrame'

/** Edit one packet: which documents, in which order, for which audience; preview the whole sequence. */
export function PacketEditorPage() {
  const { id } = useParams()
  const { current } = useTenant()
  const loc = current?.id

  const [packet, setPacket] = useState<DocPacket | null>(null)
  const [all, setAll] = useState<DocTemplateSummary[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [asContact, setAsContact] = useState('')
  const [html, setHtml] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [version, setVersion] = useState(0) // bumps after each successful save to refresh the preview

  useEffect(() => {
    if (!loc || !id) return
    let live = true
    api.documents.packet(loc, id).then((r) => live && setPacket(r.packet)).catch(() => live && setMissing(true))
    api.documents.templates(loc).then((r) => live && setAll(r.templates)).catch(() => {})
    api.contacts(loc).then((r) => live && setContacts(r.contacts)).catch(() => {})
    return () => {
      live = false
    }
  }, [loc, id])

  useEffect(() => {
    if (!loc || !id || !packet) return
    let live = true
    api.documents.previewPacket(loc, id, asContact || undefined).then((r) => live && setHtml(r.html)).catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, id, asContact, version, !!packet])

  async function save(patch: Partial<Pick<DocPacket, 'name' | 'description' | 'familyIds' | 'audience'>> & { archived?: boolean }) {
    if (!loc || !id || !packet) return
    setSaving(true)
    setError(null)
    const before = packet
    setPacket({ ...packet, ...patch, archivedAt: patch.archived === undefined ? packet.archivedAt : patch.archived ? new Date().toISOString() : null })
    try {
      const r = await api.documents.updatePacket(loc, id, patch)
      setPacket(r.packet)
      setVersion((v) => v + 1)
    } catch (e) {
      setPacket(before)
      setError(e instanceof ApiError && e.status === 400 ? 'That document no longer exists.' : 'Could not save the packet.')
    } finally {
      setSaving(false)
    }
  }

  if (missing) return <div className="p-6 text-sm text-slate-600">Packet not found. <Link className="text-brand-700 underline" to="/documents/packets">Back to packets</Link></div>
  if (!packet || !loc) return <PageSpinner />

  const byFamily = new Map(all.map((t) => [t.familyId, t]))
  const available = all.filter((t) => !packet.familyIds.includes(t.familyId))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= packet.familyIds.length) return
    const ids = [...packet.familyIds]
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    void save({ familyIds: ids })
  }

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <Link to="/documents/packets" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> Packets</Link>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 flex-1 truncate text-xl font-semibold text-slate-900">{packet.name}</h1>
        {packet.archivedAt && <Badge variant="slate">archived</Badge>}
        <Button variant="outline" size="sm" disabled={saving} onClick={() => save({ archived: !packet.archivedAt })}>{packet.archivedAt ? 'Restore' : 'Archive'}</Button>
      </div>
      {error && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-5">
          <div>
            <Label htmlFor="p-name">Name</Label>
            <Input id="p-name" key={`n-${packet.updatedAt}`} defaultValue={packet.name} maxLength={200} onBlur={(e) => e.target.value.trim() && e.target.value !== packet.name && save({ name: e.target.value.trim() })} />
          </div>
          <div>
            <Label htmlFor="p-desc">Description</Label>
            <Input id="p-desc" key={`d-${packet.updatedAt}`} defaultValue={packet.description ?? ''} maxLength={1000} onBlur={(e) => e.target.value !== (packet.description ?? '') && save({ description: e.target.value.trim() || null })} />
          </div>
          <div>
            <Label htmlFor="p-aud">Audience</Label>
            <select id="p-aud" className="h-10 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm" value={packet.audience} onChange={(e) => save({ audience: e.target.value as DocPacket['audience'] })}>
              <option value="adult">Adult (18 or older)</option>
              <option value="adolescent">Adolescent (under 18)</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">The packet that is sent is chosen by the client's date of birth.</p>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-800">Documents, in order</h2>
            {packet.familyIds.length === 0 && <p className="text-sm text-slate-500">No documents yet. Add some below.</p>}
            <ol className="space-y-2">
              {packet.familyIds.map((f, i) => {
                const t = byFamily.get(f)
                const inForce = t?.activeVersion != null
                return (
                  <li key={f} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <span className="w-5 text-sm text-slate-400">{i + 1}.</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{t?.title ?? f}</span>
                      {!inForce && <span className="text-xs text-amber-700">No version in force yet — activate it before sending this packet.</span>}
                    </span>
                    <Button variant="ghost" size="icon" aria-label="Move up" disabled={saving || i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label="Move down" disabled={saving || i === packet.familyIds.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label={`Remove ${t?.title ?? f}`} disabled={saving} onClick={() => save({ familyIds: packet.familyIds.filter((x) => x !== f) })}><Trash2 className="h-4 w-4" /></Button>
                  </li>
                )
              })}
            </ol>
          </div>

          {available.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-800">Add a document</h2>
              <ul className="space-y-1">
                {available.map((t) => (
                  <li key={t.familyId}>
                    <button type="button" disabled={saving} onClick={() => save({ familyIds: [...packet.familyIds, t.familyId] })}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50">
                      <Plus className="h-4 w-4 text-slate-400" aria-hidden /> <span className="min-w-0 flex-1 truncate">{t.title}</span>
                      {t.activeVersion === null && <Badge variant="amber">not in force</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">Packet preview</h2>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              Preview as
              <select className="h-8 max-w-[14rem] rounded-lg border border-slate-200 bg-white px-2 text-sm" value={asContact} onChange={(e) => setAsContact(e.target.value)}>
                <option value="">Sample client</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.id}</option>)}
              </select>
            </label>
          </div>
          <PreviewFrame html={html} title="Packet preview" />
          <p className="mt-2 text-xs text-slate-500">Shows the version in force of each document (or the newest draft if none is).</p>
        </div>
      </div>
    </div>
  )
}

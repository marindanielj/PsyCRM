import { FileText, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { PageSpinner } from '../../components/ui/spinner'
import { type DocPacket, type DocTemplateSummary, api } from '../../lib/api'
import { cn } from '../../lib/utils'
import { useTenant } from '../../state/location'
import { SentList } from './SentList'
import { STATUS_VARIANT } from './TemplateEditorPage'

const KIND_LABEL = { agreement: 'Agreement', intake_form: 'Intake form' } as const
const AUDIENCE_LABEL = { adult: 'Adult (18+)', adolescent: 'Adolescent (under 18)' } as const

function Tabs({ active }: { active: 'templates' | 'packets' | 'sent' }) {
  const cls = (on: boolean) => cn('border-b-2 px-3 py-2 text-sm font-medium', on ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')
  return (
    <nav aria-label="Documents sections" className="mb-5 flex gap-1 border-b border-slate-200">
      <NavLink to="/documents" end className={cls(active === 'templates')}>Templates</NavLink>
      <NavLink to="/documents/packets" className={cls(active === 'packets')}>Packets</NavLink>
      <NavLink to="/documents/sent" className={cls(active === 'sent')}>Sent</NavLink>
    </nav>
  )
}

/** Documents -> Templates | Packets. */
export function DocumentsPage({ tab }: { tab: 'templates' | 'packets' | 'sent' }) {
  const { current } = useTenant()
  const loc = current?.id
  const nav = useNavigate()
  const [templates, setTemplates] = useState<DocTemplateSummary[] | null>(null)
  const [packets, setPackets] = useState<(DocPacket & { inactiveFamilyIds: string[] })[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!loc) return
    let live = true
    setError(null)
    if (tab === 'sent') return
    if (tab === 'templates') {
      setTemplates(null)
      api.documents.templates(loc).then((r) => live && setTemplates(r.templates)).catch(() => live && (setTemplates([]), setError('Could not load templates.')))
    } else {
      setPackets(null)
      api.documents.packets(loc).then((r) => live && setPackets(r.packets)).catch(() => live && (setPackets([]), setError('Could not load packets.')))
    }
    return () => {
      live = false
    }
  }, [loc, tab])

  async function newTemplate() {
    if (!loc || busy) return
    setBusy(true)
    try {
      const r = await api.documents.create(loc, { title: 'New document', kind: 'agreement', locale: 'es' })
      nav(`/documents/templates/${r.template.id}`)
    } catch {
      setError('Could not create the template.')
      setBusy(false)
    }
  }
  async function newPacket() {
    if (!loc || busy) return
    setBusy(true)
    try {
      const r = await api.documents.createPacket(loc, { name: 'New packet', familyIds: [], audience: 'adult' })
      nav(`/documents/packets/${r.packet.id}`)
    } catch {
      setError('Could not create the packet.')
      setBusy(false)
    }
  }

  return (
    <div className="ol-scroll min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Documents</h1>
        {tab !== 'sent' && <Button disabled={busy} onClick={tab === 'templates' ? newTemplate : newPacket}><Plus className="h-4 w-4" /> {tab === 'templates' ? 'New template' : 'New packet'}</Button>}
      </div>
      <Tabs active={tab} />
      {error && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>}

      {tab === 'sent' ? (
        loc ? <SentList locationId={loc} /> : null
      ) : tab === 'templates' ? (
        templates === null ? <PageSpinner /> : templates.length === 0 ? (
          <p className="text-sm text-slate-600">No templates yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {templates.map((t) => (
              <li key={t.familyId}>
                <Link to={`/documents/templates/${t.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50">
                  <FileText className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-900">{t.title}</span>
                    <span className="text-xs text-slate-500">{KIND_LABEL[t.kind]} · {t.fieldCount} field{t.fieldCount === 1 ? '' : 's'} · signs: {t.signerRoles.join(', ')}</span>
                  </span>
                  <Badge variant="outline">{t.locale.toUpperCase()}</Badge>
                  <Badge variant={STATUS_VARIANT[t.status]}>{t.status} v{t.version}</Badge>
                  {t.status !== 'active' && t.activeVersion !== null && <Badge variant="green">v{t.activeVersion} in force</Badge>}
                  {t.activeVersion === null && <Badge variant="amber">not in force</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : packets === null ? <PageSpinner /> : packets.length === 0 ? (
        <p className="text-sm text-slate-600">No packets yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {packets.map((p) => (
            <li key={p.id}>
              <Link to={`/documents/packets/${p.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900">{p.name}</span>
                  <span className="text-xs text-slate-500">{p.familyIds.length} document{p.familyIds.length === 1 ? '' : 's'}{p.description ? ` · ${p.description}` : ''}</span>
                </span>
                <Badge variant="blue">{AUDIENCE_LABEL[p.audience]}</Badge>
                {p.inactiveFamilyIds.length > 0 && <Badge variant="amber">{p.inactiveFamilyIds.length} not in force</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
    </div>
  )
}

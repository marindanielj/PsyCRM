import { Download, ShieldCheck, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { PageSpinner } from '../../components/ui/spinner'
import { type AuditVerification, type Contact, api } from '../../lib/api'
import { AUDIT_CATEGORIES } from '../../lib/audit-vocab'
import { useTenant } from '../../state/location'
import { AuditTable } from './AuditTable'
import { useAuditEntries } from './useAuditEntries'

// Puerto Rico does not observe daylight saving: it is UTC-4 all year, so a local
// calendar day is [00:00-04:00, next 00:00-04:00).
const PR_OFFSET = '-04:00'
const dayStart = (ymd: string) => `${ymd}T00:00:00${PR_OFFSET}`
function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
function localToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Puerto_Rico' }).format(new Date())
}
function daysAgo(n: number): string {
  const d = new Date(`${localToday()}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** Settings -> Audit log: who did what, when, to which client. Read-only. */
export function AuditLogPage() {
  const { current } = useTenant()
  const loc = current?.id

  const [from, setFrom] = useState(daysAgo(7))
  const [to, setTo] = useState(localToday())
  const [category, setCategory] = useState('')
  const [actorType, setActorType] = useState('')
  const [contactId, setContactId] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [verification, setVerification] = useState<AuditVerification | 'running' | 'error' | null>(null)

  useEffect(() => {
    if (!loc) return
    let active = true
    api
      .contacts(loc)
      .then((r) => active && setContacts(r.contacts))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [loc])

  const filters = useMemo(
    () => ({
      from: from ? dayStart(from) : undefined,
      to: to ? dayStart(nextDay(to)) : undefined,
      category: category || undefined,
      actorType: actorType || undefined,
      contactId: contactId || undefined,
    }),
    [from, to, category, actorType, contactId],
  )
  const { entries, status, hasMore, loadMore, loadingMore } = useAuditEntries(loc, filters)

  async function verify() {
    if (!loc) return
    setVerification('running')
    try {
      setVerification(await api.auditVerify(loc))
    } catch {
      setVerification('error')
    }
  }

  if (!loc) return <PageSpinner label="Loading audit log" />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Audit log</h1>
          <p className="text-xs text-slate-500">
            A permanent record of activity on client information. Entries can’t be edited or deleted. Times are Puerto Rico time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void verify()} disabled={verification === 'running'}>
            <ShieldCheck className="h-4 w-4" />
            {verification === 'running' ? 'Checking…' : 'Verify integrity'}
          </Button>
          <a
            href={api.auditExportUrl(loc, filters)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </a>
        </div>
      </header>

      <div className="ol-scroll min-h-0 flex-1 overflow-y-auto bg-slate-50 px-5 py-5">
        <div className="mx-auto max-w-6xl space-y-4">
          <VerificationBanner v={verification} />

          <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <Label htmlFor="audit-from">From</Label>
              <Input id="audit-from" type="date" className="mt-1.5" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="audit-to">To</Label>
              <Input id="audit-to" type="date" className="mt-1.5" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="audit-category">Category</Label>
              <select id="audit-category" className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All</option>
                {AUDIT_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="audit-client">Client</Label>
              <select id="audit-client" className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">All clients</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>{c.name ?? c.emails[0] ?? c.phones[0] ?? 'Unnamed'}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="audit-actor">Done by</Label>
              <select id="audit-actor" className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm" value={actorType} onChange={(e) => setActorType(e.target.value)}>
                <option value="">Anyone</option>
                <option value="operator">Staff</option>
                <option value="client">Client</option>
                <option value="workflow">Automation</option>
                <option value="system">System</option>
              </select>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white px-4 py-2 shadow-sm">
            {status === 'loading' ? (
              <PageSpinner label="Loading audit log" />
            ) : status === 'error' ? (
              <p className="px-4 py-8 text-center text-sm text-rose-600">Could not load the audit log.</p>
            ) : (
              <>
                <AuditTable entries={entries} />
                {hasMore ? (
                  <div className="flex justify-center border-t border-slate-100 py-3">
                    <Button size="sm" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? 'Loading…' : 'Load older entries'}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function VerificationBanner({ v }: { v: AuditVerification | 'running' | 'error' | null }) {
  if (v === null || v === 'running') return null
  if (v === 'error') return <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">Could not run the integrity check.</p>
  return v.ok ? (
    <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      <ShieldCheck className="h-4 w-4" />
      Integrity verified: all {v.count.toLocaleString()} entries are intact and in order.
    </p>
  ) : (
    <p className="flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800">
      <ShieldAlert className="h-4 w-4" />
      The log may have been altered: entry #{v.brokenAtSeq} does not match its record. Do not rely on entries from that point on, and contact your administrator.
    </p>
  )
}

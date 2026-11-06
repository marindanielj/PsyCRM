import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { type Calendar, type DocPacket, type DocTemplateSummary, type NewWorkflow, type Pipeline, type TriggerType, api } from '../../lib/api'
import { useTenant } from '../../state/location'
import { TRIGGERS, triggerMeta } from './automation-meta'

const selectClass =
  'h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'

/** Create a workflow: name it and pick the trigger that starts it. Steps are
 *  added afterward in the builder. */
export function NewWorkflowDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void
  onCreate: (input: NewWorkflow) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [triggerType, setTriggerType] = useState<TriggerType>('contact_created')
  const [saving, setSaving] = useState(false)
  const { current } = useTenant()
  const loc = current?.id
  // The optional filter each trigger offers ("only this packet", "only this stage"…).
  const [packets, setPackets] = useState<DocPacket[]>([])
  const [families, setFamilies] = useState<DocTemplateSummary[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [packetId, setPacketId] = useState('')
  const [familyId, setFamilyId] = useState('')
  const [pipelineId, setPipelineId] = useState('')
  const [toStageId, setToStageId] = useState('')
  const [calendarId, setCalendarId] = useState('')
  const [firstOnly, setFirstOnly] = useState(false)

  useEffect(() => {
    if (!loc) return
    let live = true
    api.documents.packets(loc).then((r) => live && setPackets(r.packets)).catch(() => {})
    api.documents.templates(loc).then((r) => live && setFamilies(r.templates)).catch(() => {})
    api.pipelines(loc).then((r) => live && setPipelines(r.pipelines)).catch(() => {})
    api.calendars(loc).then((r) => live && setCalendars(r.calendars)).catch(() => {})
    return () => { live = false }
  }, [loc])
  const stages = pipelines.find((p) => p.id === pipelineId)?.stages ?? []

  const triggerConfig = (): Record<string, unknown> => {
    switch (triggerType) {
      case 'documents_completed': return packetId ? { packetId } : {}
      case 'document_signed': return familyId ? { templateFamilyId: familyId } : {}
      case 'pipeline_stage_changed': return { ...(pipelineId ? { pipelineId } : {}), ...(toStageId ? { toStageId } : {}) }
      case 'appointment_booked':
      case 'appointment_checked_in': return calendarId ? { calendarId } : {}
      case 'session_note_signed': return firstOnly ? { firstOnly: true } : {}
      default: return {}
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onCreate({ name: name.trim(), triggerType, triggerConfig: triggerConfig() })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onCancel}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl"
      >
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">New workflow</h2>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <Label htmlFor="wf-name">Workflow name</Label>
            <Input
              id="wf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. New lead welcome"
              autoFocus
            />
          </div>

          <div>
            <Label htmlFor="wf-trigger">Trigger</Label>
            <select
              id="wf-trigger"
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value as TriggerType)}
              className={selectClass}
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {triggerMeta(t).label}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-slate-500">
              The event that enrolls a contact into this workflow.
            </p>
          </div>

          {triggerType === 'documents_completed' && (
            <div>
              <Label htmlFor="wf-packet">Only for this packet (optional)</Label>
              <select id="wf-packet" value={packetId} onChange={(e) => setPacketId(e.target.value)} className={selectClass}>
                <option value="">Any packet</option>
                {packets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          {triggerType === 'document_signed' && (
            <div>
              <Label htmlFor="wf-family">Only for this document (optional)</Label>
              <select id="wf-family" value={familyId} onChange={(e) => setFamilyId(e.target.value)} className={selectClass}>
                <option value="">Any document</option>
                {families.map((t) => <option key={t.familyId} value={t.familyId}>{t.title}</option>)}
              </select>
            </div>
          )}
          {triggerType === 'pipeline_stage_changed' && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="wf-pipeline">Only in this pipeline (optional)</Label>
                <select id="wf-pipeline" value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setToStageId('') }} className={selectClass}>
                  <option value="">Any pipeline</option>
                  {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="wf-stage">Only when moved to (optional)</Label>
                <select id="wf-stage" value={toStageId} disabled={!pipelineId} onChange={(e) => setToStageId(e.target.value)} className={selectClass}>
                  <option value="">Any stage</option>
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
          )}
          {(triggerType === 'appointment_booked' || triggerType === 'appointment_checked_in') && (
            <div>
              <Label htmlFor="wf-calendar">Only for this calendar (optional)</Label>
              <select id="wf-calendar" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className={selectClass}>
                <option value="">Any calendar</option>
                {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          {triggerType === 'session_note_signed' && (
            <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={firstOnly} onChange={(e) => setFirstOnly(e.target.checked)} /> First signed note only</label>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!name.trim() || saving}>
            {saving ? 'Creating…' : 'Create workflow'}
          </Button>
        </div>
      </form>
    </div>
  )
}

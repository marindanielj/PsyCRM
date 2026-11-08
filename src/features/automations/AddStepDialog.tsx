import { type FormEvent, useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { type ActionType, type DocPacket, type Pipeline, type WorkflowActionInput, api } from '../../lib/api'
import { useTenant } from '../../state/location'
import { ACTIONS, actionMeta } from './automation-meta'

const selectClass =
  'h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const textareaClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'

/** Add one action step: pick the action type, then fill the fields that type
 *  needs. The config shape mirrors the server vocab (send_sms{body},
 *  send_email{subject,body}, add_tag{tag}, wait{minutes}). */
export function AddStepDialog({
  onCancel,
  onAdd,
}: {
  onCancel: () => void
  onAdd: (step: WorkflowActionInput) => void
}) {
  const { current } = useTenant()
  const loc = current?.id
  const [type, setType] = useState<ActionType>('send_email')
  const [body, setBody] = useState('')
  const [subject, setSubject] = useState('')
  const [tag, setTag] = useState('')
  const [minutes, setMinutes] = useState('5')
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [packets, setPackets] = useState<DocPacket[]>([])
  const [pipelineId, setPipelineId] = useState('')
  const [stageId, setStageId] = useState('')
  const [createIfMissing, setCreateIfMissing] = useState(true)
  const [onlyForward, setOnlyForward] = useState(true)
  const [packetId, setPacketId] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDays, setTaskDays] = useState('')

  // What the pickers offer: the practice's pipelines and its (adult) packets.
  useEffect(() => {
    if (!loc) return
    let live = true
    api.pipelines(loc).then((r) => live && setPipelines(r.pipelines)).catch(() => {})
    api.documents.packets(loc).then((r) => live && setPackets(r.packets)).catch(() => {})
    return () => { live = false }
  }, [loc])
  const stages = pipelines.find((p) => p.id === pipelineId)?.stages ?? []

  const valid =
    (type === 'send_sms' && body.trim().length > 0) ||
    (type === 'send_email' && subject.trim().length > 0 && body.trim().length > 0) ||
    (type === 'add_tag' && tag.trim().length > 0) ||
    (type === 'wait' && Number(minutes) > 0) ||
    (type === 'move_to_stage' && pipelineId !== '' && stageId !== '') ||
    (type === 'send_document_packet' && packetId !== '') ||
    (type === 'create_task' && taskTitle.trim().length > 0)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    let config: Record<string, unknown> = {}
    if (type === 'send_sms') config = { body: body.trim() }
    else if (type === 'send_email') config = { subject: subject.trim(), body: body.trim() }
    else if (type === 'add_tag') config = { tag: tag.trim() }
    else if (type === 'wait') config = { minutes: Number(minutes) }
    else if (type === 'move_to_stage') config = { pipelineId, stageId, createIfMissing, onlyForward }
    else if (type === 'send_document_packet') config = { packetId }
    else if (type === 'create_task') config = { title: taskTitle.trim(), ...(taskDays !== '' && Number(taskDays) >= 0 ? { dueInDays: Number(taskDays) } : {}) }
    onAdd({ type, config })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onCancel}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-md flex-col rounded-xl border border-slate-200 bg-white shadow-xl"
      >
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">Add step</h2>
        </div>

        <div className="ol-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <Label htmlFor="step-type">Action</Label>
            <select
              id="step-type"
              value={type}
              onChange={(e) => setType(e.target.value as ActionType)}
              className={selectClass}
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {actionMeta(a).label}
                </option>
              ))}
            </select>
          </div>

          {type === 'send_email' && (
            <div>
              <Label htmlFor="step-subject">Subject</Label>
              <Input
                id="step-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject line"
                autoFocus
              />
            </div>
          )}

          {(type === 'send_sms' || type === 'send_email') && (
            <div>
              <Label htmlFor="step-body">Message</Label>
              <textarea
                id="step-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Hi {{first_name}}, …"
                className={textareaClass}
              />
            </div>
          )}

          {type === 'add_tag' && (
            <div>
              <Label htmlFor="step-tag">Tag</Label>
              <Input
                id="step-tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="e.g. lead"
                autoFocus
              />
            </div>
          )}

          {type === 'move_to_stage' && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="step-pipeline">Pipeline</Label>
                <select id="step-pipeline" className={selectClass} value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setStageId('') }}>
                  <option value="">Choose a pipeline…</option>
                  {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="step-stage">Stage</Label>
                <select id="step-stage" className={selectClass} value={stageId} disabled={!pipelineId} onChange={(e) => setStageId(e.target.value)}>
                  <option value="">Choose a stage…</option>
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={createIfMissing} onChange={(e) => setCreateIfMissing(e.target.checked)} /> Create the card if the client has none</label>
              <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={onlyForward} onChange={(e) => setOnlyForward(e.target.checked)} /> Only move forward (never back)</label>
            </div>
          )}

          {type === 'send_document_packet' && (
            <div>
              <Label htmlFor="step-packet">Packet</Label>
              <select id="step-packet" className={selectClass} value={packetId} onChange={(e) => setPacketId(e.target.value)}>
                <option value="">Choose a packet…</option>
                {packets.filter((p) => p.audience === 'adult').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <p className="mt-1.5 text-xs text-slate-500">Emails the signing link to the client. Adult packets only: a minor's packet needs a guardian, so it is sent by hand. It is skipped if the client has no email or date of birth, or was already sent this packet.</p>
            </div>
          )}

          {type === 'create_task' && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="step-task">Task title</Label>
                <Input id="step-task" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Schedule first appointment with {{contact.first_name}}" autoFocus />
              </div>
              <div>
                <Label htmlFor="step-days">Due in (days, optional)</Label>
                <Input id="step-days" type="number" min={0} value={taskDays} onChange={(e) => setTaskDays(e.target.value)} />
              </div>
            </div>
          )}

          {type === 'wait' && (
            <div>
              <Label htmlFor="step-minutes">Wait (minutes)</Label>
              <Input
                id="step-minutes"
                type="number"
                min={1}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
              <p className="mt-1.5 text-xs text-amber-700">Waits longer than a few hours may be lost if the server restarts.</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!valid}>
            Add step
          </Button>
        </div>
      </form>
    </div>
  )
}

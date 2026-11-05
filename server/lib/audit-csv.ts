import { auditLabel } from './audit-vocab'
import type { AuditRow } from '../repos/audit-repo'

/** Spreadsheet formula injection: a cell that starts with = + - @ (or tab/CR) is
 *  executed by Excel/Sheets. Prefix those with an apostrophe so they read as text. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** `2026-11-05 14:03:22 AST` — the practice's local time, sortable, with the zone named. */
export function formatLocal(iso: string, tz = 'America/Puerto_Rico'): string {
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? tz
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${zone}`
}

export const CSV_HEADER = ['Seq', 'When', 'When (UTC)', 'Who', 'Actor type', 'Action', 'Action code', 'Entity', 'Entity id', 'Client', 'Client id', 'Details', 'IP']

/** UTF-8 with a BOM so Excel opens accents correctly; CRLF line endings. */
export function auditCsv(rows: AuditRow[], tz?: string): string {
  const lines = [CSV_HEADER.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.seq,
        formatLocal(r.occurredAt, tz),
        r.occurredAt,
        r.actorName ?? '',
        r.actorType,
        auditLabel(r.action),
        r.action,
        r.entityType,
        r.entityId,
        r.contactName,
        r.contactId,
        JSON.stringify(r.details),
        r.ip,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

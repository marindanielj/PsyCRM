import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { audit, auditContext } from '../lib/audit'
import { auditCsv } from '../lib/audit-csv'
import { ACTOR_TYPES } from '../lib/audit-vocab'
import { AuditRepo } from '../repos/audit-repo'

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date')

const filterSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  contactId: z.string().min(1).max(64).optional(),
  category: z.string().regex(/^[a-z_]+$/).max(30).optional(),
  // `note.signed` (exact) or `note.` (prefix)
  action: z.string().regex(/^[a-z_]+\.([a-z_]*)$/).max(60).optional(),
  actorType: z.enum(ACTOR_TYPES).optional(),
  entityType: z.string().regex(/^[a-z_]+$/).max(40).optional(),
  entityId: z.string().min(1).max(64).optional(),
})
const listSchema = filterSchema.extend({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/** Hard ceiling for one CSV export. A practice's whole history is far smaller. */
const EXPORT_MAX_ROWS = 50_000

/**
 * The audit log, read-only: Settings -> Audit log and each client's Audit tab.
 * Mounted at /api/loc/:loc/audit behind operatorAuth + locationAccess + the `audit`
 * module. There is deliberately NO write endpoint — rows are only ever appended by
 * the code paths that perform the audited action.
 */
export function auditRoute(deps: { db: Database; timezone?: string }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', zValidator('query', listSchema), async (c) => {
    const { before, limit, ...filters } = c.req.valid('query')
    const { rows, nextBefore } = await new AuditRepo(deps.db, c.get('locationId')).list(filters, { before, limit })
    return c.json({ entries: rows, nextBefore })
  })

  // Re-computes the hash chain. Read-only; safe to call any time.
  app.get('/verify', async (c) => {
    return c.json(await new AuditRepo(deps.db, c.get('locationId')).verify())
  })

  // CSV of everything matching the filters. Exporting the log is itself recorded
  // (before the file is produced, so a failed audit write means no export).
  app.get('/export.csv', zValidator('query', filterSchema), async (c) => {
    const loc = c.get('locationId')
    const filters = c.req.valid('query')
    const repo = new AuditRepo(deps.db, loc)

    const all = []
    let before: number | undefined
    for (;;) {
      const page = await repo.list(filters, { before, limit: 200 })
      all.push(...page.rows)
      if (page.nextBefore === null || all.length >= EXPORT_MAX_ROWS) break
      before = page.nextBefore
    }
    const truncated = all.length >= EXPORT_MAX_ROWS
    const rows = all.slice(0, EXPORT_MAX_ROWS)
    await audit(deps.db, loc, {
      action: 'audit.exported',
      entityType: 'audit_log',
      details: { rows: rows.length, truncated, filters: Object.keys(filters) },
      ...auditContext(c),
    })
    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header('Content-Disposition', 'attachment; filename="audit-log.csv"')
    if (truncated) c.header('X-Audit-Export-Truncated', 'true')
    return c.body(auditCsv(rows, deps.timezone))
  })

  return app
}

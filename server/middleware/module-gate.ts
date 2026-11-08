import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { type Module, enabledModules } from '../lib/modules'

/**
 * 404s a route group unless the location has the module enabled. Must run after
 * locationAccess (needs `locationId`). A 404, not a 403: a disabled module
 * should look like it does not exist. Reads the location's settings once per
 * request; the per-location result is cached for a few seconds so a page that
 * fires a burst of API calls does not hammer the table.
 */
const CACHE_MS = 5_000

export function moduleGate(db: Database, module: Module, opts: { now?: () => number } = {}) {
  const cache = new Map<string, { at: number; modules: Module[] }>()
  const now = opts.now ?? Date.now
  return createMiddleware<AppEnv>(async (c, next) => {
    const locationId = c.get('locationId')
    if (!locationId) return c.json({ error: 'not found' }, 404)
    const t = now()
    let hit = cache.get(locationId)
    if (!hit || t - hit.at > CACHE_MS) {
      const rows = await db.query<{ settings: unknown }>(
        'SELECT settings FROM locations WHERE id=$1',
        [locationId],
      )
      hit = { at: t, modules: enabledModules(rows[0]?.settings) }
      cache.set(locationId, hit)
    }
    if (!hit.modules.includes(module)) return c.json({ error: 'not found' }, 404)
    await next()
  })
}

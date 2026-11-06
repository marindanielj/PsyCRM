import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { enabledModules } from '../lib/modules'
import { OperatorsRepo } from '../repos/operators-repo'

/**
 * Lists the locations the authenticated operator may access. Mounted behind
 * operatorAuth, so `operatorId` is always set. This is the source for the
 * LocationSwitcher in the UI. Each location carries its `enabledModules`.
 */
export function locationsRoute(deps: { db: Database }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get('/', async (c) => {
    const locations = await new OperatorsRepo(deps.db).listLocations(c.get('operatorId'))
    // `enabledModules` drives the web nav and route guards (the practice's list, or
    // the PsyCRM default set when it has none).
    return c.json({
      locations: locations.map((l) => ({ ...l, enabledModules: enabledModules(l.settings) })),
    })
  })
  return app
}

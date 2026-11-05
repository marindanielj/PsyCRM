import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { ALL_MODULES, enabledModules } from '../lib/modules'
import { OperatorsRepo } from '../repos/operators-repo'

/**
 * Lists the locations the authenticated operator may access. Mounted behind
 * operatorAuth, so `operatorId` is always set. This is the source for the
 * LocationSwitcher in the UI. Each location carries its `enabledModules`.
 */
export function locationsRoute(deps: { db: Database; psycrmMode?: boolean }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get('/', async (c) => {
    const locations = await new OperatorsRepo(deps.db).listLocations(c.get('operatorId'))
    // `enabledModules` drives the web nav. Outside PsyCRM mode every module is on,
    // so a plain OpenLevel deploy shows the whole product exactly as before.
    return c.json({
      locations: locations.map((l) => ({
        ...l,
        enabledModules: deps.psycrmMode ? enabledModules(l.settings) : [...ALL_MODULES],
        // PsyCRM-only behaviors the UI must mirror (e.g. date of birth is required).
        psycrm: deps.psycrmMode === true,
      })),
    })
  })
  return app
}

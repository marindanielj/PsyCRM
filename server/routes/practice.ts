import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env'
import type { Database } from '../db/database'
import { PracticeRepo } from '../repos/practice-repo'

const text = (max: number) => z.string().trim().max(max)

const practiceSchema = z.object({
  name: text(120),
  therapist: text(120),
  license: text(60),
  address: text(300),
  phone: text(40),
  email: z.union([z.literal(''), z.string().trim().email().max(200)]),
  fees: z.object({ session: text(40), intake: text(40), late_cancel: text(40) }),
  policy: z.object({ cancel_hours: z.string().trim().regex(/^\d{1,3}$/, 'hours must be a number') }),
})

/**
 * The practice profile (Settings -> Practice): name, therapist, license, address,
 * fees and cancellation policy. Feeds the printed note letterhead and the
 * document merge fields. Mounted under /api/loc/:loc/practice.
 */
export function practiceRoute(deps: { db: Database }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', async (c) => {
    return c.json({ practice: await new PracticeRepo(deps.db, c.get('locationId')).get() })
  })

  app.put('/', zValidator('json', practiceSchema), async (c) => {
    const practice = await new PracticeRepo(deps.db, c.get('locationId')).save(c.req.valid('json'))
    return c.json({ ok: true, practice })
  })

  return app
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { DEMO_LOGIN, seedPracticeDemo } from '../db/seed-demo'
import { PgliteDatabase } from './db/pglite-database'
import { createApp } from './index'
import { dispatchWorkflowEvent } from './jobs/workflow-dispatcher'

/**
 * Local dev server. Runs the whole app against in-process PGlite (real Postgres,
 * no Docker) with a fictional demo practice. No third-party integration is enabled,
 * so nothing here can reach the network.
 *
 *   npm run dev:local   # this server on :8790
 *   npm run dev         # vite frontend on :5273, proxying /api here
 *
 * The database lives in memory and starts fresh on every boot.
 */

const SCHEMA = readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8')

async function main() {
  const pg = new PGlite() // in-memory; fresh on every boot
  await pg.exec(SCHEMA)
  const db = new PgliteDatabase(pg)
  await seedPracticeDemo(db)

  // Every email the app "sends" lands here (dev only) so a test can read links and one-time codes.
  const outbox: { to: string; subject: string; text: string; at: string }[] = []

  // The same wiring the production worker has: automations can move cards, send packets and email.
  const resolveEmail: NonNullable<Parameters<typeof createApp>[0]['resolveEmail']> = async () => ({
    ok: true,
    sender: {
      name: 'dev-console',
      sendEmail: async (m) => {
        outbox.push({ to: m.to, subject: m.subject, text: m.text, at: new Date().toISOString() })
        console.log(`\n[dev email] to=${m.to}\n[dev email] subject=${m.subject}\n${m.text.split('\n').map((l) => `[dev email] ${l}`).join('\n')}\n`)
        return { externalId: 'dev', provider: 'dev-console' }
      },
    },
  })
  const publicBaseUrl = 'http://localhost:5273'
  const dispatch = async (e: Parameters<typeof dispatchWorkflowEvent>[1]) => {
    await dispatchWorkflowEvent({ db, dispatch, resolveEmail, publicBaseUrl }, e)
  }

  const app = createApp({
    db,
    sessionSecret: 'dev-only-change-me',
    webhookSecret: 'dev-secret',
    secure: false,
    idleTtlMs: process.env.IDLE_TTL_MS ? Number(process.env.IDLE_TTL_MS) : undefined,
    resolveEmail,
    publicBaseUrl,
    // No pg-boss against pglite — run the dispatch in-process so triggers fire
    // (and `wait` steps defer via the runner's default setTimeout) right here.
    dispatch,
  })

  // Dev-only helpers, never mounted by the production entry point (server/index.ts).
  const dev = new Hono()
  dev.get('/__dev/outbox', (c) => c.json({ messages: outbox }))
  // Pretend the 72 h edit window of a note has passed (the application itself can never do this).
  dev.post('/__dev/close-note-window/:id', async (c) => {
    await pg.exec(`SET session_replication_role = replica; UPDATE session_notes SET locks_at = now() - interval '1 minute' WHERE id = '${c.req.param('id').replace(/[^A-Za-z0-9_-]/g, '')}'; SET session_replication_role = DEFAULT;`)
    return c.json({ ok: true })
  })
  dev.route('/', app)

  const port = Number(process.env.PORT ?? 8790)
  serve({ fetch: dev.fetch, port })
  console.log(`psycrm DEV api (pglite, in-memory, no integrations) listening on :${port}`)
  console.log(`login: ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

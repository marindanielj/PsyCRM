import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { serve } from '@hono/node-server'
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

  const app = createApp({
    db,
    sessionSecret: 'dev-only-change-me',
    webhookSecret: 'dev-secret',
    secure: false,
    // No email provider offline: print what would be sent (fictional demo data only), so the
    // signing flow can be walked end to end — links and one-time codes show up in this log.
    resolveEmail: async () => ({
      ok: true,
      sender: {
        name: 'dev-console',
        sendEmail: async (m) => {
          console.log(`\n[dev email] to=${m.to}\n[dev email] subject=${m.subject}\n${m.text.split('\n').map((l) => `[dev email] ${l}`).join('\n')}\n`)
          return { externalId: 'dev', provider: 'dev-console' }
        },
      },
    }),
    publicBaseUrl: 'http://localhost:5273',
    // No pg-boss against pglite — run the dispatch in-process so triggers fire
    // (and `wait` steps defer via the runner's default setTimeout) right here.
    dispatch: async (e) => {
      await dispatchWorkflowEvent({ db }, e)
    },
  })

  const port = 8790
  serve({ fetch: app.fetch, port })
  console.log(`psycrm DEV api (pglite, in-memory, no integrations) listening on :${port}`)
  console.log(`login: ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

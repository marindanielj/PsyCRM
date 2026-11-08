import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { PgDatabase } from '../server/db/database'
import { seedDocuments } from '../server/lib/document-seed'

/**
 * Add the starter document templates (drafts) and packets to a practice that was
 * created before they existed. Idempotent. New practices get them from seed:practice.
 *
 *   DATABASE_URL=… LOCATION_ID=… npm run seed:documents
 */
async function main() {
  const url = process.env.DATABASE_URL
  const locationId = process.env.LOCATION_ID
  if (!url || !locationId) throw new Error('DATABASE_URL and LOCATION_ID required')
  const pool = new Pool({ connectionString: url })
  try {
    const r = await seedDocuments(new PgDatabase(pool), locationId)
    console.log(`psycrm: documents seeded (${r.templates} templates, ${r.packets} packets added)`)
  } finally {
    await pool.end()
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}

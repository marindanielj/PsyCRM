import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { PgDatabase } from '../server/db/database'
import { seedPractice } from '../server/lib/practice-seed'

/**
 * Create the single PsyCRM practice (idempotent). Run once per environment, after
 * `npm run migrate`:
 *
 *   DATABASE_URL=… PRACTICE_NAME="Consultorio X" OWNER_EMAIL=… OWNER_NAME=… \
 *   OWNER_PASSWORD=… npm run seed:practice
 *
 * OWNER_PASSWORD is only read when the owner does not exist yet (>= 12 chars).
 */
async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL required')
  const practiceName = process.env.PRACTICE_NAME
  const ownerEmail = process.env.OWNER_EMAIL
  if (!practiceName || !ownerEmail) throw new Error('PRACTICE_NAME and OWNER_EMAIL required')

  const pool = new Pool({ connectionString: url })
  try {
    const r = await seedPractice(new PgDatabase(pool), {
      practiceName,
      ownerEmail,
      ownerName: process.env.OWNER_NAME,
      ownerPassword: process.env.OWNER_PASSWORD,
      // With a verified SES sender configured for the deployment, new practices send through Amazon SES.
      emailProvider: process.env.SES_FROM_ADDRESS ? 'ses' : undefined,
    })
    console.log(
      `psycrm: practice ready (location ${r.locationId}, owner ${r.createdOwner ? 'created' : 'already existed'})`,
    )
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

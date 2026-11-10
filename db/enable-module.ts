import { Pool } from 'pg'
import { PgDatabase } from '../server/db/database'
import { enableModule } from '../server/lib/enable-module'

/**
 * Turn a product module on for one practice. Safe to repeat. Run as a one-off task against the production database:
 *
 *   DATABASE_URL=… PRACTICE_SLUG=<slug of the practice> MODULE=billing npm run enable-module
 *
 * It prints the practice's module list afterwards (module names only, never client data).
 */
async function main() {
  const url = process.env.DATABASE_URL
  const slug = process.env.PRACTICE_SLUG
  const module = process.env.MODULE
  if (!url) throw new Error('DATABASE_URL required')
  if (!slug || !module) throw new Error('PRACTICE_SLUG and MODULE required')

  const pool = new Pool({ connectionString: url })
  try {
    const r = await enableModule(new PgDatabase(pool), slug, module)
    if (!r.ok) {
      console.error(r.error === 'unknown_module' ? `enable-module: "${module}" is not a module name` : `enable-module: no practice with slug "${slug}"`)
      process.exitCode = 1
      return
    }
    console.log(`enable-module: ${r.changed ? `"${module}" is now ON` : `"${module}" was already on (nothing changed)`} for "${slug}"`)
    console.log(`enable-module: modules now: ${r.modules.join(', ')}`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('enable-module failed:', (err as { code?: string }).code ?? 'unknown error')
  process.exit(1)
})

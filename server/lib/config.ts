import { z } from 'zod'
import { INTEGRATION_NAMES, type Integration, parseIntegrations } from './integrations'

/**
 * Environment parsing with safe dev defaults. Secrets default to obviously
 * non-production values so the app runs locally without a .env, but in
 * production those defaults are rejected at boot (see assertProdSecret): a
 * deploy that forgets to override a secret fails fast instead of silently
 * shipping a well-known HMAC key an attacker could use to forge sessions or
 * webhook calls. DATABASE_URL is optional here and asserted at boot, so this
 * stays importable in tests without a database.
 */
const DEV_SESSION_SECRET = 'dev-only-change-me'
const DEV_WEBHOOK_SECRET = 'dev-secret'
const MIN_PROD_SECRET_LEN = 32

const EnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(1).default(DEV_SESSION_SECRET),
  CHATWOOT_WEBHOOK_SECRET: z.string().min(1).default(DEV_WEBHOOK_SECRET),
  PORT: z.coerce.number().int().positive().default(8790),
  NODE_ENV: z.string().default('development'),
  // The hub gateway's shared bearer for /federation/*. Optional + no dev default:
  // when unset the federation surface is inert (503). If present in production it
  // must be long enough to resist guessing.
  FEDERATION_SERVICE_TOKEN: z.string().optional(),
  // Third-party integrations to turn ON (comma-separated; none by default). Each one
  // moves client information to a vendor, so each is enabled on purpose, one at a
  // time, after a BAA — see lib/integrations.ts and docs/psycrm/INTEGRACIONES.md.
  // An unknown name fails the boot instead of being silently ignored.
  ENABLED_INTEGRATIONS: z
    .string()
    .default('')
    .transform((raw, ctx): Integration[] => {
      const { enabled, unknown } = parseIntegrations(raw)
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown integration(s): ${unknown.join(', ')} (valid: ${INTEGRATION_NAMES.join(', ')})`,
        })
        return z.NEVER
      }
      return enabled
    }),
  // Public origin used to build links in outbound email (document signing, etc.).
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Amazon SES: the verified sender and region (the task's IAM role is the credential; there is no key). */
  SES_FROM_ADDRESS: z.string().optional(),
  SES_REGION: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
  // Directory holding the built web app (vite build output) to serve from the API
  // process. Empty = serve no static files (dev: Vite serves the SPA itself).
  STATIC_DIR: z.string().optional(),
})

export type Config = z.infer<typeof EnvSchema>

/** In production a secret must be overridden away from the shipped default and
 *  long enough (>=32 chars) to make HMAC forgery infeasible. */
function assertProdSecret(name: string, value: string, devDefault: string): void {
  if (value === devDefault) {
    throw new Error(`${name} must be overridden in production (it is still the dev default)`)
  }
  if (value.length < MIN_PROD_SECRET_LEN) {
    throw new Error(`${name} must be at least ${MIN_PROD_SECRET_LEN} characters in production`)
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const config = EnvSchema.parse(env)
  if (config.NODE_ENV === 'production') {
    assertProdSecret('SESSION_SECRET', config.SESSION_SECRET, DEV_SESSION_SECRET)
    // The Chatwoot webhook secret only matters while that integration is on.
    if (config.ENABLED_INTEGRATIONS.includes('chatwoot')) {
      assertProdSecret('CHATWOOT_WEBHOOK_SECRET', config.CHATWOOT_WEBHOOK_SECRET, DEV_WEBHOOK_SECRET)
    }
    if (config.FEDERATION_SERVICE_TOKEN !== undefined && config.FEDERATION_SERVICE_TOKEN.length < MIN_PROD_SECRET_LEN) {
      throw new Error(`FEDERATION_SERVICE_TOKEN must be at least ${MIN_PROD_SECRET_LEN} characters in production`)
    }
    // The signing and invitation links in emails are built from this. Behind a load balancer a request's own
    // origin is http://, so guessing it would put insecure (or wrong) links in front of clients.
    if (!config.PUBLIC_BASE_URL || !config.PUBLIC_BASE_URL.startsWith('https://')) {
      throw new Error('PUBLIC_BASE_URL must be set to the https:// address of the app in production (it is used in emailed links)')
    }
    // PHI in transit to the database must be encrypted AND the server verified.
    // node-postgres reads sslmode / sslrootcert from the URL (also used by pg-boss).
    if (config.DATABASE_URL && !/[?&]sslmode=verify-(full|ca)\b/.test(config.DATABASE_URL)) {
      throw new Error('DATABASE_URL must use sslmode=verify-full (with sslrootcert) in production')
    }
  }
  return config
}

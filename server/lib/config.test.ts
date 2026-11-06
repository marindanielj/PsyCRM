import { loadConfig } from './config'

test('applies dev defaults and coerces PORT from a string', () => {
  const c = loadConfig({ PORT: '9001' })
  expect(c.PORT).toBe(9001)
  expect(c.SESSION_SECRET).toBe('dev-only-change-me')
  expect(c.CHATWOOT_WEBHOOK_SECRET).toBe('dev-secret')
  expect(c.NODE_ENV).toBe('development')
  expect(c.DATABASE_URL).toBeUndefined()
})

const STRONG = 'x'.repeat(32)

test('reads provided values over defaults', () => {
  const c = loadConfig({
    SESSION_SECRET: STRONG,
    CHATWOOT_WEBHOOK_SECRET: STRONG,
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://x?sslmode=verify-full',
  })
  expect(c.SESSION_SECRET).toBe(STRONG)
  expect(c.NODE_ENV).toBe('production')
  expect(c.DATABASE_URL).toBe('postgres://x?sslmode=verify-full')
  expect(c.PORT).toBe(8790)
})

test('rejects the dev-default SESSION_SECRET in production', () => {
  expect(() =>
    loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'dev-only-change-me', CHATWOOT_WEBHOOK_SECRET: STRONG }),
  ).toThrow(/SESSION_SECRET/)
})

test('rejects the dev-default CHATWOOT_WEBHOOK_SECRET in production once the chatwoot integration is on', () => {
  expect(() =>
    loadConfig({ NODE_ENV: 'production', SESSION_SECRET: STRONG, CHATWOOT_WEBHOOK_SECRET: 'dev-secret', ENABLED_INTEGRATIONS: 'chatwoot' }),
  ).toThrow(/CHATWOOT_WEBHOOK_SECRET/)
})

test('the chatwoot webhook secret is not needed while that integration is off', () => {
  expect(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: STRONG }).ENABLED_INTEGRATIONS).toEqual([])
})

test('rejects a too-short secret in production', () => {
  expect(() =>
    loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short', CHATWOOT_WEBHOOK_SECRET: STRONG }),
  ).toThrow(/32 characters/)
})

test('allows a short non-default secret outside production', () => {
  const c = loadConfig({ NODE_ENV: 'development', SESSION_SECRET: 'short-dev' })
  expect(c.SESSION_SECRET).toBe('short-dev')
})

test('FEDERATION_SERVICE_TOKEN is undefined when unset (federation stays inert)', () => {
  const cfg = loadConfig({ NODE_ENV: 'development' })
  expect(cfg.FEDERATION_SERVICE_TOKEN).toBeUndefined()
})

test('FEDERATION_SERVICE_TOKEN passes through when set', () => {
  const cfg = loadConfig({ NODE_ENV: 'development', FEDERATION_SERVICE_TOKEN: 'tok-123' })
  expect(cfg.FEDERATION_SERVICE_TOKEN).toBe('tok-123')
})

test('a too-short FEDERATION_SERVICE_TOKEN is rejected in production', () => {
  expect(() =>
    loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(32),
      CHATWOOT_WEBHOOK_SECRET: 'y'.repeat(32),
      FEDERATION_SERVICE_TOKEN: 'short',
    }),
  ).toThrow(/FEDERATION_SERVICE_TOKEN/)
})

const SSL_URL = 'postgres://u:p@h:5432/db?sslmode=verify-full&sslrootcert=/app/certs/rds.pem'
const prod = { NODE_ENV: 'production', SESSION_SECRET: STRONG }

test('production requires a verified-SSL database URL (always, not behind a mode flag)', () => {
  expect(() => loadConfig({ ...prod, DATABASE_URL: 'postgres://u:p@h/db' })).toThrow(/sslmode=verify-full/)
  expect(() => loadConfig({ ...prod, DATABASE_URL: 'postgres://u:p@h/db?sslmode=require' })).toThrow(/sslmode=verify-full/)
  expect(() => loadConfig({ ...prod, DATABASE_URL: 'postgres://u:p@h/db?sslmode=disable' })).toThrow(/sslmode=verify-full/)
  expect(loadConfig({ ...prod, DATABASE_URL: SSL_URL }).DATABASE_URL).toBe(SSL_URL)
  expect(loadConfig({ ...prod, DATABASE_URL: 'postgres://u:p@h/db?sslmode=verify-ca' }).DATABASE_URL).toContain('verify-ca')
})

test('outside production a plain database URL is fine (local dev)', () => {
  expect(loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/db' }).DATABASE_URL).toBe('postgres://u:p@localhost/db')
})

test('no integration is enabled by default', () => {
  expect(loadConfig({}).ENABLED_INTEGRATIONS).toEqual([])
  expect(loadConfig({ ENABLED_INTEGRATIONS: '' }).ENABLED_INTEGRATIONS).toEqual([])
  expect(loadConfig({ ENABLED_INTEGRATIONS: ' , ' }).ENABLED_INTEGRATIONS).toEqual([])
})

test('ENABLED_INTEGRATIONS turns on exactly the named integrations (trimmed, any case, de-duplicated)', () => {
  expect(loadConfig({ ENABLED_INTEGRATIONS: 'chatwoot, AI ,chatwoot' }).ENABLED_INTEGRATIONS).toEqual(['chatwoot', 'ai'])
})

test('an unknown integration name stops the boot instead of being ignored (a typo must never look like it worked)', () => {
  expect(() => loadConfig({ ENABLED_INTEGRATIONS: 'chatwot' })).toThrow(/unknown integration\(s\): chatwot/)
  expect(() => loadConfig({ ENABLED_INTEGRATIONS: 'chatwoot,twilio' })).toThrow(/twilio/)
})

test('the old PSYCRM_MODE variable no longer does anything', () => {
  expect('PSYCRM_MODE' in loadConfig({ PSYCRM_MODE: 'true' })).toBe(false)
})

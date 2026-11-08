import { afterEach, describe, expect, it } from 'vitest'
import { FakeDatabase } from '../../db/fake-database'
import { resolveEmailSender, resolveSmsSender } from './resolve'

// Secrets resolve by NAME via the env-backed vault layer, same as payments:
// <slug>:brevo:api_key -> ACME_BREVO_API_KEY. client_slug wins over slug.
const ENV_KEYS = ['ACME_BREVO_API_KEY', 'ACME_TWILIO_ACCOUNT_SID', 'ACME_TWILIO_AUTH_TOKEN']

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

function dbWithLocation(settings: Record<string, unknown>, clientSlug: string | null = 'acme') {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'locA', name: 'Acme', slug: 'acme-loc', client_slug: clientSlug, branding: {}, settings }])
  return db
}

describe('resolveEmailSender', () => {
  it('builds a brevo sender when the location chose brevo with a sender email and the key resolves', async () => {
    process.env.ACME_BREVO_API_KEY = 'xkeysib-x'
    const resolved = await resolveEmailSender(
      dbWithLocation({ sending: { emailProvider: 'brevo', fromEmail: 'ops@acme.com', fromName: 'Acme' } }),
      'locA',
    )
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.sender.name).toBe('brevo')
  })

  it('reports an unconfigured brevo key instead of throwing', async () => {
    const resolved = await resolveEmailSender(
      dbWithLocation({ sending: { emailProvider: 'brevo', fromEmail: 'ops@acme.com' } }),
      'locA',
    )
    expect(resolved).toEqual({ ok: false, reason: 'brevo key is not configured' })
  })

  it('requires a sender email even when the key resolves', async () => {
    process.env.ACME_BREVO_API_KEY = 'xkeysib-x'
    const resolved = await resolveEmailSender(dbWithLocation({ sending: { emailProvider: 'brevo' } }), 'locA')
    expect(resolved).toEqual({ ok: false, reason: 'sender email is not configured' })
  })

  it('reports no provider connected for a fresh location', async () => {
    const resolved = await resolveEmailSender(dbWithLocation({}), 'locA')
    expect(resolved).toEqual({ ok: false, reason: 'no email provider connected' })
  })

  it('falls back to the location slug when there is no client_slug', async () => {
    process.env.ACME_LOC_BREVO_API_KEY = 'xkeysib-x'
    try {
      const resolved = await resolveEmailSender(
        dbWithLocation({ sending: { emailProvider: 'brevo', fromEmail: 'ops@acme.com' } }, null),
        'locA',
      )
      expect(resolved.ok).toBe(true)
    } finally {
      delete process.env.ACME_LOC_BREVO_API_KEY
    }
  })

  it('reports a missing location', async () => {
    const db = new FakeDatabase()
    db.enqueue([])
    expect(await resolveEmailSender(db, 'nope')).toEqual({ ok: false, reason: 'location not found' })
  })
})

describe('resolveSmsSender', () => {
  it('builds a twilio sender when the location chose twilio with a from number and both keys resolve', async () => {
    process.env.ACME_TWILIO_ACCOUNT_SID = 'AC_x'
    process.env.ACME_TWILIO_AUTH_TOKEN = 'tok_x'
    const resolved = await resolveSmsSender(
      dbWithLocation({ sending: { smsProvider: 'twilio', smsFrom: '+14805550111' } }),
      'locA',
    )
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.sender.name).toBe('twilio')
  })

  it('reports unconfigured twilio keys instead of throwing', async () => {
    const resolved = await resolveSmsSender(
      dbWithLocation({ sending: { smsProvider: 'twilio', smsFrom: '+14805550111' } }),
      'locA',
    )
    expect(resolved).toEqual({ ok: false, reason: 'twilio keys are not configured' })
  })

  it('requires the from number even when the keys resolve', async () => {
    process.env.ACME_TWILIO_ACCOUNT_SID = 'AC_x'
    process.env.ACME_TWILIO_AUTH_TOKEN = 'tok_x'
    const resolved = await resolveSmsSender(dbWithLocation({ sending: { smsProvider: 'twilio' } }), 'locA')
    expect(resolved).toEqual({ ok: false, reason: 'sms from number is not configured' })
  })

  it('reports no provider connected for a fresh location', async () => {
    const resolved = await resolveSmsSender(dbWithLocation({}), 'locA')
    expect(resolved).toEqual({ ok: false, reason: 'no sms provider connected' })
  })

  it('reports a missing location', async () => {
    const db = new FakeDatabase()
    db.enqueue([])
    expect(await resolveSmsSender(db, 'nope')).toEqual({ ok: false, reason: 'location not found' })
  })
})

describe('resolveEmailSender with Amazon SES', () => {
  it('builds an SES sender from the practice sender when the practice chose SES', async () => {
    const r = await resolveEmailSender(dbWithLocation({ sending: { emailProvider: 'ses', fromEmail: 'no-reply@consultorio.example', fromName: 'Consultorio' } }), 'locA', {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sender.name).toBe('ses')
  })

  it("falls back to the deployment's verified sender (SES_FROM_ADDRESS) when the practice sets none", async () => {
    const r = await resolveEmailSender(dbWithLocation({ sending: { emailProvider: 'ses' } }), 'locA', { SES_FROM_ADDRESS: 'no-reply@platform.example' })
    expect(r.ok).toBe(true)
  })

  it('needs no API key: there is nothing to look up in the vault', async () => {
    delete process.env.ACME_SES_API_KEY
    const r = await resolveEmailSender(dbWithLocation({ sending: { emailProvider: 'ses', fromEmail: 'no-reply@consultorio.example' } }), 'locA', {})
    expect(r.ok).toBe(true)
  })

  it('says so when there is no sender anywhere, or the sender is not a real address', async () => {
    expect(await resolveEmailSender(dbWithLocation({ sending: { emailProvider: 'ses' } }), 'locA', {})).toEqual({ ok: false, reason: 'sender email is not configured' })
    expect(await resolveEmailSender(dbWithLocation({ sending: { emailProvider: 'ses', fromEmail: 'x, y@evil.example' } }), 'locA', {})).toEqual({ ok: false, reason: 'sender email is not valid' })
  })

  it('a practice that chose "none" is not switched to SES by the deployment default', async () => {
    expect(await resolveEmailSender(dbWithLocation({ sending: { emailProvider: 'none' } }), 'locA', { SES_FROM_ADDRESS: 'no-reply@platform.example' })).toEqual({ ok: false, reason: 'no email provider connected' })
  })
})

/**
 * Integrations that move client information to a third party. PsyCRM keeps every
 * one of them OFF by default and mounts one only when it is named in the
 * ENABLED_INTEGRATIONS environment variable (comma-separated). Turning one on is a
 * deliberate, per-integration act — meant to follow a signed BAA with that vendor,
 * a review of what data crosses over, and audit coverage for the new code path —
 * never a side effect of a global mode. See docs/psycrm/INTEGRACIONES.md.
 *
 * Unknown names are an error, so a typo can never silently leave an integration
 * off (or, worse, look like it is on).
 *
 * This is separate from the per-practice `enabledModules` list (what the UI shows):
 * a module such as `conversations` is shown by that list, but the inbound relay that
 * would feed it only exists once `chatwoot` is enabled here.
 */
export const INTEGRATIONS = {
  chatwoot: {
    label: 'Chatwoot inbox relay',
    mounts: 'POST /api/webhooks/chatwoot (inbound messages) and the inbound-message workflow trigger',
    vendor: 'the Chatwoot host and the channels behind it (SMS, WhatsApp, email…)',
  },
  ai: {
    label: 'AI agent and assistant',
    mounts: 'Claude client, the agent-reply worker, the assistant routes and the approve-first text rail',
    vendor: 'Anthropic (and the text gateway)',
  },
  public_pages: {
    label: 'Public marketing pages',
    mounts: '/api/public/{f,forms,reviews,courses,blog,communities,surveys,proposals,l,ref}',
    vendor: 'none directly, but visitors submit personal data to unauthenticated pages',
  },
  payments: {
    label: 'Payment-processor webhooks',
    mounts: '/api/public/pay (Stripe/Square callbacks)',
    vendor: 'Stripe or Square',
  },
  voice: {
    label: 'Voice-provider webhooks',
    mounts: '/api/public/voice (Twilio/Vapi call reports)',
    vendor: 'Twilio or Vapi',
  },
  federation: {
    label: 'Acme Hub federation',
    mounts: '/federation/*',
    vendor: 'the hub gateway',
  },
  push: {
    label: 'Mobile push tokens',
    mounts: '/api/push-tokens',
    vendor: 'the push provider',
  },
} as const

export type Integration = keyof typeof INTEGRATIONS
export const INTEGRATION_NAMES = Object.keys(INTEGRATIONS) as Integration[]

const KNOWN = new Set<string>(INTEGRATION_NAMES)

export function isIntegration(value: string): value is Integration {
  return KNOWN.has(value)
}

/**
 * Parse the ENABLED_INTEGRATIONS value. Empty / unset = none. Names are trimmed,
 * lower-cased and de-duplicated; any unknown name is reported (never ignored).
 */
export function parseIntegrations(raw: string | undefined): { enabled: Integration[]; unknown: string[] } {
  const enabled = new Set<Integration>()
  const unknown: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim().toLowerCase()
    if (!name) continue
    if (isIntegration(name)) enabled.add(name)
    else unknown.push(name)
  }
  return { enabled: [...enabled], unknown }
}

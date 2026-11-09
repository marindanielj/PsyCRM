import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { Pool } from 'pg'
import type { AppEnv } from './app-env'
import { PgDatabase } from './db/database'
import type { Database } from './db/database'
import type { ClaudeClient } from './jobs/agent-reply'
import {
  enqueueAgentReply,
  enqueueWorkflowEvent,
  registerAgentReplyWorker,
  registerWorkflowDispatchWorker,
  startBoss,
} from './jobs/boss'
import type { WorkflowDispatch } from './jobs/workflow-dispatcher'
import { createAnthropicClient } from './lib/anthropic'
import type { sendChatwootMessage } from './lib/chatwoot-client'
import { loadConfig } from './lib/config'
import type { Integration } from './lib/integrations'
import { IDLE_TTL_MS } from './lib/session'
import type { Module } from './lib/modules'
import { moduleGate } from './middleware/module-gate'
import { auditRoute } from './routes/audit'
import { practiceRoute } from './routes/practice'
import type { ResolvedEmailSender } from './lib/sending/resolve'
import { documentsRoute } from './routes/documents'
import { brandLogoRoute, brandingRoute } from './routes/branding'
import { invitesRoute } from './routes/invites'
import { publicDocumentsRoute } from './routes/public-documents'
import { publicInvitesRoute } from './routes/public-invites'
import { sessionNotesRoute } from './routes/session-notes'
import { notifyPush } from './lib/notify-push'
import type { SendTextFn } from './lib/operator-tools'
import { makeHttpSendText } from './lib/send-text-rail'
import { operatorAuth } from './middleware/auth'
import { locationAccess } from './middleware/location-access'
import { affiliatesRoute } from './routes/affiliates'
import { assistantRoute } from './routes/assistant'
import { OperatorsRepo } from './repos/operators-repo'
import { authRoute } from './routes/auth'
import { blogRoute } from './routes/blog'
import { calendarsRoute } from './routes/calendars'
import { callsRoute } from './routes/calls'
import { campaignsRoute } from './routes/campaigns'
import { communitiesRoute } from './routes/communities'
import { contactsRoute } from './routes/contacts'
import { conversationsRoute } from './routes/conversations'
import { coursesRoute } from './routes/courses'
import { customFieldsRoute } from './routes/custom-fields'
import { customValuesRoute } from './routes/custom-values'
import { federationRoute } from './routes/federation'
import { formsRoute } from './routes/forms'
import { funnelsRoute } from './routes/funnels'
import { invoicesRoute } from './routes/invoices'
import { locationsRoute } from './routes/locations'
import { opportunitiesRoute } from './routes/opportunities'
import { couponsRoute } from './routes/coupons'
import { pipelinesRoute } from './routes/pipelines'
import { productsRoute } from './routes/products'
import { proposalsRoute } from './routes/proposals'
import { pushTokensRoute } from './routes/push-tokens'
import { settingsRoute } from './routes/settings'
import { subscriptionsRoute } from './routes/subscriptions'
import { transactionsRoute } from './routes/transactions'
import { publicAffiliatesRoute } from './routes/public-affiliates'
import { publicBlogRoute } from './routes/public-blog'
import { publicBookingRoute } from './routes/public-booking'
import { publicCommunitiesRoute } from './routes/public-communities'
import { publicCoursesRoute } from './routes/public-courses'
import { publicFormsRoute } from './routes/public-forms'
import { publicFunnelsRoute } from './routes/public-funnels'
import { publicProposalsRoute } from './routes/public-proposals'
import { publicReviewsRoute } from './routes/public-reviews'
import { publicSurveysRoute } from './routes/public-surveys'
import { publicTriggerLinksRoute } from './routes/public-trigger-links'
import { reportingRoute } from './routes/reporting'
import { reviewsRoute } from './routes/reviews'
import { socialRoute } from './routes/social'
import { surveysRoute } from './routes/surveys'
import { tagsRoute } from './routes/tags'
import { tasksRoute } from './routes/tasks'
import { templatesRoute } from './routes/templates'
import { triggerLinksRoute } from './routes/trigger-links'
import { type InboundEvent, chatwootWebhookRoute } from './routes/webhooks-chatwoot'
import { paymentsWebhookRoute } from './routes/webhooks-payments'
import { voiceWebhookRoute } from './routes/webhooks-voice'
import { workflowsRoute } from './routes/workflows'

export interface AppDeps {
  db: Database
  sessionSecret: string
  webhookSecret: string
  /** Set Secure on the session cookie (true in production over HTTPS). */
  secure?: boolean
  /** Phase E hook: enqueue the agent-reply job after a fresh inbound. */
  onInbound?: (e: InboundEvent) => void | Promise<void>
  /** Phase 7 hook: fan a trigger event out to its live workflows. */
  dispatch?: WorkflowDispatch
  /** Claude client for the "Draft from agent" composer button. */
  claude?: ClaudeClient
  /** Injectable Chatwoot sender — dev-server stubs it so Send works offline. */
  sendMessage?: typeof sendChatwootMessage
  /** The gateway text rail for the assistant's approve-first send_text. Prod
   *  injects the real HTTP rail; absent = texting honestly reports "not set up". */
  sendText?: SendTextFn
  /** The hub gateway's shared bearer for /federation/*. Unset => surface is 503. */
  federationServiceToken?: string
  /** Third-party integrations to mount (none by default). Each moves client data to a
   *  vendor, so each is turned on deliberately — see lib/integrations.ts. */
  integrations?: readonly Integration[]
  /** Sign a web session out after this much inactivity (default IDLE_TTL_MS). */
  idleTtlMs?: number
  /** Directory of the built web app to serve (vite build output). Unset = none. */
  staticDir?: string
  /** Builds the practice's email sender (signing links and codes). Injectable for tests and dev. */
  resolveEmail?: (db: Database, locationId: string) => Promise<ResolvedEmailSender>
  /** Public origin for the links in emails (PUBLIC_BASE_URL). Falls back to each request's origin. */
  publicBaseUrl?: string
}

/** Route-group -> module key, for PsyCRM-mode gating. Groups missing here
 *  (custom-fields, custom-values, settings, practice) are infrastructure that
 *  is always available. */
const ROUTE_MODULE: Record<string, Module> = {
  contacts: 'contacts',
  conversations: 'conversations',
  assistant: 'assistant',
  opportunities: 'opportunities',
  pipelines: 'opportunities',
  calendars: 'calendars',
  campaigns: 'marketing',
  workflows: 'automations',
  reporting: 'reporting',
  funnels: 'sites',
  forms: 'forms',
  invoices: 'payments',
  products: 'payments',
  subscriptions: 'payments',
  coupons: 'payments',
  transactions: 'payments',
  calls: 'calls',
  reviews: 'reputation',
  courses: 'memberships',
  blog: 'blog',
  communities: 'communities',
  social: 'social',
  surveys: 'surveys',
  proposals: 'proposals',
  'trigger-links': 'trigger_links',
  affiliates: 'affiliates',
  tasks: 'tasks',
  templates: 'templates',
  tags: 'tags',
  audit: 'audit',
  'session-notes': 'session_notes',
  invites: 'contacts',
  documents: 'documents',
}

/**
 * Builds the full Hono app. Pure (no I/O at construction) so tests mount it with
 * a FakeDatabase. Route groups:
 *   - public:        /health, /api/auth/*, /api/webhooks/chatwoot (own secret), /api/public/{f,forms,proposals}/* (hosted funnel + form + proposal pages)
 *   - operator-auth: /api/locations
 *   - auth + tenant: /api/loc/:loc/{contacts,conversations,opportunities,calendars,campaigns,workflows,reporting,funnels,forms,invoices,surveys,proposals}/*  (locationAccess -> 403)
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const on = new Set<Integration>(deps.integrations ?? [])
  const idleTtlMs = deps.idleTtlMs ?? IDLE_TTL_MS
  // A password change voids the sessions issued before it, so each request asks when the operator last changed theirs.
  const operatorsRepo = new OperatorsRepo(deps.db)
  const revokedBefore = (operatorId: string) => operatorsRepo.passwordChangedAt(operatorId)
  const auth = () => operatorAuth(deps.sessionSecret, { idleTtlMs, secure: deps.secure, revokedBefore })

  {
    // Clinical data: nothing cacheable, nothing embeddable, no referrer leakage
    // (public signing links carry a token in the path), HTTPS pinned. The CSP is
    // strict for the app + API; the server-rendered public pages (which inline a
    // small script/style) get the same headers minus CSP until they use nonces.
    const baseHeaders = {
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      crossOriginEmbedderPolicy: false,
    } as const
    const csp = {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    }
    const strict = secureHeaders({ ...baseHeaders, contentSecurityPolicy: csp })
    const relaxed = secureHeaders({ ...baseHeaders, contentSecurityPolicy: undefined })
    app.use('*', (c, next) => (c.req.path.startsWith('/api/public/') || c.req.path.startsWith('/d/') || c.req.path.startsWith('/i/') ? relaxed(c, next) : strict(c, next)))
    app.use('/api/*', async (c, next) => {
      await next()
      c.header('Cache-Control', 'no-store')
      if (c.req.path.startsWith('/api/public/')) c.header('X-Robots-Tag', 'noindex')
    })
  }

  app.notFound((c) => c.json({ error: 'not found' }, 404))

  // The default handler prints the whole error, and a database error can carry the offending VALUES
  // (a duplicate email, a name): that would put client data in the logs. Log the code and the method only.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error('request failed', c.req.method, (err as { code?: unknown } | null)?.code ?? 'unknown')
    return c.json({ error: 'internal error' }, 500)
  })

  app.get('/health', (c) => c.json({ ok: true, service: 'psycrm' }))

  app.route('/api/auth', authRoute({ db: deps.db, sessionSecret: deps.sessionSecret, secure: deps.secure, idleTtlMs, revokedBefore }))
  // Integrations that carry client data to third parties. NONE is mounted unless it
  // is named in `deps.integrations` (ENABLED_INTEGRATIONS): enabling one is a
  // deliberate step that should follow a BAA with that vendor. Only the public
  // booking page below is always on (its calendars stay off until the practice
  // turns booking on).
  if (on.has('chatwoot')) {
    app.route(
      '/api/webhooks/chatwoot',
      chatwootWebhookRoute({ db: deps.db, webhookSecret: deps.webhookSecret, onInbound: deps.onInbound }),
    )
  }
  if (on.has('public_pages')) {
    // Public hosted funnel + form pages — unauthenticated, read location from the
    // URL. Mounted before the operatorAuth boundary so visitors never hit a login.
    app.route('/api/public/f', publicFunnelsRoute({ db: deps.db, dispatch: deps.dispatch }))
    app.route('/api/public/forms', publicFormsRoute({ db: deps.db, dispatch: deps.dispatch }))
    app.route('/api/public/reviews', publicReviewsRoute({ db: deps.db }))
    app.route('/api/public/courses', publicCoursesRoute({ db: deps.db }))
    app.route('/api/public/blog', publicBlogRoute({ db: deps.db }))
    // Public hosted community space — read-only feed of published communities.
    app.route('/api/public/communities', publicCommunitiesRoute({ db: deps.db }))
    app.route('/api/public/surveys', publicSurveysRoute({ db: deps.db, dispatch: deps.dispatch }))
    // Public signable proposal pages — render, sign, decline; a signature fires the
    // proposal_signed trigger so an accepted proposal can start an automation.
    app.route('/api/public/proposals', publicProposalsRoute({ db: deps.db, dispatch: deps.dispatch }))
    // Trigger links redirect + record a click, then fire trigger_link_clicked, so
    // the public hop carries the dispatch like funnels/forms do.
    app.route('/api/public/l', publicTriggerLinksRoute({ db: deps.db, dispatch: deps.dispatch }))
    // Affiliate referral links: record the visit (attributed when ?c= names a real
    // contact), then 302 to the program landing URL. Self-contained — no dispatch.
    app.route('/api/public/ref', publicAffiliatesRoute({ db: deps.db }))
  }
  if (on.has('payments')) {
    // Payment-processor webhooks + the post-checkout landing page. Signature-
    // verified per location; a completed checkout marks the invoice paid.
    app.route('/api/public/pay', paymentsWebhookRoute({ db: deps.db }))
  }
  if (on.has('voice')) {
    // Voice-provider webhooks (Twilio status callbacks / Vapi call reports).
    // Signature-verified per location; events keep the call log honest.
    app.route('/api/public/voice', voiceWebhookRoute({ db: deps.db }))
  }
  if (on.has('federation')) {
    // The Acme Hub federation surface. Mounted OUTSIDE the operator-session
    // boundary because it carries its own bearer gate (the hub gateway's shared
    // service token); it is inert (503) until federationServiceToken is set. The
    // tenant rides in the trusted X-Federation-Tenant header, never the body.
    app.route(
      '/',
      federationRoute({
        db: deps.db,
        federationServiceToken: deps.federationServiceToken,
        claude: deps.claude,
        sendText: deps.sendText,
      }),
    )
  }
  // Hosted booking pages: pick a day + time, leave details. A booking creates a
  // contact + appointment and fires appointment_booked into live automations.
  // Client-facing signing pages (one-time-code verified, strict per-page CSP). Always on; a practice that turns the documents module off gets "invalid link".
  app.route('/d', publicDocumentsRoute({ db: deps.db, sessionSecret: deps.sessionSecret, secure: deps.secure, dispatch: deps.dispatch, resolveEmail: deps.resolveEmail, publicBaseUrl: deps.publicBaseUrl }))
  // Client invitation pages (one-time link, own nonce CSP). Always on; a practice with contacts off gets "invalid link".
  // A practice's logo, for the pages its clients see.
  app.route('/brand', brandLogoRoute({ db: deps.db }))
  app.route('/i', publicInvitesRoute({ db: deps.db, dispatch: deps.dispatch }))
  app.route('/api/public/booking', publicBookingRoute({ db: deps.db, dispatch: deps.dispatch, requireDateOfBirth: true }))

  app.use('/api/locations', auth())
  app.route('/api/locations', locationsRoute({ db: deps.db }))

  if (on.has('push')) {
    app.use('/api/push-tokens', auth())
    app.route('/api/push-tokens', pushTokensRoute({ db: deps.db }))
  }

  app.use('/api/loc/:loc/*', auth())
  app.use('/api/loc/:loc/*', locationAccess(deps.db))
  {
    // 404 any route group whose module this location has not enabled.
    for (const [group, module] of Object.entries(ROUTE_MODULE)) {
      // `/x/*` also matches `/x` itself; one registration = one settings lookup per request.
      app.use(`/api/loc/:loc/${group}/*`, moduleGate(deps.db, module))
    }
  }
  app.route('/api/loc/:loc/contacts', contactsRoute({ db: deps.db, requireDateOfBirth: true, dispatch: deps.dispatch }))
  app.route(
    '/api/loc/:loc/conversations',
    conversationsRoute({ db: deps.db, claude: deps.claude, sendMessage: deps.sendMessage }),
  )
  // The "AI front door" — operator chats in plain English, the assistant reads
  // across the location with its tools and answers, and (approve-first) drafts a
  // text the operator confirms. The confirm tap is the only send path; deps.sendText
  // is the gateway rail it goes through. 501 when no Claude client is configured.
  if (on.has('ai')) {
    app.route('/api/loc/:loc/assistant', assistantRoute({ db: deps.db, claude: deps.claude, sendText: deps.sendText }))
  }
  app.route('/api/loc/:loc/opportunities', opportunitiesRoute({ db: deps.db, dispatch: deps.dispatch }))
  // Pipeline + stage *structure* management (the Settings -> Pipelines area). The
  // opportunities route owns the board reads/writes; this owns create/rename/
  // delete of pipelines and their stages, with guarded deletes (never a silent
  // cascade over live deals).
  app.route('/api/loc/:loc/pipelines', pipelinesRoute({ db: deps.db }))
  app.route('/api/loc/:loc/calendars', calendarsRoute({ db: deps.db, dispatch: deps.dispatch }))
  app.route('/api/loc/:loc/campaigns', campaignsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/workflows', workflowsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/reporting', reportingRoute({ db: deps.db }))
  app.route('/api/loc/:loc/funnels', funnelsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/forms', formsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/invoices', invoicesRoute({ db: deps.db }))
  // The reusable product/service catalog (Payments -> Products): saved items an
  // invoice or proposal can be built from. Editing it never sends or moves money.
  app.route('/api/loc/:loc/products', productsRoute({ db: deps.db }))
  // Recurring-commitment ledger (Payments -> Subscriptions): tracks who is on a
  // recurring arrangement and derives MRR and renewals. Bookkeeping only — it
  // never charges a card or moves money.
  app.route('/api/loc/:loc/subscriptions', subscriptionsRoute({ db: deps.db }))
  // Reusable discount codes (Payments -> Coupons): definitions a later module can
  // apply to an invoice total. Bookkeeping only — defining or applying a coupon
  // never charges a card or moves money.
  app.route('/api/loc/:loc/coupons', couponsRoute({ db: deps.db }))
  // The Transactions ledger (Payments -> Transactions): a read-only projection of
  // invoices that carry a recorded payment. There is no create/charge path —
  // OpenLevel never moves money, so a row exists only because an operator wrote
  // down a payment, and each amount is derived from that invoice line items.
  app.route('/api/loc/:loc/transactions', transactionsRoute({ db: deps.db }))
  // The call log + click-to-call (Module 52). Calls run inside the location's
  // own Twilio/Vapi account; this only places them and mirrors what the
  // provider reports. Operator-only — the AI agent has no call tool.
  app.route('/api/loc/:loc/calls', callsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/reviews', reviewsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/courses', coursesRoute({ db: deps.db }))
  app.route('/api/loc/:loc/blog', blogRoute({ db: deps.db }))
  app.route('/api/loc/:loc/communities', communitiesRoute({ db: deps.db }))
  app.route('/api/loc/:loc/social', socialRoute({ db: deps.db }))
  app.route('/api/loc/:loc/surveys', surveysRoute({ db: deps.db }))
  app.route('/api/loc/:loc/proposals', proposalsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/trigger-links', triggerLinksRoute({ db: deps.db }))
  app.route('/api/loc/:loc/affiliates', affiliatesRoute({ db: deps.db }))
  // Cross-contact task worklist (the global "Tasks" page). Writes happen through
  // the nested /contacts/:id/tasks routes; this is read-only aggregation.
  app.route('/api/loc/:loc/tasks', tasksRoute({ db: deps.db }))
  app.route('/api/loc/:loc/templates', templatesRoute({ db: deps.db }))
  // Location-wide tag management (the "Tags" settings area). Per-contact tag
  // add/remove lives on the nested /contacts/:id/tags routes; this is the
  // distinct-set view plus rename/delete across every contact.
  app.route('/api/loc/:loc/tags', tagsRoute({ db: deps.db }))
  // Custom-field *definitions* (the "Custom Fields" settings area). Per-contact
  // values are written through the nested /contacts/:id/custom-fields/:key route;
  // this manages the field definitions themselves.
  app.route('/api/loc/:loc/custom-fields', customFieldsRoute({ db: deps.db }))
  // Custom *values*: location-level constants (business name, booking link, etc.)
  // referenced as {{custom_values.<key>}} merge tags in templates and automations.
  app.route('/api/loc/:loc/custom-values', customValuesRoute({ db: deps.db }))
  // AI Agent settings (the "AI Agent" settings area): reply mode (approve-first /
  // autonomous) + the agent's persona, instructions, and knowledge-base facts.
  app.route('/api/loc/:loc/settings', settingsRoute({ db: deps.db }))
  // Clinical session notes: DAP + mental status + mandatory risk assessment, locked after 72 h.
  app.route('/api/loc/:loc/session-notes', sessionNotesRoute({ db: deps.db, dispatch: deps.dispatch }))
  // Document templates (versioned, immutable once active) and packets.
  // Settings -> Branding (name, accent colour, logo). Always available: it is configuration, not a module.
  app.route('/api/loc/:loc/branding', brandingRoute({ db: deps.db }))
  app.route('/api/loc/:loc/invites', invitesRoute({ db: deps.db, resolveEmail: deps.resolveEmail, publicBaseUrl: deps.publicBaseUrl }))
  app.route('/api/loc/:loc/documents', documentsRoute({ db: deps.db, resolveEmail: deps.resolveEmail, publicBaseUrl: deps.publicBaseUrl }))
  // The audit log (read-only) + its integrity check and CSV export.
  app.route('/api/loc/:loc/audit', auditRoute({ db: deps.db }))
  // The practice profile (name, license, fees, cancellation policy).
  app.route('/api/loc/:loc/practice', practiceRoute({ db: deps.db }))

  // Serve the built web app from this process (production container). Registered
  // last so every /api route wins; unknown non-API GETs fall back to index.html
  // for client-side routing.
  if (deps.staticDir) {
    const root = relative(process.cwd(), resolve(deps.staticDir)) || '.'
    const index = `${root}/index.html`
    app.use('/assets/*', async (c, next) => {
      await next()
      c.header('Cache-Control', 'public, max-age=31536000, immutable')
    })
    app.use('*', serveStatic({ root }))
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api/') || c.req.path === '/health') return next()
      c.header('Cache-Control', 'no-store')
      return serveStatic({ path: index })(c, next)
    })
  }

  return app
}

/**
 * The deps each enabled integration needs at boot. Anything not enabled contributes
 * nothing, so a disabled integration has no client, no token and no callback to
 * leak through.
 */
function integrationDeps(
  config: ReturnType<typeof loadConfig>,
  boss: Awaited<ReturnType<typeof startBoss>>,
): Pick<AppDeps, 'sendText' | 'federationServiceToken' | 'onInbound'> {
  const has = (i: Integration) => config.ENABLED_INTEGRATIONS.includes(i)
  return {
    // The approve-first text rail (assistant + federation). The env vars are the
    // deployment control, NOT a feature flag: when GATEWAY_TEXT_URL/INTERNAL_PUSH_SECRET
    // are unset the rail honestly reports "not set up" rather than silently dropping.
    sendText:
      has('ai') || has('federation')
        ? makeHttpSendText({
            url: process.env.GATEWAY_TEXT_URL ?? '',
            secret: process.env.INTERNAL_PUSH_SECRET ?? '',
          })
        : undefined,
    // The hub gateway's shared bearer for /federation/*. Unset => that surface
    // stays inert (503).
    federationServiceToken: has('federation') ? config.FEDERATION_SERVICE_TOKEN : undefined,
    // A fresh inbound fires the inbound_message trigger (so message-triggered
    // workflows enroll the contact) and, only with the matching integrations on,
    // drafts an agent reply and nudges the mobile app.
    onInbound: has('chatwoot')
      ? async (e) => {
          if (has('ai')) {
            await enqueueAgentReply(boss, {
              locationId: e.locationId,
              conversationId: e.conversationId,
              contactId: e.contactId,
            })
          }
          await enqueueWorkflowEvent(boss, {
            locationId: e.locationId,
            triggerType: 'inbound_message',
            contactId: e.contactId,
          })
          if (has('push')) {
            // Fire-and-forget — a down/unconfigured gateway must never block ingestion.
            void notifyPush(
              { url: process.env.GATEWAY_PUSH_URL ?? '', secret: process.env.INTERNAL_PUSH_SECRET ?? '' },
              {
                source: 'openlevel', // the push contract's fixed source id
                title: 'New message',
                body: '', // never put message text or a client name in a push payload
                data: { conversationId: e.conversationId, locationId: e.locationId },
              },
            )
          }
        }
      : undefined,
  }
}

async function bootstrap() {
  const config = loadConfig()
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to boot the server')
  const pool = new Pool({ connectionString: config.DATABASE_URL })
  const db = new PgDatabase(pool)

  const integrations = config.ENABLED_INTEGRATIONS
  const has = (i: Integration) => integrations.includes(i)

  // Jobs: pg-boss runs the workflow-dispatch worker (and the agent-reply worker only
  // when the AI integration is on); routes enqueue onto them.
  const boss = await startBoss(config.DATABASE_URL, { createSchema: config.PGBOSS_CREATE_SCHEMA })
  const dispatch: WorkflowDispatch = (e) => enqueueWorkflowEvent(boss, e)
  // No Claude client unless the AI integration is enabled: client data never goes
  // to an AI provider by default.
  const claude = has('ai') ? createAnthropicClient() : undefined
  if (claude) {
    // The autonomous agent books/tags through real tools; thread the dispatcher so
    // an agent-booked appointment fires appointment_booked like the public page.
    await registerAgentReplyWorker(boss, { db, claude, dispatch })
  }
  await registerWorkflowDispatchWorker(boss, { db, dispatch, publicBaseUrl: config.PUBLIC_BASE_URL })

  const app = createApp({
    db,
    sessionSecret: config.SESSION_SECRET,
    webhookSecret: config.CHATWOOT_WEBHOOK_SECRET,
    secure: config.NODE_ENV === 'production',
    staticDir: config.STATIC_DIR,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    integrations,
    claude,
    dispatch,
    ...integrationDeps(config, boss),
  })
  serve({ fetch: app.fetch, port: config.PORT })
  console.log(`psycrm api listening on :${config.PORT}`)
  // Names only. A reviewer reading the boot log can see at a glance which vendors
  // are connected.
  console.log(`integrations enabled: ${integrations.length > 0 ? integrations.join(', ') : 'none'}`)
}

// Boot only when run directly (tsx server/index.ts), never on import (tests).
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  bootstrap().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}


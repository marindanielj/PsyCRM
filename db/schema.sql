-- OpenLevel schema (slice 1). Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS locations (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  client_slug text,
  branding    jsonb DEFAULT '{}',
  settings    jsonb DEFAULT '{}',
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operators (
  id            text PRIMARY KEY,
  email         text UNIQUE NOT NULL,
  name          text,
  role          text NOT NULL DEFAULT 'owner',
  password_hash text NOT NULL,
  created_at    timestamptz DEFAULT now()
);
-- When the operator last chose a new password. Sessions issued before it are rejected, so changing the
-- password also signs out every other device. NULL = never changed (still the password it was created with).
ALTER TABLE operators ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

CREATE TABLE IF NOT EXISTS operator_locations (
  operator_id text REFERENCES operators(id) ON DELETE CASCADE,
  location_id text REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (operator_id, location_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id            text PRIMARY KEY,
  location_id   text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          text,
  first_name    text,
  last_name     text,
  phones        text[] DEFAULT '{}',
  emails        text[] DEFAULT '{}',
  tags          text[] DEFAULT '{}',
  custom_fields jsonb DEFAULT '{}',
  source        text,
  external_ids  jsonb DEFAULT '{}',
  match_key     text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_match_key
  ON contacts(location_id, match_key) WHERE match_key IS NOT NULL;
-- Soft-delete (archive). The operator's "Delete" control stamps archived_at
-- instead of hard-deleting, because a contact carries notes/tasks/timeline
-- (ON DELETE CASCADE) and conversations/opportunities (ON DELETE SET NULL) a
-- real delete would silently destroy. archived_at NULL = live (in the book);
-- a timestamp = archived (hidden, restorable). Nothing is physically removed.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
-- Partial index: list/count/search/segments all filter archived_at IS NULL, so
-- index the live rows for those hot reads; the Archived view is rare.
CREATE INDEX IF NOT EXISTS contacts_live ON contacts(location_id) WHERE archived_at IS NULL;
-- Per-state legal texting hours. The contact's US state (2-letter code) pins
-- which legal window the gateway enforces when sending a text: 8am-9pm in THAT
-- state's own timezone, DST-aware. NULL = not set, which the gateway refuses as
-- unknown_state rather than guessing a timezone (an Arizona guess would wave a
-- too-late North-Carolina text through). Bryan's leads are AZ + NC today.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state text;

-- Operator-defined custom field *definitions* (the GHL "Custom Fields" settings
-- area). Each row is a field the operator added to their contact records: a
-- stable `key` (slug, never changes once created), a display `label`, a `type`
-- that drives the input control, and `options` for dropdowns. The per-contact
-- *values* live in contacts.custom_fields jsonb keyed by this `key` — definitions
-- here, values there.
CREATE TABLE IF NOT EXISTS custom_fields (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  type        text NOT NULL DEFAULT 'text',
  options     jsonb NOT NULL DEFAULT '[]',
  placeholder text,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
-- Whether the form a client fills in from an invitation asks for this field. On by default: a field the
-- practice adds today appears on the next invitation; switch it off for fields only staff should fill in.
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS show_on_invite boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS custom_fields_key
  ON custom_fields(location_id, key);
CREATE INDEX IF NOT EXISTS custom_fields_by_location
  ON custom_fields(location_id, position);

-- Custom *values* are location-level constants the operator defines once
-- (business name, booking link, support phone) and references as merge tags
-- like {{custom_values.business_name}} in templates, emails, and automations.
-- Unlike custom_fields (per-contact data), there is exactly one value per
-- location per key. The `key` is slugified from the name once and never changes,
-- so a token already placed in a template keeps resolving after a rename.
CREATE TABLE IF NOT EXISTS custom_values (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  value       text NOT NULL DEFAULT '',
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_values_key
  ON custom_values(location_id, key);
CREATE INDEX IF NOT EXISTS custom_values_by_location
  ON custom_values(location_id, position);

CREATE TABLE IF NOT EXISTS channel_links (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  inbox_id    text NOT NULL,
  config      jsonb DEFAULT '{}',
  UNIQUE (provider, inbox_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id              text PRIMARY KEY,
  location_id     text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id      text REFERENCES contacts(id) ON DELETE SET NULL,
  channel         text,
  provider        text,
  external_id     text,
  status          text DEFAULT 'open',
  assignee        text,
  last_message_at timestamptz,
  created_at      timestamptz DEFAULT now()
);
-- Dedupe a provider's conversation *within its tenant*, not globally. Two
-- federated Chatwoot instances can hand out the same conversation id; a global
-- UNIQUE(provider, external_id) would wrongly reject the second tenant's
-- conversation, so the key carries location_id. It also backs the atomic
-- INSERT ... ON CONFLICT upsert in ConversationsRepo.upsertByExternal.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_provider_external
  ON conversations(location_id, provider, external_id);

CREATE TABLE IF NOT EXISTS messages (
  id              text PRIMARY KEY,
  location_id     text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  conversation_id text REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      text REFERENCES contacts(id) ON DELETE SET NULL,
  direction       text NOT NULL,
  channel         text,
  provider        text,
  external_id     text,
  body            text,
  attachments     jsonb DEFAULT '[]',
  author_type     text,
  author_id       text,
  status          text DEFAULT 'sent',
  created_at      timestamptz DEFAULT now()
);
-- Inbound dedupe is per-tenant for the same reason as conversations above: a
-- global UNIQUE(provider, external_id) would let one tenant's message id silently
-- swallow another tenant's inbound. Backs the ON CONFLICT DO NOTHING guard in
-- MessagesRepo.insertInbound.
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_external
  ON messages(location_id, provider, external_id);

CREATE TABLE IF NOT EXISTS timeline_events (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contacts(id) ON DELETE CASCADE,
  type        text NOT NULL,
  ref_table   text,
  ref_id      text,
  payload     jsonb DEFAULT '{}',
  occurred_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timeline_by_contact
  ON timeline_events(location_id, contact_id, occurred_at DESC);

-- Contact notes (slice 21): free-text notes an operator pins to a contact
-- record. Pinned notes float to the top; within a pin group, newest first.

CREATE TABLE IF NOT EXISTS contact_notes (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id  text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  body        text NOT NULL,
  author      text,
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_notes_by_contact
  ON contact_notes(location_id, contact_id, pinned DESC, created_at DESC);

-- Contact tasks (slice 22): an operator to-do attached to a contact. due_at is
-- optional; completed_at NULL means open, a timestamp means done. Two indexes:
-- one for a single contact's task panel, one for the cross-contact worklist.
-- Open tasks sort before done, soonest due first.

CREATE TABLE IF NOT EXISTS contact_tasks (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id   text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text,
  due_at       timestamptz,
  completed_at timestamptz,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_tasks_by_contact
  ON contact_tasks(location_id, contact_id, completed_at, due_at);
CREATE INDEX IF NOT EXISTS contact_tasks_by_location
  ON contact_tasks(location_id, completed_at, due_at);

-- Opportunities (slice 2): pipelines -> ordered stages -> opportunity cards.

CREATE TABLE IF NOT EXISTS pipelines (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    int DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipelines_by_location
  ON pipelines(location_id, position);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  pipeline_id text NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    int DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stages_by_pipeline
  ON pipeline_stages(location_id, pipeline_id, position);

CREATE TABLE IF NOT EXISTS opportunities (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  pipeline_id text NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  stage_id    text NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contacts(id) ON DELETE SET NULL,
  name        text NOT NULL,
  value_cents bigint DEFAULT 0,
  status      text NOT NULL DEFAULT 'open',
  source      text,
  assignee    text,
  position    int DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opps_by_stage
  ON opportunities(location_id, pipeline_id, stage_id, position);

-- Calendars (slice 3): named calendars -> appointments booked against them.

CREATE TABLE IF NOT EXISTS calendars (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  color        text NOT NULL DEFAULT 'indigo',
  duration_min int NOT NULL DEFAULT 30,
  position     int DEFAULT 0,
  -- Public booking page config. A calendar with booking_enabled + a slug is
  -- reachable at /api/public/booking/:loc/:slug, where a visitor self-schedules
  -- against the weekly `availability` windows (an array of {weekday,start,end}
  -- wall-clock ranges interpreted in `timezone`). slot_interval_min 0 means
  -- "step by duration_min". notice_min is the minimum lead time; rolling_days is
  -- how far ahead the page offers dates.
  booking_enabled   boolean NOT NULL DEFAULT false,
  booking_slug      text,
  timezone          text NOT NULL DEFAULT 'America/New_York',
  slot_interval_min int NOT NULL DEFAULT 0,
  buffer_min        int NOT NULL DEFAULT 0,
  notice_min        int NOT NULL DEFAULT 120,
  rolling_days      int NOT NULL DEFAULT 14,
  availability      jsonb NOT NULL DEFAULT '[]',
  booking_headline  text,
  booking_blurb     text,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendars_by_location
  ON calendars(location_id, position);
-- A booking slug is unique per location (the public lookup is location-scoped).
CREATE UNIQUE INDEX IF NOT EXISTS calendars_booking_slug
  ON calendars(location_id, booking_slug) WHERE booking_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointments (
  id            text PRIMARY KEY,
  location_id   text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  calendar_id   text NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  contact_id    text REFERENCES contacts(id) ON DELETE SET NULL,
  title         text NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'scheduled',
  location_text text,
  notes         text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointments_by_time
  ON appointments(location_id, starts_at);
-- One LIVE appointment per calendar per exact start instant. This is the
-- database-level guarantee behind the public booking widget's double-book guard:
-- two visitors who race for the same time both pass the in-request slot snapshot
-- (neither has written yet), but only one INSERT can land -- the second fails
-- with a unique violation the route turns into an honest "slot taken". A
-- cancelled appointment frees its slot, so the uniqueness is partial on status.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_no_double_book
  ON appointments(calendar_id, starts_at) WHERE status <> 'cancelled';

-- Marketing (slice 4): one-off SMS/email campaigns -> per-recipient rows.

CREATE TABLE IF NOT EXISTS campaigns (
  id              text PRIMARY KEY,
  location_id     text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  channel         text NOT NULL DEFAULT 'sms',
  subject         text,
  body            text NOT NULL,
  audience_tag    text,
  status          text NOT NULL DEFAULT 'draft',
  recipient_count int NOT NULL DEFAULT 0,
  sent_count      int NOT NULL DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS campaigns_by_location
  ON campaigns(location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contacts(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'sent',
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipients_by_campaign
  ON campaign_recipients(location_id, campaign_id);

-- Templates (slice 23): the reusable email/SMS message library. Named, channel-
-- typed snippets with merge fields, dropped into campaigns and automation steps.
-- subject is email-only (NULL for SMS). No per-recipient state — these are just
-- saved drafts an operator reaches for.
CREATE TABLE IF NOT EXISTS templates (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  channel     text NOT NULL DEFAULT 'email',
  subject     text,
  body        text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS templates_by_location
  ON templates(location_id, channel, created_at DESC);

-- Automations (slice 5): a workflow has one trigger + an ordered list of action
-- steps. This slice ships the builder/definition only; the runner is next.
CREATE TABLE IF NOT EXISTS workflows (
  id             text PRIMARY KEY,
  location_id    text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name           text NOT NULL,
  trigger_type   text NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'draft',
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflows_by_location
  ON workflows(location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_actions (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position    int NOT NULL DEFAULT 0,
  type        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS actions_by_workflow
  ON workflow_actions(location_id, workflow_id, position);

-- One row per workflow enrollment (workflow x contact x trigger occurrence).
-- The runner writes this: it is the honest execution record the UI shows. status
-- moves running -> waiting (paused on a wait step) -> completed | failed. steps is
-- an append-only log of per-action results: [{position,type,status,detail}].
CREATE TABLE IF NOT EXISTS workflow_runs (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  workflow_id  text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  contact_id   text REFERENCES contacts(id) ON DELETE SET NULL,
  trigger_type text NOT NULL,
  status       text NOT NULL DEFAULT 'running',
  steps        jsonb NOT NULL DEFAULT '[]',
  started_at   timestamptz DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS runs_by_workflow
  ON workflow_runs(location_id, workflow_id, started_at DESC);

-- Sites & Funnels (slice 8): a funnel is an ordered set of hosted pages (steps).
-- The opt_in step's public form captures a lead -> contact -> contact_created.
CREATE TABLE IF NOT EXISTS funnels (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS funnels_slug
  ON funnels(location_id, slug);

CREATE TABLE IF NOT EXISTS funnel_steps (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  funnel_id   text NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  position    int NOT NULL DEFAULT 0,
  name        text NOT NULL,
  type        text NOT NULL,
  path        text NOT NULL,
  content     jsonb NOT NULL DEFAULT '{}',
  submissions int NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS steps_by_funnel
  ON funnel_steps(location_id, funnel_id, position);

-- Forms & Surveys (slice 9): a standalone, single-page lead-capture form. Unlike
-- a funnel step (which only COUNTS submissions), a form keeps every submission's
-- field values in form_submissions for an operator-facing submissions viewer.
-- `content` holds {headline, subhead, cta, tag, successMessage, fields:[...]}.
CREATE TABLE IF NOT EXISTS forms (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  content     jsonb NOT NULL DEFAULT '{}',
  submissions int NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS forms_slug
  ON forms(location_id, slug);

CREATE TABLE IF NOT EXISTS form_submissions (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  form_id     text NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contacts(id) ON DELETE SET NULL,
  values      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submissions_by_form
  ON form_submissions(location_id, form_id, created_at DESC);

-- Payments / Invoices (slice 10): an invoice billed to a contact. Line items live
-- in `items` jsonb ([{description, quantity, unit_amount}], amounts in cents); the
-- total is DERIVED from items in the app, never stored, so it can't drift from the
-- lines. status moves draft -> sent -> paid (or void). Recording a payment is
-- operator bookkeeping (mark-as-paid) — OpenLevel never charges a card or moves
-- money; it only writes down what already happened.
CREATE TABLE IF NOT EXISTS invoices (
  id             text PRIMARY KEY,
  location_id    text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id     text REFERENCES contacts(id) ON DELETE SET NULL,
  number         text NOT NULL,
  status         text NOT NULL DEFAULT 'draft',
  currency       text NOT NULL DEFAULT 'usd',
  items          jsonb NOT NULL DEFAULT '[]',
  notes          text,
  issued_at      timestamptz,
  due_at         timestamptz,
  paid_at        timestamptz,
  payment_method text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_number
  ON invoices(location_id, number);
CREATE INDEX IF NOT EXISTS invoices_by_location
  ON invoices(location_id, created_at DESC);

-- Module 48: hosted checkout (pay-by-link). The location connects its OWN
-- Stripe/Square account; we mint a checkout link inside that account and store
-- the processor-side correlation id here so the payment webhook can find the
-- invoice (Stripe round-trips our metadata; Square only gives us its order id).
-- ALTER + IF NOT EXISTS so existing databases upgrade in place — migrate.ts
-- just replays this file.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS checkout_provider text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS checkout_external_id text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS checkout_url text;
CREATE INDEX IF NOT EXISTS invoices_by_checkout_external
  ON invoices(location_id, checkout_external_id);

-- Reputation / Reviews (slice 11): the review-collection loop. An operator issues
-- a review_request to a contact — a tokenized public link — and the customer opens
-- it and leaves a star rating + comment, captured as a review. The headline
-- average is DERIVED in the app from the real review rows (see review-math.ts),
-- never stored, so the figure can't drift from the reviews that justify it and
-- can't be silently inflated. `rating` is constrained 1–5 at the DB. A review's
-- `status` is moderation only (hide spam/abuse from a future public widget); it
-- does NOT change the true average the operator sees. OpenLevel never writes a
-- fake review — an empty table is an honest zero.
CREATE TABLE IF NOT EXISTS review_requests (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id   text REFERENCES contacts(id) ON DELETE SET NULL,
  channel      text NOT NULL DEFAULT 'sms',
  token        text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  sent_at      timestamptz,
  completed_at timestamptz,
  created_at   timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_token
  ON review_requests(token);
CREATE INDEX IF NOT EXISTS review_requests_by_location
  ON review_requests(location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reviews (
  id            text PRIMARY KEY,
  location_id   text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id    text REFERENCES contacts(id) ON DELETE SET NULL,
  request_id    text REFERENCES review_requests(id) ON DELETE SET NULL,
  rating        int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          text,
  reviewer_name text,
  source        text NOT NULL DEFAULT 'direct',
  status        text NOT NULL DEFAULT 'published',
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_by_location
  ON reviews(location_id, created_at DESC);

-- Module 51: reviews imported from Google Business Profile / the Facebook Page
-- carry the platform's OWN id so a re-sync updates in place instead of
-- duplicating. Direct reviews keep external_id NULL, so the partial unique
-- index never constrains them. (ALTER + IF NOT EXISTS so existing databases
-- upgrade in place — migrate.ts just replays this file.)
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS reviews_external_dedup
  ON reviews(location_id, source, external_id) WHERE external_id IS NOT NULL;

-- Memberships / Courses (slice 12): a course is a published body of lessons a
-- contact is enrolled into and works through. A `lesson` is one ordered unit
-- (text + optional video). An `enrollment` ties a contact to a course and mints a
-- tokenized public link to the course player; a `lesson_completion` is the one
-- honest fact we record — "this enrollee finished this lesson". Progress (the
-- "62% complete" figure) is DERIVED in the app from completions over the course's
-- real lesson count (see course-math.ts), never stored, so it can't drift from
-- what was actually finished and can't be inflated. UNIQUE(enrollment_id,
-- lesson_id) makes "mark complete" idempotent — re-marking never double-counts.
-- An enrollment with no completions is an honest 0%, not a guess.
CREATE TABLE IF NOT EXISTS courses (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  title       text NOT NULL,
  slug        text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'draft',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS courses_slug
  ON courses(location_id, slug);
CREATE INDEX IF NOT EXISTS courses_by_location
  ON courses(location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lessons (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  course_id   text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position    int NOT NULL DEFAULT 0,
  title       text NOT NULL,
  content     text,
  video_url   text,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lessons_by_course
  ON lessons(location_id, course_id, position);

CREATE TABLE IF NOT EXISTS enrollments (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  course_id    text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  contact_id   text REFERENCES contacts(id) ON DELETE SET NULL,
  token        text NOT NULL,
  status       text NOT NULL DEFAULT 'active',
  enrolled_at  timestamptz DEFAULT now(),
  completed_at timestamptz,
  created_at   timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_token
  ON enrollments(token);
CREATE INDEX IF NOT EXISTS enrollments_by_course
  ON enrollments(location_id, course_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lesson_completions (
  id            text PRIMARY KEY,
  location_id   text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  enrollment_id text NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  lesson_id     text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lesson_completions_unique
  ON lesson_completions(enrollment_id, lesson_id);
CREATE INDEX IF NOT EXISTS lesson_completions_by_enrollment
  ON lesson_completions(location_id, enrollment_id);

-- Blog (slice 13): a location's published writing. A post is a draft until the
-- operator publishes it; only published posts are ever served on the public,
-- branded blog. `published_at` is stamped the first time a post goes live and is
-- preserved across unpublish/re-publish, so a post's "posted on" date never lies
-- about when it actually appeared. The "5 min read" shown on a post is NOT stored
-- here — it is DERIVED from the body's real word count in blog-math.ts, so it
-- can't drift from the words it describes and can't be padded. An empty blog is an
-- honest zero. UNIQUE(location_id, slug) keeps the public URL collision-free.
CREATE TABLE IF NOT EXISTS blog_posts (
  id              text PRIMARY KEY,
  location_id     text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  slug            text NOT NULL,
  excerpt         text,
  body            text,
  cover_image_url text,
  author          text,
  status          text NOT NULL DEFAULT 'draft',
  published_at    timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS blog_posts_slug
  ON blog_posts(location_id, slug);
CREATE INDEX IF NOT EXISTS blog_posts_by_location
  ON blog_posts(location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS blog_posts_published
  ON blog_posts(location_id, published_at DESC);

-- Trigger Links (slice 14): a location's trackable short links. The operator names
-- a link to a destination URL; OpenLevel hosts a short link that 302-redirects to
-- the destination and records the click. The stats a link shows — total clicks,
-- how many DISTINCT contacts clicked, and when it was last clicked — are NOT stored
-- on the link row: each click is its own row in trigger_link_clicks, and the figures
-- are DERIVED by aggregating those real rows (see TriggerLinksRepo.listWithStats),
-- so a count can never drift from the clicks that justify it and can't be silently
-- inflated. An unclicked link is an honest zero. A click attributed to a contact
-- (the link was opened with ?c=<contactId>) additionally fires the
-- `trigger_link_clicked` workflow trigger, so a real click can start an automation.
-- UNIQUE(location_id, slug) keeps the short URL collision-free.
CREATE TABLE IF NOT EXISTS trigger_links (
  id              text PRIMARY KEY,
  location_id     text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  slug            text NOT NULL,
  destination_url text NOT NULL,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS trigger_links_slug
  ON trigger_links(location_id, slug);
CREATE INDEX IF NOT EXISTS trigger_links_by_location
  ON trigger_links(location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trigger_link_clicks (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  link_id     text NOT NULL REFERENCES trigger_links(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contacts(id) ON DELETE SET NULL,
  clicked_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trigger_link_clicks_by_link
  ON trigger_link_clicks(location_id, link_id, clicked_at DESC);

-- Surveys (slice 15): a multi-step lead-capture survey. Like a form it keeps every
-- submission's field values in survey_submissions for an operator-facing viewer,
-- but its `content` holds an ordered `steps:[{id,title,subtitle?,fields:[...]}]` so
-- a visitor answers a few questions at a time behind a progress bar, rather than on
-- one page. The honest `submissions` counter and the stored rows are DERIVED from
-- real completions — an unanswered survey is an honest zero, never a guess. A
-- completed submission additionally fires the `survey_submitted` workflow trigger,
-- so finishing a survey can start an automation. UNIQUE(location_id, slug) keeps the
-- public URL collision-free.
CREATE TABLE IF NOT EXISTS surveys (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  content     jsonb NOT NULL DEFAULT '{}',
  submissions int NOT NULL DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS surveys_slug
  ON surveys(location_id, slug);

CREATE TABLE IF NOT EXISTS survey_submissions (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  survey_id   text NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contacts(id) ON DELETE SET NULL,
  values      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS survey_submissions_by_survey
  ON survey_submissions(location_id, survey_id, created_at DESC);

-- Proposals & estimates (slice 16): a signable sales document billed to a contact.
-- The document body (intro prose, line items, terms) lives in `content` jsonb
-- ({intro, line_items:[{description,quantity,unit_amount}] in cents, terms}); the
-- dollar total is DERIVED from line_items in the app (see proposal-math.ts), never
-- stored, so the amount the client signs for can't drift from the lines that justify
-- it. status moves draft -> sent -> viewed -> signed (or declined). A signature is
-- the one honest fact we capture: the typed signer_name + signed_at, recorded once
-- when the recipient accepts on the public page — OpenLevel never forges one, so an
-- unsigned proposal reads as an honest "awaiting signature". Signing additionally
-- fires the `proposal_signed` workflow trigger, so an accepted proposal can start an
-- automation. UNIQUE(location_id, slug) keeps the public URL collision-free.
CREATE TABLE IF NOT EXISTS proposals (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contacts(id) ON DELETE SET NULL,
  title       text NOT NULL,
  slug        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  currency    text NOT NULL DEFAULT 'usd',
  content     jsonb NOT NULL DEFAULT '{}',
  signer_name text,
  signed_at   timestamptz,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_slug
  ON proposals(location_id, slug);
CREATE INDEX IF NOT EXISTS proposals_by_location
  ON proposals(location_id, created_at DESC);

-- Communities (slice 17): a location's group space — a Skool/Circle-style
-- community where members post in channels, comment, and like. A community is a
-- draft until the operator publishes it; only a published community is served on
-- the public, branded feed. Everything a community shows — its member count, its
-- post count, and a post's like/comment counts — is NOT stored on any row:
-- members, posts, comments and likes are each their own real rows, and the
-- figures are DERIVED by aggregating them (community-math.ts + repo COUNTs), so a
-- count can never drift from the rows that justify it and can't be padded. An
-- empty community is an honest zero. UNIQUE(location_id, slug) keeps the public
-- URL collision-free; a like is UNIQUE per (post, member) so it can't be double
-- counted.
CREATE TABLE IF NOT EXISTS communities (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'draft',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS communities_slug
  ON communities(location_id, slug);
CREATE INDEX IF NOT EXISTS communities_by_location
  ON communities(location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_channels (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  community_id text NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  position     int NOT NULL DEFAULT 0,
  name         text NOT NULL,
  slug         text NOT NULL,
  created_at   timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS community_channels_slug
  ON community_channels(community_id, slug);
CREATE INDEX IF NOT EXISTS community_channels_by_community
  ON community_channels(location_id, community_id, position);

CREATE TABLE IF NOT EXISTS community_members (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  community_id text NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  contact_id   text REFERENCES contacts(id) ON DELETE SET NULL,
  name         text NOT NULL,
  email        text,
  role         text NOT NULL DEFAULT 'member',
  joined_at    timestamptz DEFAULT now(),
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_members_by_community
  ON community_members(location_id, community_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS community_posts (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  community_id text NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  channel_id   text NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
  member_id    text REFERENCES community_members(id) ON DELETE SET NULL,
  title        text,
  body         text NOT NULL,
  pinned       boolean NOT NULL DEFAULT false,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_posts_by_channel
  ON community_posts(location_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS community_posts_by_community
  ON community_posts(location_id, community_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_comments (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  post_id     text NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  member_id   text REFERENCES community_members(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_comments_by_post
  ON community_comments(location_id, post_id, created_at);

CREATE TABLE IF NOT EXISTS community_post_likes (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  post_id     text NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  member_id   text NOT NULL REFERENCES community_members(id) ON DELETE CASCADE,
  created_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS community_post_likes_unique
  ON community_post_likes(post_id, member_id);
CREATE INDEX IF NOT EXISTS community_post_likes_by_post
  ON community_post_likes(location_id, post_id);

-- ── Social Planner ──────────────────────────────────────────────────────────
-- Plan, schedule and publish social posts through the LOCATION's own platform
-- credentials (page token, IG account, LinkedIn author, X token — resolved by
-- name from the vault, never stored here). `connected` stays honest: it flips
-- true only when the resolver actually builds a working publisher. A post
-- composes once and fans out to many accounts via social_post_targets; each
-- target records its REAL outcome (published with the provider's post id, or
-- failed with the reason). No reach or engagement is ever stored — OpenLevel
-- never fabricates an analytics surface.
CREATE TABLE IF NOT EXISTS social_accounts (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  handle      text NOT NULL,
  connected   boolean NOT NULL DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_accounts_by_location
  ON social_accounts(location_id, created_at);

CREATE TABLE IF NOT EXISTS social_posts (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_posts_by_location
  ON social_posts(location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS social_posts_by_schedule
  ON social_posts(location_id, status, scheduled_at);
-- Hosted image attached to the post (IG requires one; FB posts it as a photo).
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS media_url text;

CREATE TABLE IF NOT EXISTS social_post_targets (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  post_id     text NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  account_id  text NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  created_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_post_targets_unique
  ON social_post_targets(post_id, account_id);
CREATE INDEX IF NOT EXISTS social_post_targets_by_post
  ON social_post_targets(location_id, post_id);
-- Per-channel REAL outcome of a publish: 'published' | 'failed', the honest
-- failure reason, and the provider's id for the live post.
ALTER TABLE social_post_targets ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE social_post_targets ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE social_post_targets ADD COLUMN IF NOT EXISTS external_id text;

-- ── Affiliate Manager ───────────────────────────────────────────────────────
-- A referral program: affiliates promote the business with a personal referral
-- link and earn a commission on the sales they drive. The mechanics reuse the
-- trigger-link pattern — each affiliate's link 302-redirects to the program's
-- landing URL and records an open in affiliate_clicks. A sale an affiliate drove
-- is an affiliate_referrals row carrying the sale amount (cents) and the
-- commission (cents) LOCKED at the program's rate the moment it is recorded, so
-- what is owed can never drift if the rate later changes. Every figure the
-- manager shows — clicks, referrals, sales volume, commission earned/paid/owed —
-- is DERIVED by aggregating these real rows (affiliate-math.ts / correlated
-- COUNTs), never a stored counter, so a total can't be inflated and a brand-new
-- affiliate is an honest zero. Marking a referral PAID is operator bookkeeping:
-- OpenLevel records that a payout happened and never moves money itself. Money
-- is integer cents throughout. UNIQUE(location_id, code) keeps every referral URL
-- collision-free within a location.
CREATE TABLE IF NOT EXISTS affiliate_programs (
  id               text PRIMARY KEY,
  location_id      text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'active',
  commission_type  text NOT NULL DEFAULT 'percent',
  commission_value numeric NOT NULL DEFAULT 0,
  landing_url      text NOT NULL,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_programs_by_location
  ON affiliate_programs(location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS affiliates (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  program_id  text NOT NULL REFERENCES affiliate_programs(id) ON DELETE CASCADE,
  contact_id  text REFERENCES contacts(id) ON DELETE SET NULL,
  name        text NOT NULL,
  email       text,
  code        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS affiliates_code_unique
  ON affiliates(location_id, code);
CREATE INDEX IF NOT EXISTS affiliates_by_program
  ON affiliates(location_id, program_id, created_at DESC);

CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  affiliate_id text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  contact_id   text REFERENCES contacts(id) ON DELETE SET NULL,
  clicked_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_clicks_by_affiliate
  ON affiliate_clicks(location_id, affiliate_id, clicked_at DESC);

CREATE TABLE IF NOT EXISTS affiliate_referrals (
  id               text PRIMARY KEY,
  location_id      text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  affiliate_id     text NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  contact_id       text REFERENCES contacts(id) ON DELETE SET NULL,
  description      text,
  amount_cents     bigint NOT NULL DEFAULT 0,
  commission_cents bigint NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'pending',
  occurred_at      timestamptz DEFAULT now(),
  paid_at          timestamptz,
  created_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_referrals_by_affiliate
  ON affiliate_referrals(location_id, affiliate_id, occurred_at DESC);

-- ── Products catalog (GHL Payments -> Products) ──────────────────────────────
-- A reusable catalog of the products and services a location sells, so invoices
-- and proposals can be built from saved items instead of retyping a price every
-- time. `price_cents` is the default price in integer cents (money is always
-- cents here); `currency` defaults usd. A product is either a one_time charge or
-- a recurring subscription — when recurring, `recurring_interval` (day|week|
-- month|year) sets the billing period, and it is NULL for a one_time product.
-- `status` is active or archived: archiving retires a product from the picker
-- without deleting it, and because an invoice or proposal copies the line's text
-- and amount at the moment it is built, deleting a product never alters a
-- document already created from it. Catalog order is the operator's chosen
-- `position`; an empty catalog is an honest zero.
CREATE TABLE IF NOT EXISTS products (
  id                 text PRIMARY KEY,
  location_id        text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  price_cents        bigint NOT NULL DEFAULT 0,
  currency           text NOT NULL DEFAULT 'usd',
  type               text NOT NULL DEFAULT 'one_time',
  recurring_interval text,
  status             text NOT NULL DEFAULT 'active',
  position           int NOT NULL DEFAULT 0,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_by_location
  ON products(location_id, position, created_at);

-- Payments / Subscriptions (slice 30): a recurring commitment a contact is on —
-- GHL "Payments -> Subscriptions". This is a bookkeeping ledger, NOT a biller:
-- OpenLevel never charges a card or moves money, it only records that a recurring
-- arrangement exists and computes its schedule and MRR. `name`, `amount_cents`,
-- `currency` and `billing_interval` are SNAPSHOT off the product at create time
-- (the column is `billing_interval`, never the reserved word `interval`), so
-- renaming, repricing or deleting that product later never disturbs a live
-- subscription. `status` moves active -> paused -> active or -> canceled;
-- `canceled_at` is stamped only while canceled and cleared on reactivation, so a
-- live row never carries a cancel date. The next renewal date and MRR are DERIVED
-- in the app (see subscription-math.ts), never stored, so a figure shown can't
-- drift from the row that justifies it. An empty book is an honest zero.
CREATE TABLE IF NOT EXISTS subscriptions (
  id               text PRIMARY KEY,
  location_id      text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id       text REFERENCES contacts(id) ON DELETE SET NULL,
  product_id       text REFERENCES products(id) ON DELETE SET NULL,
  name             text NOT NULL,
  amount_cents     bigint NOT NULL DEFAULT 0,
  currency         text NOT NULL DEFAULT 'usd',
  billing_interval text NOT NULL DEFAULT 'month',
  status           text NOT NULL DEFAULT 'active',
  started_at       timestamptz NOT NULL DEFAULT now(),
  canceled_at      timestamptz,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_by_location
  ON subscriptions(location_id, created_at DESC);

-- Payments / Coupons (slice 31): a reusable discount DEFINITION — GHL "Payments
-- -> Coupons". This is bookkeeping, NOT a biller: a coupon never charges a card,
-- it only describes a discount that a later module can apply to an invoice's
-- recorded total. `code` is what a customer types and is unique per location,
-- stored already normalised (whitespace stripped, upper-cased) so a lookup is
-- case-insensitive and two coupons can't collide on casing. `discount_type` is
-- percent or fixed: for percent, `discount_value` is whole percent (1..100); for
-- fixed it is an integer cent amount. `max_redemptions` caps how many times the
-- coupon may be applied (NULL = unlimited) and `times_redeemed` is the honest
-- running counter, only ever moved by a real redemption. `expires_at` is an
-- optional cutoff (NULL = never expires). `status` is active or archived:
-- archiving retires a code from use without deleting its history. Whether a
-- coupon is actually redeemable right now is DERIVED in coupon-math.ts from
-- status + expiry + cap, never stored, so it can't drift. An empty book is an
-- honest zero.
CREATE TABLE IF NOT EXISTS coupons (
  id              text PRIMARY KEY,
  location_id     text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  code            text NOT NULL,
  description     text,
  discount_type   text NOT NULL DEFAULT 'percent',
  discount_value  bigint NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'active',
  max_redemptions int,
  times_redeemed  int NOT NULL DEFAULT 0,
  expires_at      timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_per_location
  ON coupons(location_id, code);
CREATE INDEX IF NOT EXISTS coupons_by_location
  ON coupons(location_id, created_at DESC);

-- Module 52: the call log. Rows arrive two ways — `create` when this app
-- places an outbound call through the location's own voice provider (Twilio
-- bridge call or Vapi AI call), and the provider's status webhooks, which
-- upsert by (location_id, provider, external_id) so a re-delivered or
-- out-of-order event updates in place instead of duplicating. Calls the
-- provider reports that we never placed (e.g. a Vapi inbound call) insert
-- honestly. duration/transcript/summary/recording are exactly what the
-- provider said happened — never invented here. An empty log is an honest
-- zero.
CREATE TABLE IF NOT EXISTS calls (
  id               text PRIMARY KEY,
  location_id      text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  contact_id       text REFERENCES contacts(id) ON DELETE SET NULL,
  direction        text NOT NULL DEFAULT 'outbound',
  from_number      text,
  to_number        text,
  status           text NOT NULL DEFAULT 'queued',
  duration_seconds int,
  recording_url    text,
  transcript       text,
  summary          text,
  provider         text NOT NULL,
  external_id      text,
  created_at       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calls_by_location
  ON calls(location_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS calls_external_dedup
  ON calls(location_id, provider, external_id) WHERE external_id IS NOT NULL;

-- Mobile App Push Tokens (slice 53): Stores device push tokens for Expo notifications
CREATE TABLE IF NOT EXISTS push_tokens (
  id          text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  token       text NOT NULL,
  platform    text, -- 'ios' | 'android' | 'web'
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_token_unique
  ON push_tokens(token);
CREATE INDEX IF NOT EXISTS push_tokens_by_operator
  ON push_tokens(operator_id);

-- =============================================================================
-- PsyCRM audit log (day 2). Append-only, tamper-evident record of who did what to
-- which client and when. Enforced IN THE DATABASE, not just the app:
--   * BEFORE INSERT chains every row to the previous one of the same location
--     (hash of the previous row's hash + this row's content), under an advisory
--     lock so concurrent writers cannot fork the chain, and stamps occurred_at
--     itself (a caller can never backdate a row);
--   * BEFORE UPDATE/DELETE/TRUNCATE are rejected;
--   * location_id is ON DELETE RESTRICT (a location with history cannot vanish);
--   * contact_id has no foreign key on purpose, so the log outlives any contact.
-- The chain is ordered by chain_seq (assigned inside the lock), NOT by the bigserial
-- id: a sequence value is taken before the trigger runs, so id order can differ
-- from chain order under concurrency.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  chain_seq    bigint NOT NULL DEFAULT 0,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('operator','client','system','workflow')),
  actor_id     text,
  actor_label  text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  contact_id   text,
  details      jsonb NOT NULL DEFAULT '{}',
  ip           text,
  user_agent   text,
  prev_hash    text,
  row_hash     text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_chain ON audit_log(location_id, chain_seq);
CREATE INDEX IF NOT EXISTS audit_by_time ON audit_log(location_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_by_contact ON audit_log(location_id, contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_by_entity ON audit_log(location_id, entity_type, entity_id);

-- The one definition of a row's hash, shared by the trigger and the verifier.
-- The timestamp is rendered in UTC with a fixed format so the hash never depends
-- on a session's TimeZone setting.
CREATE OR REPLACE FUNCTION audit_row_hash(
  prev text, loc text, seq bigint, at timestamptz, a_type text, a_id text,
  act text, e_type text, e_id text, c_id text, det jsonb
) RETURNS text AS $$
  SELECT encode(sha256(convert_to(
    coalesce(prev, '') || '|' || loc || '|' || seq::text || '|' ||
    to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
    a_type || '|' || coalesce(a_id, '') || '|' || act || '|' || e_type || '|' ||
    coalesce(e_id, '') || '|' || coalesce(c_id, '') || '|' || det::text, 'UTF8')), 'hex')
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE
  last_hash text;
  last_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || NEW.location_id));
  SELECT row_hash, chain_seq INTO last_hash, last_seq
    FROM audit_log WHERE location_id = NEW.location_id
    ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq   := coalesce(last_seq, 0) + 1;
  NEW.prev_hash   := last_hash;
  NEW.occurred_at := clock_timestamp();
  NEW.row_hash    := audit_row_hash(NEW.prev_hash, NEW.location_id, NEW.chain_seq, NEW.occurred_at,
                       NEW.actor_type, NEW.actor_id, NEW.action, NEW.entity_type, NEW.entity_id,
                       NEW.contact_id, NEW.details);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Generic "this table is append-only" guard; reused by later days' tables.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Recompute the whole chain for one location. Returns NULL when intact, otherwise
-- the chain_seq of the FIRST broken row (content changed, link broken, or a gap).
-- Cannot detect rows removed from the very end of the log; the immutability
-- triggers (and revoking TRUNCATE/DELETE from the app role) cover that.
CREATE OR REPLACE FUNCTION audit_log_verify(loc text) RETURNS bigint AS $$
  SELECT min(chain_seq) FROM (
    SELECT chain_seq, prev_hash, row_hash,
           lag(row_hash)  OVER w AS expected_prev,
           lag(chain_seq) OVER w AS prev_seq,
           audit_row_hash(prev_hash, location_id, chain_seq, occurred_at, actor_type, actor_id,
                          action, entity_type, entity_id, contact_id, details) AS recomputed
    FROM audit_log WHERE location_id = loc
    WINDOW w AS (ORDER BY chain_seq)
  ) t
  WHERE recomputed <> row_hash
     OR prev_hash IS DISTINCT FROM expected_prev
     OR (prev_seq IS NOT NULL AND chain_seq <> prev_seq + 1)
     OR (prev_seq IS NULL AND chain_seq <> 1)
$$ LANGUAGE sql STABLE;

-- =============================================================================
-- PsyCRM session notes (day 3): DAP progress notes with a mental status exam and a
-- MANDATORY risk assessment. The rules that protect a clinical record live in the
-- database, so a bug in the app (or a hand-run SQL statement) cannot bypass them:
--   * a note is editable for 72 h from creation, then frozen: no edit, no delete;
--   * a note is never physically deleted — "delete" is a soft delete with a reason,
--     allowed only inside the 72 h window;
--   * a note cannot be signed without a complete risk assessment (CHECKs below);
--   * EVERY change (create, edit, autosave, sign, delete) leaves a full snapshot in
--     session_note_revisions, written by a trigger, attributed to the person who
--     made it (a change with no attributed actor is rejected);
--   * after the window the only way to add to a note is an addendum, append-only.
-- Callers must run each write inside a transaction that first sets the actor:
--   SELECT set_config('psycrm.actor', '<operator id>', true);
-- and may set 'psycrm.change_kind' ('update' | 'autosave') and
-- 'psycrm.change_reason' the same way.
-- =============================================================================

CREATE TABLE IF NOT EXISTS session_notes (
  id              text PRIMARY KEY,
  location_id     text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id      text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  -- RESTRICT (not SET NULL): an appointment tied to a clinical note must not vanish,
  -- and a SET NULL would try to UPDATE a possibly frozen note.
  appointment_id  text REFERENCES appointments(id) ON DELETE RESTRICT,
  session_date    date NOT NULL,
  start_time      time,
  duration_min    int CHECK (duration_min BETWEEN 1 AND 600),
  modality        text NOT NULL DEFAULT 'in_person'
                  CONSTRAINT session_notes_modality CHECK (modality IN ('in_person','telehealth_video','phone')),
  session_type    text NOT NULL DEFAULT 'individual'
                  CONSTRAINT session_notes_type CHECK (session_type IN ('intake','individual','couple','family','crisis','collateral')),
  -- DAP
  data_subjective text,
  data_objective  text,
  assessment      text,
  plan            text,
  -- mental status exam (validated against the vocabulary by the API)
  mse             jsonb NOT NULL DEFAULT '{}',
  mood_rating     smallint CHECK (mood_rating BETWEEN 1 AND 10),
  -- risk assessment: three dimensions + overall level, each an explicit answer
  risk_suicidal       text CONSTRAINT session_notes_risk_si CHECK (risk_suicidal IS NULL OR risk_suicidal IN ('denied','passive','active_no_plan','active_plan','active_plan_intent')),
  risk_self_harm      text CONSTRAINT session_notes_risk_sh CHECK (risk_self_harm IS NULL OR risk_self_harm IN ('denied','history','urges','recent','current')),
  risk_harm_others    text CONSTRAINT session_notes_risk_hi CHECK (risk_harm_others IS NULL OR risk_harm_others IN ('denied','ideation','ideation_plan','intent')),
  risk_level          text CONSTRAINT session_notes_risk_level CHECK (risk_level IS NULL OR risk_level IN ('low','moderate','high','imminent')),
  risk_factors        text[] NOT NULL DEFAULT '{}'
                      CONSTRAINT session_notes_risk_factors CHECK (risk_factors <@ ARRAY['prior_attempt','access_to_means','substance_use','isolation','recent_loss','chronic_pain_illness','impulsivity','hopelessness','family_history','legal_financial_stress','abuse_history']::text[]),
  protective_factors  text[] NOT NULL DEFAULT '{}'
                      CONSTRAINT session_notes_protective CHECK (protective_factors <@ ARRAY['social_support','children_dependents','religious_beliefs','engaged_in_treatment','future_plans','coping_skills','pets','employment_school']::text[]),
  risk_actions        text[] NOT NULL DEFAULT '{}'
                      CONSTRAINT session_notes_risk_actions CHECK (risk_actions <@ ARRAY['none','safety_plan_created','safety_plan_reviewed','means_restriction_counseling','increased_session_frequency','emergency_contact_notified','crisis_line_provided','er_referral','duty_to_warn','consultation']::text[]),
  risk_notes          text,
  interventions   text[] NOT NULL DEFAULT '{}'
                  CONSTRAINT session_notes_interventions CHECK (interventions <@ ARRAY['cbt','dbt_skills','act','mindfulness','psychoeducation','motivational_interviewing','emdr','supportive','behavioral_activation','exposure','problem_solving','relaxation_training']::text[]),
  diagnosis_codes text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  signed_at       timestamptz,
  signed_by       text,
  signed_late     boolean NOT NULL DEFAULT false,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  locks_at        timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  deleted_at      timestamptz,
  deleted_by      text,
  delete_reason   text,

  -- Risk is mandatory to sign: all three dimensions and the overall level answered.
  CONSTRAINT session_notes_risk_required CHECK (status = 'draft' OR (
    risk_suicidal IS NOT NULL AND risk_self_harm IS NOT NULL AND risk_harm_others IS NOT NULL AND risk_level IS NOT NULL)),
  -- Moderate or worse: a written rationale and at least one action actually taken.
  CONSTRAINT session_notes_risk_elevated CHECK (status = 'draft' OR risk_level = 'low' OR (
    coalesce(length(trim(risk_notes)), 0) > 0 AND cardinality(array_remove(risk_actions, 'none')) > 0)),
  -- "Low" with any positive dimension needs a rationale (self-harm "history" alone is a past fact).
  CONSTRAINT session_notes_risk_low_justified CHECK (status = 'draft' OR risk_level <> 'low' OR
    (risk_suicidal = 'denied' AND risk_self_harm IN ('denied','history') AND risk_harm_others = 'denied') OR
    coalesce(length(trim(risk_notes)), 0) > 0),
  -- "none" means no action was needed, so it cannot sit next to a real action.
  CONSTRAINT session_notes_actions_none_alone CHECK (NOT ('none' = ANY(risk_actions) AND cardinality(risk_actions) > 1)),
  CONSTRAINT session_notes_signed_fields CHECK (status = 'draft' OR (signed_at IS NOT NULL AND signed_by IS NOT NULL)),
  CONSTRAINT session_notes_delete_reason CHECK (deleted_at IS NULL OR coalesce(length(trim(delete_reason)), 0) > 0)
);
CREATE INDEX IF NOT EXISTS session_notes_by_contact
  ON session_notes(location_id, contact_id, session_date DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS session_notes_locking
  ON session_notes(location_id, locks_at) WHERE status = 'draft' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS session_note_revisions (
  id            text PRIMARY KEY,
  location_id   text NOT NULL,
  note_id       text NOT NULL REFERENCES session_notes(id) ON DELETE RESTRICT,
  revision      int NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('create','update','autosave','sign','delete')),
  snapshot      jsonb NOT NULL,
  changed_by    text NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  change_reason text,
  UNIQUE (note_id, revision)
);

CREATE TABLE IF NOT EXISTS session_note_addenda (
  id          text PRIMARY KEY,
  location_id text NOT NULL,
  note_id     text NOT NULL REFERENCES session_notes(id) ON DELETE RESTRICT,
  body        text NOT NULL CHECK (length(trim(body)) > 0),
  author      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_note_addenda_by_note ON session_note_addenda(note_id, created_at);

-- A new note is always a fresh draft with the clock started by the database: the
-- caller cannot pre-sign it, backdate it, or shorten/lengthen the edit window.
CREATE OR REPLACE FUNCTION session_note_before_insert() RETURNS trigger AS $$
BEGIN
  NEW.created_at     := now();
  NEW.updated_at     := now();
  NEW.locks_at       := now() + interval '72 hours';
  NEW.status         := 'draft';
  NEW.signed_at      := NULL;
  NEW.signed_by      := NULL;
  NEW.signed_late    := false;
  NEW.deleted_at     := NULL;
  NEW.deleted_by     := NULL;
  NEW.delete_reason  := NULL;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS session_note_before_insert ON session_notes;
CREATE TRIGGER session_note_before_insert BEFORE INSERT ON session_notes
  FOR EACH ROW EXECUTE FUNCTION session_note_before_insert();

CREATE OR REPLACE FUNCTION session_note_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session_note_no_delete' USING ERRCODE = 'P0001';
  END IF;
  -- columns that never change, whatever the statement says
  NEW.id := OLD.id; NEW.location_id := OLD.location_id; NEW.contact_id := OLD.contact_id;
  NEW.created_at := OLD.created_at; NEW.created_by := OLD.created_by; NEW.locks_at := OLD.locks_at;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'session_note_deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'signed' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'session_note_unsign' USING ERRCODE = 'P0001';
  END IF;
  IF now() >= OLD.locks_at THEN
    -- The single exception once the window has closed: a DRAFT that was never signed
    -- may still be signed (late), provided nothing but the signature columns changes.
    IF OLD.status = 'draft' AND NEW.status = 'signed'
       AND (to_jsonb(NEW) - ARRAY['status','signed_at','signed_by','signed_late','updated_at'])
         = (to_jsonb(OLD) - ARRAY['status','signed_at','signed_by','signed_late','updated_at']) THEN
      NEW.signed_late := true;
      NEW.updated_at  := now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'session_note_locked' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS session_note_guard ON session_notes;
CREATE TRIGGER session_note_guard BEFORE UPDATE OR DELETE ON session_notes
  FOR EACH ROW EXECUTE FUNCTION session_note_guard();

-- Every change leaves a full snapshot, attributed to whoever made it. Runs AFTER the
-- guard, so only changes that were actually allowed are recorded. A write with no
-- actor set is refused: nothing may change a clinical note anonymously.
CREATE OR REPLACE FUNCTION session_note_record_revision() RETURNS trigger AS $$
DECLARE
  who text := nullif(current_setting('psycrm.actor', true), '');
  why text := nullif(current_setting('psycrm.change_reason', true), '');
  what text := nullif(current_setting('psycrm.change_kind', true), '');
  rev int;
BEGIN
  IF who IS NULL THEN
    RAISE EXCEPTION 'session_note_actor_required' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN what := 'create';
  ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN what := 'delete';
  ELSIF OLD.status = 'draft' AND NEW.status = 'signed' THEN what := 'sign';
  ELSIF what IS DISTINCT FROM 'autosave' THEN what := 'update';
  END IF;
  -- Autosave fires every few seconds while typing: keep one revision per author per 5 minutes.
  IF what = 'autosave' AND EXISTS (
       SELECT 1 FROM session_note_revisions
       WHERE note_id = NEW.id AND changed_by = who AND kind IN ('create','autosave')
         AND changed_at > now() - interval '5 minutes') THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(max(revision), 0) + 1 INTO rev FROM session_note_revisions WHERE note_id = NEW.id;
  INSERT INTO session_note_revisions (id, location_id, note_id, revision, kind, snapshot, changed_by, change_reason)
  VALUES (gen_random_uuid()::text, NEW.location_id, NEW.id, rev, what, to_jsonb(NEW), who, why);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS session_note_record_revision ON session_notes;
CREATE TRIGGER session_note_record_revision AFTER INSERT OR UPDATE ON session_notes
  FOR EACH ROW EXECUTE FUNCTION session_note_record_revision();

-- An addendum belongs to a live note of the same practice, and is stamped by the database.
CREATE OR REPLACE FUNCTION session_note_addendum_guard() RETURNS trigger AS $$
DECLARE n record;
BEGIN
  SELECT location_id, deleted_at INTO n FROM session_notes WHERE id = NEW.note_id;
  IF NOT FOUND OR n.location_id <> NEW.location_id THEN
    RAISE EXCEPTION 'session_note_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF n.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'session_note_deleted' USING ERRCODE = 'P0001';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS session_note_addendum_guard ON session_note_addenda;
CREATE TRIGGER session_note_addendum_guard BEFORE INSERT ON session_note_addenda
  FOR EACH ROW EXECUTE FUNCTION session_note_addendum_guard();

-- Revisions and addenda are append-only (reject_mutation() is defined with the audit log).
DROP TRIGGER IF EXISTS session_note_revisions_immutable ON session_note_revisions;
CREATE TRIGGER session_note_revisions_immutable BEFORE UPDATE OR DELETE ON session_note_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS session_note_revisions_no_truncate ON session_note_revisions;
CREATE TRIGGER session_note_revisions_no_truncate BEFORE TRUNCATE ON session_note_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS session_note_addenda_immutable ON session_note_addenda;
CREATE TRIGGER session_note_addenda_immutable BEFORE UPDATE OR DELETE ON session_note_addenda
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS session_note_addenda_no_truncate ON session_note_addenda;
CREATE TRIGGER session_note_addenda_no_truncate BEFORE TRUNCATE ON session_note_addenda
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS session_notes_no_truncate ON session_notes;
CREATE TRIGGER session_notes_no_truncate BEFORE TRUNCATE ON session_notes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- PsyCRM day 4: front-desk check-in. `status` gains the value 'checked_in' (a plain
-- text column, no migration needed); this records WHEN the client arrived.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

-- PsyCRM day 5: document templates (versioned, immutable once active) and packets.
CREATE TABLE IF NOT EXISTS document_templates (
  id                   text PRIMARY KEY,
  location_id          text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  family_id            text NOT NULL,
  translation_group_id text NOT NULL,
  locale               text NOT NULL DEFAULT 'es' CHECK (locale IN ('es','en')),
  version              int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  kind                 text NOT NULL CHECK (kind IN ('agreement','intake_form')),
  title                text NOT NULL,
  body_md              text NOT NULL DEFAULT '',
  fields               jsonb NOT NULL DEFAULT '[]',
  signature            jsonb NOT NULL DEFAULT '{"required":true,"drawn":true}',
  signer_roles         text[] NOT NULL DEFAULT '{client}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  activated_at         timestamptz,
  UNIQUE (location_id, family_id, version),
  CHECK (signer_roles <@ ARRAY['client','guardian','minor']::text[] AND cardinality(signer_roles) >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS document_templates_one_active
  ON document_templates(location_id, family_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS document_templates_family ON document_templates(location_id, family_id, version DESC);

-- An active or retired version is what a signed document points to: its content never changes.
CREATE OR REPLACE FUNCTION document_template_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'document_template_immutable' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    -- identity never changes; everything else is editable until activation
    IF NEW.id <> OLD.id OR NEW.location_id <> OLD.location_id OR NEW.family_id <> OLD.family_id
       OR NEW.version <> OLD.version OR NEW.translation_group_id <> OLD.translation_group_id THEN
      RAISE EXCEPTION 'document_template_immutable' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'active' AND OLD.status = 'draft' THEN NEW.activated_at := now(); END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.location_id <> OLD.location_id OR NEW.family_id <> OLD.family_id
     OR NEW.version <> OLD.version OR NEW.translation_group_id <> OLD.translation_group_id
     OR NEW.locale <> OLD.locale OR NEW.kind <> OLD.kind OR NEW.title <> OLD.title
     OR NEW.body_md <> OLD.body_md OR NEW.fields <> OLD.fields OR NEW.signature <> OLD.signature
     OR NEW.signer_roles <> OLD.signer_roles
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'document_template_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'retired') THEN
    RAISE EXCEPTION 'document_template_status' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS document_template_guard ON document_templates;
CREATE TRIGGER document_template_guard BEFORE UPDATE OR DELETE ON document_templates
  FOR EACH ROW EXECUTE FUNCTION document_template_guard();

CREATE TABLE IF NOT EXISTS document_packets (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  description  text,
  family_ids   text[] NOT NULL DEFAULT '{}',
  audience     text NOT NULL DEFAULT 'adult' CHECK (audience IN ('adult','adolescent')),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_packets_location ON document_packets(location_id);

-- PsyCRM day 6: sending a packet for signature. A request freezes the EXACT template
-- versions at send time; each signer gets a one-time link (only sha256(token) is stored);
-- a signature is an immutable record with its evidence.
CREATE TABLE IF NOT EXISTS document_requests (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id   text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  packet_id    text REFERENCES document_packets(id) ON DELETE SET NULL,
  packet_name  text NOT NULL,
  audience     text NOT NULL DEFAULT 'adult' CHECK (audience IN ('adult','adolescent')),
  template_ids text[] NOT NULL,
  status       text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','in_progress','completed','expired','voided')),
  sent_by      text NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '14 days',
  completed_at timestamptz,
  voided_at    timestamptz,
  void_reason  text,
  needs_review text
);
CREATE INDEX IF NOT EXISTS document_requests_contact ON document_requests(location_id, contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS document_requests_open ON document_requests(location_id, status, expires_at);

CREATE TABLE IF NOT EXISTS document_signers (
  id             text PRIMARY KEY,
  location_id    text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  request_id     text NOT NULL REFERENCES document_requests(id) ON DELETE RESTRICT,
  role           text NOT NULL CHECK (role IN ('client','guardian','minor')),
  name           text NOT NULL,
  email          text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','viewed','in_progress','completed')),
  otp_hash       text,
  otp_expires_at timestamptz,
  otp_attempts   int NOT NULL DEFAULT 0,
  verified_at    timestamptz,
  first_viewed_at timestamptz,
  completed_at   timestamptz,
  draft_values   jsonb NOT NULL DEFAULT '{}',
  UNIQUE (request_id, role)
);
-- How the one-time code that opens the documents reached the person: 'email_otp' (the system emailed it) or
-- 'therapist_code' (the therapist read it out). otp_via belongs to the code now stored; verified_via is what
-- verified the person and is copied onto each signed document.
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS otp_via text;
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS verified_via text;
CREATE INDEX IF NOT EXISTS document_signers_request ON document_signers(request_id);

CREATE TABLE IF NOT EXISTS signed_documents (
  id                text PRIMARY KEY,
  location_id       text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id        text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  request_id        text NOT NULL REFERENCES document_requests(id) ON DELETE RESTRICT,
  signer_id         text NOT NULL REFERENCES document_signers(id) ON DELETE RESTRICT,
  signer_role       text NOT NULL,
  template_id       text NOT NULL REFERENCES document_templates(id) ON DELETE RESTRICT,
  template_title    text NOT NULL,
  template_version  int NOT NULL,
  locale            text NOT NULL,
  field_values      jsonb NOT NULL,
  rendered_html     text NOT NULL,
  content_sha256    text NOT NULL,
  signer_name       text NOT NULL,
  signature_png     text,
  esign_consent     boolean NOT NULL CHECK (esign_consent),
  signer_ip         text NOT NULL,
  signer_user_agent text NOT NULL,
  verified_via      text NOT NULL,
  signed_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signer_id, template_id)
);
CREATE INDEX IF NOT EXISTS signed_documents_contact ON signed_documents(location_id, contact_id, signed_at DESC);
CREATE INDEX IF NOT EXISTS signed_documents_request ON signed_documents(request_id);

-- A signature is evidence: never edited, never removed (reject_mutation() is defined with the audit log).
DROP TRIGGER IF EXISTS signed_documents_immutable ON signed_documents;
CREATE TRIGGER signed_documents_immutable BEFORE UPDATE OR DELETE ON signed_documents
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS signed_documents_no_truncate ON signed_documents;
CREATE TRIGGER signed_documents_no_truncate BEFORE TRUNCATE ON signed_documents
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- PsyCRM: a client invitation. The therapist enters a name and an email; the person gets a one-time
-- link, fills in their own details (and date of birth) and only THEN does a contact exist, so the
-- record always starts complete. Only sha256(token) is stored.
CREATE TABLE IF NOT EXISTS client_invites (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  kind         text NOT NULL CHECK (kind IN ('adult','guardian')),
  name         text NOT NULL,
  email        text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','completed','expired','voided')),
  sent_by      text NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '14 days',
  opened_at    timestamptz,
  completed_at timestamptz,
  voided_at    timestamptz,
  contact_id   text REFERENCES contacts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS client_invites_location ON client_invites(location_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS client_invites_open ON client_invites(location_id, status, expires_at);

-- A practice's own logo (shown in the app and on the pages its clients see). Kept apart from `locations`
-- so ordinary location queries never carry image bytes.
CREATE TABLE IF NOT EXISTS location_logos (
  location_id  text PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  data         bytea NOT NULL CHECK (octet_length(data) <= 307200),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---- public page: a practice's own landing page at /p/<slug>, and the requests that come from it -------------
-- The page's content lives in locations.settings.publicPage; the slug is a column so it can be unique.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS public_slug text;
CREATE UNIQUE INDEX IF NOT EXISTS locations_public_slug ON locations(public_slug) WHERE public_slug IS NOT NULL;

-- The banner picture (same idea as location_logos: kept apart so ordinary location queries never carry image bytes).
CREATE TABLE IF NOT EXISTS location_banners (
  location_id  text PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  data         bytea NOT NULL CHECK (octet_length(data) <= 716800),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Requests for information or an appointment. NOT clients: no record, no date of birth. The therapist reads
-- them in her inbox and invites the ones she wants to see; the person then registers through the invitation.
CREATE TABLE IF NOT EXISTS inquiries (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','invited','handled')),
  name        text NOT NULL,
  email       text NOT NULL,
  phone       text,
  who         text NOT NULL CHECK (who IN ('adult','minor')),
  mode        text NOT NULL CHECK (mode IN ('presencial','virtual')),
  days        text[] NOT NULL DEFAULT '{}',
  slots       text[] NOT NULL DEFAULT '{}',
  insurance   text,
  message     text,
  -- the statements the person ticked before asking (e.g. that fees were seen and no insurance is taken), word for word
  acknowledged text[] NOT NULL DEFAULT '{}',
  invite_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inquiries_by_location ON inquiries(location_id, status, created_at DESC);

-- Calendar sync by .ics (INTEGRACIONES.md §3.1). Only TIME BLOCKS cross in either direction: never a client name,
-- title, reason or note.
--
-- Outbound: one secret feed URL per practice, which the therapist subscribes to from her phone. Only the SHA-256 of the
-- token is stored, so a database copy cannot reveal a working URL; regenerating replaces the hash and revoking deletes the row.
CREATE TABLE IF NOT EXISTS calendar_feeds (
  location_id     text PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  title           text NOT NULL DEFAULT 'Cita' CHECK (title IN ('Cita','Ocupado')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  rotated_at      timestamptz,
  last_fetched_at timestamptz,
  fetch_count     bigint NOT NULL DEFAULT 0
);

-- Inbound: the secret .ics address of the therapist's personal calendar. The address IS the credential (anyone holding it can
-- read that calendar), so it is stored sealed (AES-256-GCM, key derived from SESSION_SECRET) and never returned by the API.
CREATE TABLE IF NOT EXISTS external_calendars (
  id             text PRIMARY KEY,
  location_id    text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  label          text NOT NULL DEFAULT 'My calendar' CHECK (char_length(label) BETWEEN 1 AND 60),
  url_sealed     text NOT NULL,
  host           text NOT NULL,                       -- shown to the person ("calendar.google.com"); the path is the secret
  enabled        boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  last_status    text CHECK (last_status IN ('ok','error')),
  last_error     text CHECK (last_error IN ('blocked_address','not_https','unreachable','timeout','http_error','too_large','not_calendar','too_many_redirects','secret_unreadable')),
  block_count    int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_calendars_by_location ON external_calendars(location_id);

-- The busy blocks read from those calendars: START AND END ONLY. Each sync replaces a calendar's whole set.
CREATE TABLE IF NOT EXISTS external_busy (
  id                   bigserial PRIMARY KEY,
  location_id          text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  external_calendar_id text NOT NULL REFERENCES external_calendars(id) ON DELETE CASCADE,
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS external_busy_by_time ON external_busy(location_id, starts_at);
CREATE INDEX IF NOT EXISTS external_busy_by_calendar ON external_busy(external_calendar_id);

-- Billing (A4): charges and superbills. This only WRITES DOWN what already happened: it never charges a card or moves money.
-- A superbill is the statement a client sends their insurer to ask for out-of-network reimbursement.

-- An issued superbill is frozen: `snapshot` holds exactly what was issued (provider, client, diagnoses, lines, totals).
-- The only change the database allows is voiding it, with a reason; it is never deleted.
CREATE TABLE IF NOT EXISTS superbills (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id  text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  number      text NOT NULL,
  period_from date NOT NULL,
  period_to   date NOT NULL,
  snapshot    jsonb NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  issued_by   text NOT NULL,
  voided_at   timestamptz,
  voided_by   text,
  void_reason text,
  CONSTRAINT superbill_void_complete CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT superbill_period CHECK (period_to >= period_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS superbills_number ON superbills(location_id, number);
CREATE INDEX IF NOT EXISTS superbills_by_contact ON superbills(location_id, contact_id, issued_at DESC);

CREATE OR REPLACE FUNCTION superbill_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'superbill_no_delete' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'superbill_voided' USING ERRCODE = 'P0001';
  END IF;
  -- Voiding is the one thing allowed; everything else about an issued superbill is frozen.
  IF (to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason'])
     <> (to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason']) THEN
    RAISE EXCEPTION 'superbill_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS superbill_guard ON superbills;
CREATE TRIGGER superbill_guard BEFORE UPDATE OR DELETE ON superbills
  FOR EACH ROW EXECUTE FUNCTION superbill_guard();

-- One line per session. Money is whole cents, never a decimal.
CREATE TABLE IF NOT EXISTS charges (
  id               text PRIMARY KEY,
  location_id      text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id       text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  -- Informational, deliberately NOT a foreign key: deleting an appointment must never touch a charge that may be on a superbill.
  appointment_id   text,
  session_note_id  text REFERENCES session_notes(id) ON DELETE SET NULL,
  service_date     date NOT NULL,
  cpt_code         text NOT NULL CHECK (cpt_code ~ '^([0-9]{4}[0-9FT]|[A-Z][0-9]{4})$'),
  modifiers        text[] NOT NULL DEFAULT '{}',
  place_of_service text NOT NULL DEFAULT '11' CHECK (place_of_service ~ '^[0-9]{2}$'),
  units            int NOT NULL DEFAULT 1 CHECK (units BETWEEN 1 AND 99),
  diagnosis_codes  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(diagnosis_codes) <= 12),
  fee_cents        int NOT NULL CHECK (fee_cents >= 0),
  paid_cents       int NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  paid_at          timestamptz,
  payment_method   text CHECK (payment_method IN ('cash','card','check','transfer','ath_movil','other')),
  superbill_id     text REFERENCES superbills(id) ON DELETE RESTRICT,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz,
  voided_by        text,
  void_reason      text,
  CONSTRAINT charge_not_overpaid CHECK (paid_cents <= fee_cents),
  CONSTRAINT charge_payment_complete CHECK (paid_cents = 0 OR (payment_method IS NOT NULL AND paid_at IS NOT NULL)),
  CONSTRAINT charge_void_complete CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS charges_by_contact ON charges(location_id, contact_id, service_date DESC);
CREATE INDEX IF NOT EXISTS charges_by_superbill ON charges(superbill_id) WHERE superbill_id IS NOT NULL;
-- A signed note has at most one LIVE charge (a voided one frees the note).
CREATE UNIQUE INDEX IF NOT EXISTS charges_one_per_note ON charges(session_note_id) WHERE session_note_id IS NOT NULL AND voided_at IS NULL;

CREATE OR REPLACE FUNCTION charge_guard() RETURNS trigger AS $$
DECLARE
  old_sb superbills%ROWTYPE;
  new_sb superbills%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'charge_no_delete' USING ERRCODE = 'P0001';
  END IF;
  NEW.id := OLD.id; NEW.location_id := OLD.location_id; NEW.contact_id := OLD.contact_id;
  NEW.created_at := OLD.created_at; NEW.created_by := OLD.created_by;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'charge_voided' USING ERRCODE = 'P0001';
  END IF;

  -- While the charge sits on a live superbill, only the payment may change.
  IF OLD.superbill_id IS NOT NULL THEN
    SELECT * INTO old_sb FROM superbills WHERE id = OLD.superbill_id;
    IF old_sb.voided_at IS NULL THEN
      IF NEW.superbill_id IS DISTINCT FROM OLD.superbill_id OR NEW.voided_at IS NOT NULL
         OR (to_jsonb(NEW) - ARRAY['paid_cents','paid_at','payment_method','updated_at'])
            <> (to_jsonb(OLD) - ARRAY['paid_cents','paid_at','payment_method','updated_at']) THEN
        RAISE EXCEPTION 'charge_issued' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- Attaching to a superbill: it must be live and belong to the same client and practice.
  IF NEW.superbill_id IS NOT NULL AND NEW.superbill_id IS DISTINCT FROM OLD.superbill_id THEN
    SELECT * INTO new_sb FROM superbills WHERE id = NEW.superbill_id;
    IF NOT FOUND OR new_sb.voided_at IS NOT NULL OR new_sb.contact_id <> NEW.contact_id OR new_sb.location_id <> NEW.location_id THEN
      RAISE EXCEPTION 'charge_superbill_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS charge_guard ON charges;
CREATE TRIGGER charge_guard BEFORE UPDATE OR DELETE ON charges
  FOR EACH ROW EXECUTE FUNCTION charge_guard();

-- =============================================================================
-- Billing, part 2 (A4): payments, receipts and invoices from a charge.
--
-- A payment is a fact (date, amount, method) and is never edited or deleted, only voided with a reason. Its receipt is
-- its proof: one receipt per payment, issued with it. `charges.paid_cents` stays as a DERIVED figure: the sum of the live
-- payments, recomputed by the application in the same transaction.
-- Invoices and receipts hold a frozen copy of what was issued; the database refuses to change one, and voiding is the
-- only change it allows. They carry no diagnosis, no CPT code, no tax id and no NPI: clients show them to employers,
-- family and banks.
-- =============================================================================

-- ATH Móvil. `charges` already exists in production, so its constraint is replaced in place (idempotent).
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_payment_method_check;
ALTER TABLE charges ADD CONSTRAINT charges_payment_method_check
  CHECK (payment_method IN ('cash','card','check','transfer','ath_movil','other'));

-- Shared by invoices, receipts and payments: a row can never be deleted, and the only change allowed is to void it once.
CREATE OR REPLACE FUNCTION void_only_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%_no_delete', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '%_voided', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason'])
     <> (to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason']) THEN
    RAISE EXCEPTION '%_immutable', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS billing_invoices (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id  text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  number      text NOT NULL,
  due_on      date,
  snapshot    jsonb NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  issued_by   text NOT NULL,
  voided_at   timestamptz,
  voided_by   text,
  void_reason text,
  CONSTRAINT billing_invoice_void_complete CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_number ON billing_invoices(location_id, number);
CREATE INDEX IF NOT EXISTS billing_invoices_by_contact ON billing_invoices(location_id, contact_id, issued_at DESC);
DROP TRIGGER IF EXISTS billing_invoices_guard ON billing_invoices;
CREATE TRIGGER billing_invoices_guard BEFORE UPDATE OR DELETE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION void_only_guard();

CREATE TABLE IF NOT EXISTS billing_receipts (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id  text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  number      text NOT NULL,
  method      text NOT NULL CHECK (method IN ('cash','card','check','transfer','ath_movil','other')),
  paid_on     date NOT NULL,
  snapshot    jsonb NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  issued_by   text NOT NULL,
  voided_at   timestamptz,
  voided_by   text,
  void_reason text,
  CONSTRAINT billing_receipt_void_complete CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_receipts_number ON billing_receipts(location_id, number);
CREATE INDEX IF NOT EXISTS billing_receipts_by_contact ON billing_receipts(location_id, contact_id, issued_at DESC);
DROP TRIGGER IF EXISTS billing_receipts_guard ON billing_receipts;
CREATE TRIGGER billing_receipts_guard BEFORE UPDATE OR DELETE ON billing_receipts
  FOR EACH ROW EXECUTE FUNCTION void_only_guard();

CREATE TABLE IF NOT EXISTS payments (
  id          text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id  text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  charge_id   text NOT NULL REFERENCES charges(id) ON DELETE RESTRICT,
  receipt_id  text NOT NULL REFERENCES billing_receipts(id) ON DELETE RESTRICT,
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  method      text NOT NULL CHECK (method IN ('cash','card','check','transfer','ath_movil','other')),
  paid_on     date NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  voided_at   timestamptz,
  voided_by   text,
  void_reason text,
  CONSTRAINT payment_void_complete CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS payments_by_charge ON payments(charge_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS payments_by_receipt ON payments(receipt_id);
DROP TRIGGER IF EXISTS payments_guard ON payments;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION void_only_guard();

-- A charge can now sit on an invoice as well as on a superbill; the two are independent.
ALTER TABLE charges ADD COLUMN IF NOT EXISTS invoice_id text REFERENCES billing_invoices(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS charges_by_invoice ON charges(invoice_id) WHERE invoice_id IS NOT NULL;

-- The charge guard, now aware of invoices. While a charge is on a live superbill or invoice its content is frozen
-- (only the derived payment figures and the two links may change); each link can be attached once to a live document
-- of the same client and practice, and released only when that document is voided.
CREATE OR REPLACE FUNCTION charge_guard() RETURNS trigger AS $$
DECLARE
  old_sb  superbills%ROWTYPE;
  new_sb  superbills%ROWTYPE;
  old_inv billing_invoices%ROWTYPE;
  new_inv billing_invoices%ROWTYPE;
  frozen  boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'charge_no_delete' USING ERRCODE = 'P0001';
  END IF;
  NEW.id := OLD.id; NEW.location_id := OLD.location_id; NEW.contact_id := OLD.contact_id;
  NEW.created_at := OLD.created_at; NEW.created_by := OLD.created_by;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'charge_voided' USING ERRCODE = 'P0001';
  END IF;

  IF OLD.superbill_id IS NOT NULL THEN
    SELECT * INTO old_sb FROM superbills WHERE id = OLD.superbill_id;
    IF old_sb.voided_at IS NULL THEN frozen := true; END IF;
  END IF;
  IF OLD.invoice_id IS NOT NULL THEN
    SELECT * INTO old_inv FROM billing_invoices WHERE id = OLD.invoice_id;
    IF old_inv.voided_at IS NULL THEN frozen := true; END IF;
  END IF;

  IF frozen THEN
    IF NEW.voided_at IS NOT NULL
       OR (to_jsonb(NEW) - ARRAY['paid_cents','paid_at','payment_method','updated_at','superbill_id','invoice_id'])
          <> (to_jsonb(OLD) - ARRAY['paid_cents','paid_at','payment_method','updated_at','superbill_id','invoice_id']) THEN
      RAISE EXCEPTION 'charge_issued' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.superbill_id IS DISTINCT FROM OLD.superbill_id THEN
    IF old_sb.id IS NOT NULL AND old_sb.voided_at IS NULL THEN
      RAISE EXCEPTION 'charge_issued' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.superbill_id IS NOT NULL THEN
      SELECT * INTO new_sb FROM superbills WHERE id = NEW.superbill_id;
      IF NOT FOUND OR new_sb.voided_at IS NOT NULL OR new_sb.contact_id <> NEW.contact_id OR new_sb.location_id <> NEW.location_id THEN
        RAISE EXCEPTION 'charge_superbill_mismatch' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    IF old_inv.id IS NOT NULL AND old_inv.voided_at IS NULL THEN
      RAISE EXCEPTION 'charge_issued' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.invoice_id IS NOT NULL THEN
      SELECT * INTO new_inv FROM billing_invoices WHERE id = NEW.invoice_id;
      IF NOT FOUND OR new_inv.voided_at IS NOT NULL OR new_inv.contact_id <> NEW.contact_id OR new_inv.location_id <> NEW.location_id THEN
        RAISE EXCEPTION 'charge_invoice_mismatch' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS charge_guard ON charges;
CREATE TRIGGER charge_guard BEFORE UPDATE OR DELETE ON charges
  FOR EACH ROW EXECUTE FUNCTION charge_guard();

-- Invoices and receipts emailed to the client. The email carries only a link; the page behind it asks for a one-time code
-- sent to the same address. Only the hash of the link token and of the code are stored.
CREATE TABLE IF NOT EXISTS billing_shares (
  id             text PRIMARY KEY,
  location_id    text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id     text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  kind           text NOT NULL CHECK (kind IN ('invoice','receipt')),
  document_id    text NOT NULL,
  email          text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  otp_hash       text,
  otp_expires_at timestamptz,
  otp_attempts   integer NOT NULL DEFAULT 0,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_shares_by_document ON billing_shares(location_id, kind, document_id, created_at DESC);

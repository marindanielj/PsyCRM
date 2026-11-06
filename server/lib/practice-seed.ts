import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import { seedDocuments } from './document-seed'
import { seedOnboardingWorkflows } from './onboarding-workflows'
import { PSYCRM_DEFAULT_MODULES } from './modules'
import { hashPassword } from './password'

/** The onboarding pipeline, in order. Keys are what the workflows (day 7) use. */
export const ONBOARDING_STAGES = [
  { key: 'new', name: 'New contact' },
  { key: 'sent', name: 'Documents sent' },
  { key: 'signed', name: 'Documents signed' },
  { key: 'booked', name: 'First appointment booked' },
  { key: 'active', name: 'Active client' },
  { key: 'lost', name: 'Did not continue' },
] as const

/** Contact custom fields a therapy intake needs. Types are limited to the ones
 *  the custom-field system supports (phone/email are plain text). */
export const CLINICAL_CUSTOM_FIELDS: { key: string; label: string; type: string; options?: string[] }[] = [
  { key: 'date_of_birth', label: 'Date of birth', type: 'date' },
  { key: 'preferred_name', label: 'Preferred name', type: 'text' },
  { key: 'pronouns', label: 'Pronouns', type: 'text' },
  { key: 'emergency_contact_name', label: 'Emergency contact', type: 'text' },
  { key: 'emergency_contact_phone', label: 'Emergency contact phone', type: 'text' },
  { key: 'emergency_contact_relation', label: 'Relationship', type: 'text' },
  { key: 'guardian_name', label: 'Guardian name', type: 'text' },
  { key: 'guardian_email', label: 'Guardian email', type: 'text' },
  { key: 'guardian_phone', label: 'Guardian phone', type: 'text' },
  { key: 'referral_source', label: 'Referral source', type: 'text' },
  { key: 'preferred_locale', label: 'Preferred language', type: 'dropdown', options: ['es', 'en'] },
]

export interface PracticeSeedInput {
  practiceName: string
  ownerEmail: string
  ownerName?: string
  /** Only used when the owner does not exist yet; an existing password is never touched. */
  ownerPassword?: string
}

export interface PracticeSeedResult {
  locationId: string
  operatorId: string
  createdOwner: boolean
  onboarding: { pipelineId: string; stages: Record<string, string> }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'practice'
  )
}

/**
 * Create (or complete) a single-practice PsyCRM tenant. Idempotent: every piece
 * is looked up before it is created, and an existing owner's password is never
 * changed, so it is safe to run on every deploy. Does NOT overwrite settings an
 * operator edited later (practice profile, enabledModules) — it only fills keys
 * that are missing.
 */
export async function seedPractice(db: Database, input: PracticeSeedInput): Promise<PracticeSeedResult> {
  const email = input.ownerEmail.trim().toLowerCase()
  if (!email) throw new Error('ownerEmail is required')
  if (!input.practiceName.trim()) throw new Error('practiceName is required')
  const slug = slugify(input.practiceName)
  const tz = 'America/Puerto_Rico'

  // --- location -----------------------------------------------------------
  let loc = (await db.query<{ id: string }>('SELECT id FROM locations WHERE slug=$1', [slug]))[0]
  if (!loc) {
    const id = `loc_${nanoid(10)}`
    await db.query(
      `INSERT INTO locations (id, name, slug, client_slug, branding, settings)
       VALUES ($1,$2,$3,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
      [id, input.practiceName.trim(), slug, JSON.stringify({}), JSON.stringify({})],
    )
    loc = (await db.query<{ id: string }>('SELECT id FROM locations WHERE slug=$1', [slug]))[0]!
  }
  const locationId = loc.id

  // --- owner --------------------------------------------------------------
  let createdOwner = false
  let op = (await db.query<{ id: string }>('SELECT id FROM operators WHERE email=$1', [email]))[0]
  if (!op) {
    if (!input.ownerPassword) throw new Error('ownerPassword is required when the owner does not exist yet')
    if (input.ownerPassword.length < 12) throw new Error('ownerPassword must be at least 12 characters')
    const id = `op_${nanoid(10)}`
    await db.query(
      `INSERT INTO operators (id, email, name, role, password_hash) VALUES ($1,$2,$3,'owner',$4)
       ON CONFLICT (email) DO NOTHING`,
      [id, email, input.ownerName ?? null, await hashPassword(input.ownerPassword)],
    )
    op = (await db.query<{ id: string }>('SELECT id FROM operators WHERE email=$1', [email]))[0]!
    createdOwner = op.id === id
  }
  await db.query(
    'INSERT INTO operator_locations (operator_id, location_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [op.id, locationId],
  )

  // --- onboarding pipeline ------------------------------------------------
  let pipeline = (
    await db.query<{ id: string }>('SELECT id FROM pipelines WHERE location_id=$1 AND name=$2', [locationId, 'Onboarding'])
  )[0]
  if (!pipeline) {
    const id = `pl_${nanoid(10)}`
    await db.query('INSERT INTO pipelines (id, location_id, name, position) VALUES ($1,$2,$3,0)', [id, locationId, 'Onboarding'])
    pipeline = { id }
  }
  const stages: Record<string, string> = {}
  for (const [i, st] of ONBOARDING_STAGES.entries()) {
    let row = (
      await db.query<{ id: string }>(
        'SELECT id FROM pipeline_stages WHERE location_id=$1 AND pipeline_id=$2 AND name=$3',
        [locationId, pipeline.id, st.name],
      )
    )[0]
    if (!row) {
      const id = `st_${nanoid(10)}`
      await db.query(
        'INSERT INTO pipeline_stages (id, location_id, pipeline_id, name, position) VALUES ($1,$2,$3,$4,$5)',
        [id, locationId, pipeline.id, st.name, i],
      )
      row = { id }
    }
    stages[st.key] = row.id
  }

  // --- calendar -----------------------------------------------------------
  const cal = (
    await db.query<{ id: string }>('SELECT id FROM calendars WHERE location_id=$1 AND name=$2', [locationId, 'Individual session'])
  )[0]
  if (!cal) {
    await db.query(
      `INSERT INTO calendars (id, location_id, name, color, duration_min, position, timezone, buffer_min, booking_enabled)
       VALUES ($1,$2,'Individual session','indigo',50,0,$3,10,false)`,
      [`cal_${nanoid(10)}`, locationId, tz],
    )
  }

  // --- clinical custom fields ---------------------------------------------
  for (const [i, f] of CLINICAL_CUSTOM_FIELDS.entries()) {
    await db.query(
      `INSERT INTO custom_fields (id, location_id, key, label, type, options, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (location_id, key) DO NOTHING`,
      [`cf_${nanoid(10)}`, locationId, f.key, f.label, f.type, JSON.stringify(f.options ?? []), i],
    )
  }

  // --- settings (fill missing keys only) -----------------------------------
  const settings = {
    enabledModules: [...PSYCRM_DEFAULT_MODULES],
    timezone: tz,
    practice: { name: input.practiceName.trim() },
    onboarding: { pipelineId: pipeline.id, stages },
  }
  // `||` puts the existing settings on the right, so anything already set wins;
  // onboarding is the one key we always refresh (ids are stable once created).
  await db.query(
    `UPDATE locations
     SET settings = $2::jsonb || COALESCE(settings, '{}'::jsonb) || jsonb_build_object('onboarding', $3::jsonb)
     WHERE id=$1`,
    [locationId, JSON.stringify({ enabledModules: settings.enabledModules, timezone: settings.timezone, practice: settings.practice }), JSON.stringify(settings.onboarding)],
  )

  // Starter document templates and packets (drafts the therapist must review).
  await seedDocuments(db, locationId)
  // The workflows that move clients along the pipeline (drafts until the documents are in force).
  await seedOnboardingWorkflows(db, locationId, settings.onboarding)

  return { locationId, operatorId: op.id, createdOwner, onboarding: settings.onboarding }
}

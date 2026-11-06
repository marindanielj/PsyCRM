import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import type { WorkflowEvent } from '../jobs/workflow-dispatcher'
import type { TemplateField } from '../lib/document-vocab'
import { seedDocuments } from '../lib/document-seed'
import type { EmailMessage } from '../lib/sending/provider'
import { documentsRoute } from '../routes/documents'
import { publicDocumentsRoute } from '../routes/public-documents'
import { addLocation, freshDb } from './pglite'

export const NOW = new Date('2026-11-05T15:00:00Z')

export interface Outbox {
  messages: EmailMessage[]
  /** The token inside the latest link emailed to `to`. */
  tokenFor(to: string): string
  /** The six-digit code in the latest email to `to`. */
  codeFor(to: string): string
}

/** A practice with an operator, an adult client (born 1990-04-12), a minor (born 2010-06-01) and two small active templates. */
export async function documentsSetup(opts: { emailConfigured?: boolean; seed?: boolean } = {}) {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  const other = await addLocation(db, 'loc_b')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera','h')")
  await db.query('UPDATE locations SET settings = $2::jsonb WHERE id = $1', [
    loc,
    JSON.stringify({ practice: { name: 'Consultorio Rivera', therapist: 'Dra. Rivera', license: '99', fees: { session: '$100', intake: '$150', late_cancel: '$50' }, policy: { cancel_hours: '24' } } }),
  ])
  await db.query(
    `INSERT INTO contacts (id, location_id, name, first_name, last_name, emails, custom_fields) VALUES
      ('c1',$1,'Ana Rivera','Ana','Rivera','{}','{"date_of_birth":"1990-04-12"}'),
      ('c2',$1,'Pedro Mora','Pedro','Mora','{}','{"date_of_birth":"2010-06-01"}'),
      ('c3',$1,'Sin Fecha',NULL,NULL,'{}','{}'),
      ('cx',$2,'Foreign','F','C','{}','{"date_of_birth":"1990-01-01"}')`,
    [loc, other],
  )

  const tpl = (slug: string, title: string, roles: string[], fields: TemplateField[], body: string, drawn = true) =>
    pg.query(
      `INSERT INTO document_templates (id, location_id, family_id, translation_group_id, version, status, kind, title, body_md, fields, signature, signer_roles)
       VALUES ($1,$2,$3,$3,1,'active','agreement',$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [`t_${slug}`, loc, `f_${slug}`, title, body, JSON.stringify(fields), JSON.stringify({ required: true, drawn }), roles],
    )
  await tpl('consent', 'Consentimiento', ['client'], [{ key: 'ini', type: 'initials', label: 'Iniciales', required: true }], 'Yo, {{client.full_name}}, consiento. {{field:ini}}')
  await tpl(
    'intake', 'Admisión', ['client'],
    [
      { key: 'first_name', type: 'text', label: 'Nombre', required: true, mapsTo: 'first_name' },
      { key: 'email', type: 'email', label: 'Correo', mapsTo: 'email' },
      { key: 'phone', type: 'phone', label: 'Teléfono', mapsTo: 'phone' },
      { key: 'dob', type: 'date', label: 'Nacimiento', required: true, mapsTo: 'custom:date_of_birth' },
      { key: 'emergency', type: 'text', label: 'Emergencia', mapsTo: 'custom:emergency_contact_name' },
      { key: 'meds', type: 'yes_no', label: 'Medicamentos', required: true },
      { key: 'which', type: 'text', label: 'Cuáles', required: true, showIf: { key: 'meds', equals: 'yes' } },
    ],
    'Cuestionario', false,
  )
  await tpl('guardian', 'Tutor', ['guardian'], [], 'Autorizo.')
  await tpl('assent', 'Asentimiento', ['minor'], [], 'Estoy de acuerdo.')
  await tpl('privacy', 'Privacidad', ['client'], [], 'Aviso.')
  const packet = (id: string, name: string, audience: string, families: string[]) =>
    pg.query('INSERT INTO document_packets (id, location_id, name, family_ids, audience) VALUES ($1,$2,$3,$4,$5)', [id, loc, name, families, audience])
  await packet('pk_adult', 'Onboarding – Adulto', 'adult', ['f_consent', 'f_intake'])
  await packet('pk_teen', 'Onboarding – Adolescente', 'adolescent', ['f_guardian', 'f_assent', 'f_privacy'])
  if (opts.seed) await seedDocuments(db, loc)

  const messages: EmailMessage[] = []
  const outbox: Outbox = {
    messages,
    tokenFor: (to) => {
      const m = [...messages].reverse().find((x) => x.to === to && /\/d\/[A-Za-z0-9_-]{43}/.test(x.text))
      if (!m) throw new Error(`no link email to ${to}`)
      return /\/d\/([A-Za-z0-9_-]{43})/.exec(m.text)![1]!
    },
    codeFor: (to) => {
      const m = [...messages].reverse().find((x) => x.to === to && /código de verificación es \d{6}/.test(x.text))
      if (!m) throw new Error(`no code email to ${to}`)
      return /es (\d{6})/.exec(m.text)![1]!
    },
  }
  const resolveEmail = async () =>
    opts.emailConfigured === false
      ? ({ ok: false, reason: 'no email provider connected' } as const)
      : ({ ok: true, sender: { name: 'test', sendEmail: async (m: EmailMessage) => (messages.push(m), { externalId: 'x', provider: 'test' }) } } as const)

  const events: WorkflowEvent[] = []
  let now = NOW
  const clock = { set: (d: Date) => (now = d), get: () => now }
  const mountOperator = (location = loc) => {
    const a = new Hono<AppEnv>()
    a.use('*', async (c, next) => {
      c.set('operatorId', 'op1')
      c.set('locationId', location)
      await next()
    })
    a.route('/', documentsRoute({ db, today: () => '2026-11-05', resolveEmail, publicBaseUrl: 'https://app.test' }))
    return a
  }
  const operator = mountOperator()
  const publicApp = new Hono<AppEnv>()
  publicApp.route('/d', publicDocumentsRoute({ db, sessionSecret: 'test-secret', resolveEmail, dispatch: (e) => void events.push(e), publicBaseUrl: 'https://app.test', now: () => now }))

  const json = async (res: Response) => {
    const text = await res.text()
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return { raw: text }
    }
  }
  const op = async (method: string, path: string, body?: unknown, app = operator) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', 'user-agent': 'UA/1', 'x-forwarded-for': '203.0.113.9' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: await json(res) }
  }
  /** One visitor: keeps its cookie jar between requests. */
  const visitor = (ip = '198.51.100.7') => {
    let cookie = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await publicApp.request(`/d${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'user-agent': 'Mobile/1', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      })
      const set = res.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]!
      const ct = res.headers.get('content-type') ?? ''
      const text = await res.text()
      return { status: res.status, headers: res.headers, text, json: ct.includes('json') ? JSON.parse(text) : null }
    }
    return { call, get cookie() { return cookie } }
  }
  /** Send the adult packet to Ana and return the link token. */
  const sendAdult = async (extra: Record<string, unknown> = {}) => {
    const r = await op('POST', '/requests', { contactId: 'c1', packetId: 'pk_adult', signers: [{ role: 'client', name: 'Ana Rivera', email: 'ana@example.com' }], ...extra })
    if (r.status !== 201) throw new Error(`send failed: ${JSON.stringify(r.json)}`)
    return { request: r.json.request as { id: string }, token: outbox.tokenFor('ana@example.com') }
  }
  const verified = async (token: string, email: string) => {
    const v = visitor()
    expect((await v.call('POST', `/${token}/otp`)).status).toBe(200)
    expect((await v.call('POST', `/${token}/verify`, { code: outbox.codeFor(email) })).status).toBe(200)
    return v
  }
  const png = `data:image/png;base64,${'A'.repeat(400)}`
  const signBody = (over: Record<string, unknown> = {}) => ({ values: {}, signerName: 'Ana Rivera', signaturePng: png, agreeTerms: true, esignConsent: true, ...over })
  const audits = () => db.query<{ action: string; actor_type: string; details: Record<string, any>; contact_id: string | null }>('SELECT action, actor_type, details, contact_id FROM audit_log WHERE location_id=$1 ORDER BY chain_seq', [loc])
  return { db, pg, loc, other, op, operator, mountOperator, visitor, outbox, events, clock, sendAdult, verified, signBody, png, audits, publicApp }
}
export type DocsSetup = Awaited<ReturnType<typeof documentsSetup>>

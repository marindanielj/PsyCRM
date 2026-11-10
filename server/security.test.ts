import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from './app-env'
import { createApp } from './index'
import { FakeDatabase } from './db/fake-database'
import { auditRoute } from './routes/audit'
import { documentsRoute } from './routes/documents'
import { invitesRoute } from './routes/invites'
import { SessionNotesRepo } from './repos/session-notes-repo'
import { sessionNotesRoute } from './routes/session-notes'
import { documentsSetup } from './test-utils/documents'
import { createSession } from './lib/session'

/** The cross-cutting security checks of the go-live list: one place that proves them. */

function sourceFiles(dir: string, ext: RegExp, skip: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p, ext, skip)
    return ext.test(name) && !skip.test(p) ? [p] : []
  })
}

// ---- tenancy: another practice sees nothing, of anything clinical ------------------------------------

test('a user of another practice cannot read a note, a template, a request, a signed document, an invitation or the audit log', async () => {
  const s = await documentsSetup()
  // practice A has one of each
  const { request } = await s.sendAdult()
  const token = s.outbox.tokenFor('ana@example.com')
  const v = await s.verified(token, 'ana@example.com')
  expect((await v.call('POST', `/${token}/sign/t_consent`, s.signBody({ values: { ini: 'AR' } }))).status).toBe(200)
  const signedId = (await s.db.query<{ id: string }>('SELECT id FROM signed_documents'))[0]!.id
  // a real note of practice A (the database insists the author is named, so it goes through the repository)
  const made = await new SessionNotesRepo(s.db, s.loc).create({ contactId: 'c1', sessionDate: '2026-11-01', dataSubjective: 'SECRET-CLINICAL-TEXT' } as never, { operatorId: 'op1', ip: null, userAgent: null })
  if (!made.ok) throw new Error('note not created')
  const noteId = made.note.id
  await s.db.query("INSERT INTO client_invites (id, location_id, kind, name, email, token_hash, sent_by) VALUES ('inv_a',$1,'adult','Ana','ana2@example.com','h_inv','op1')", [s.loc])

  // the same routes, mounted for practice B
  const asB = new Hono<AppEnv>()
  asB.use('*', async (c, next) => {
    c.set('operatorId', 'op_b')
    c.set('locationId', s.other)
    await next()
  })
  asB.route('/documents', documentsRoute({ db: s.db, today: () => '2026-11-05' }))
  asB.route('/invites', invitesRoute({ db: s.db }))
  asB.route('/notes', sessionNotesRoute({ db: s.db }))
  asB.route('/audit', auditRoute({ db: s.db }))
  const get = async (path: string, method = 'GET') =>
    asB.request(path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'x', signerId: 's' }) } : {}) })
  const body = async (path: string) => (await get(path)).text()

  for (const path of [
    '/documents/templates/t_consent', `/documents/requests/${request.id}`, `/documents/signed/${signedId}`, '/documents/templates/families/f_consent',
    `/notes/${noteId}`,
  ]) expect((await get(path)).status, path).toBe(404)
  expect(JSON.parse(await body('/documents/templates')).templates).toEqual([])
  expect(JSON.parse(await body('/documents/requests')).requests).toEqual([])
  expect(JSON.parse(await body(`/documents/signed?contactId=c1`)).documents).toEqual([])
  expect(JSON.parse(await body(`/notes/${noteId}/revisions`)).revisions).toEqual([]) // nothing to show, and nothing of the text
  expect(await body(`/notes/${noteId}/revisions`)).not.toContain('SECRET')
  expect(JSON.parse(await body('/invites')).invites).toEqual([])
  expect(JSON.parse(await body('/notes?contactId=c1')).notes).toEqual([])
  const audit = JSON.parse(await body('/audit'))
  expect(audit.entries).toEqual([])
  for (const [m, p] of [['POST', `/documents/requests/${request.id}/void`], ['POST', '/documents/templates/t_consent/activate'], ['POST', '/invites/inv_a/void'], ['POST', '/invites/inv_a/resend']] as const) {
    expect((await get(p, m)).status, `${m} ${p}`).toBe(404)
  }
  // and nothing of A's changed
  expect((await s.db.query<{ status: string }>('SELECT status FROM client_invites'))[0]!.status).toBe('sent')
  expect((await s.db.query<{ status: string }>('SELECT status FROM document_requests'))[0]!.status).not.toBe('voided')
})

// ---- no client data in logs, URLs or browser storage --------------------------------------------------

test('every console call in the server logs a code or a fixed message, never a request body or a record', () => {
  const files = sourceFiles('server', /\.ts$/, /\.test\.ts$|test-utils|dev-server/).concat(sourceFiles('db', /\.ts$/, /x^/))
  const calls = files.flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (/console\.(log|error|warn|info|debug)\(/.test(line) ? [{ at: `${f}:${i + 1}`, line: line.trim() }] : [])),
  )
  const allowed = [
    /console\.error\('(workflow audit write failed|workflow step failed|loop audit write failed|request failed)'/, // fixed text + a database error CODE (and the HTTP method)
    /console\.log\(`psycrm api listening on :\$\{config\.PORT\}`\)/,
    /console\.log\(`integrations enabled: /,
    /console\.error\(err\)$/, // process start-up failure (configuration / connection), before any request exists
    /console\.log\('openlevel: (seeded demo tenant|schema migrated)/,
    /console\.log\($/, // db/seed-practice.ts: the practice id (multi-line call)
    /console\.log\(`psycrm: documents seeded/,
    /console\.error\(err instanceof Error \? err\.message : err\)/, // seed scripts, run by an administrator
    // db/enable-module.ts (an administrator's one-off command): fixed sentences, the module names from the closed list, and a usage message or a database error CODE
    /console\.(log|error)\('enable-module: (module turned on|already on, nothing changed|unknown module name|no practice with that slug)'\)/,
    /console\.log\(`enable-module: modules now: \$\{r\.modules\.join\(', '\)\}`\)/,
    /console\.error\('enable-module failed:', err instanceof UsageError/,
  ]
  const offenders = calls.filter((c) => !allowed.some((re) => re.test(c.line)))
  expect(offenders, JSON.stringify(offenders, null, 1)).toEqual([])
})

test('an unexpected failure is logged by code only: an error that carries a name or an email never reaches the log', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    // any operator route that touches the database: make the database throw an error shaped like Postgres's
    const db = new FakeDatabase()
    db.enqueueError(Object.assign(new Error('duplicate key value violates unique constraint "contacts_match_key"'), { code: '23505', detail: 'Key (emails)=({marta.prueba@example.com}) already exists.' }))
    const a2 = createApp({ db, sessionSecret: 's'.repeat(32), webhookSecret: 'w' })
    const cookie = `ol_session=${createSession({ operatorId: 'op1' }, 's'.repeat(32))}`
    const res = await a2.request('/api/loc/locA/contacts', { headers: { cookie } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toContain('marta')
    expect(logged).not.toContain('example.com')
  } finally {
    spy.mockRestore()
  }
})

test('the web app keeps nothing about a client in localStorage or sessionStorage (only which practice is selected)', () => {
  const uses = sourceFiles('src', /\.(ts|tsx)$/, /\.test\./).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (/(localStorage|sessionStorage|indexedDB)\./.test(line) ? [`${f}:${i + 1} ${line.trim()}`] : [])),
  )
  expect(uses.every((u) => /STORAGE_KEY/.test(u) || /localStorage\.(getItem|setItem)\(STORAGE_KEY/.test(u)), uses.join('\n')).toBe(true)
  const key = readFileSync('src/state/location.tsx', 'utf8').match(/STORAGE_KEY\s*=\s*'([^']+)'/)?.[1]
  expect(key).toMatch(/location/i)
})

test('no route puts a client\'s details in a URL: paths use ids and tokens only', () => {
  const offenders = sourceFiles('src', /\.(ts|tsx)$/, /\.test\./).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
      // a template URL that interpolates a name, email, phone, date of birth or note text
      /(`[^`]*\/(loc|contacts|d|i)\/[^`]*\$\{[^}]*(\.name|\.email|email\b|phone|dateOfBirth|date_of_birth|bodyMd|body\b)[^}]*\}[^`]*`)/.test(line) && !/qs\(/.test(line) ? [`${f}:${i + 1} ${line.trim()}`] : [],
    ),
  )
  expect(offenders).toEqual([])
})

// ---- headers on every kind of response ----------------------------------------------------------------

test('every kind of response carries the security headers; the app is strict, the signing and invitation pages bring their own nonce policy', async () => {
  const app = createApp({ db: new FakeDatabase(), sessionSecret: 's'.repeat(32), webhookSecret: 'w' })
  for (const path of ['/health', '/api/nope', '/api/loc/x/contacts']) {
    const res = await app.request(path)
    expect(res.headers.get('x-frame-options'), path).toBe('DENY')
    expect(res.headers.get('referrer-policy'), path).toBe('no-referrer')
    expect(res.headers.get('strict-transport-security'), path).toMatch(/max-age=\d{7,}/)
    expect(res.headers.get('content-security-policy'), path).toContain("script-src 'self'")
    expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
  }
  for (const prefix of ['/d', '/i']) {
    const res = await app.request(`${prefix}/${'A'.repeat(43)}`)
    expect(res.headers.get('content-security-policy'), prefix).toMatch(/script-src 'nonce-[^']+'/)
    expect(res.headers.get('cache-control'), prefix).toBe('no-store')
    expect(res.headers.get('referrer-policy'), prefix).toBe('no-referrer')
    expect(res.headers.get('x-frame-options'), prefix).toBe('DENY')
    expect(res.headers.get('x-robots-tag'), prefix).toContain('noindex')
  }
  expect((await app.request('/api/loc/x/contacts')).headers.get('cache-control')).toBe('no-store')
})

// ---- integrations stay off -----------------------------------------------------------------------------

test('with no integrations enabled, the routes that send client data to third parties do not exist', async () => {
  const app = createApp({ db: new FakeDatabase(), sessionSecret: 's'.repeat(32), webhookSecret: 'w' })
  const cookie = `ol_session=${createSession({ operatorId: 'op1' }, 's'.repeat(32))}`
  for (const path of ['/api/webhooks/chatwoot', '/api/public/f/x/y', '/api/public/forms/x/y', '/api/public/pay/x', '/api/public/voice/x', '/federation/x']) {
    expect([404], path).toContain((await app.request(path, { method: 'POST' })).status)
  }
  void cookie
})

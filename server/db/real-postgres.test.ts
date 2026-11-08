import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { PgDatabase } from './database'
import { seedPractice } from '../lib/practice-seed'
import { SessionNotesRepo } from '../repos/session-notes-repo'
import { DocumentRequestsRepo } from '../repos/document-requests-repo'
import { audit } from '../lib/audit'
import { completeInvite } from '../lib/invite-complete'
import { hashToken, newToken } from '../lib/document-tokens'

/**
 * Concurrency and fidelity checks against a REAL PostgreSQL (PGlite serves one query at a time, so
 * it cannot show a race). Skipped unless PG_TEST_URL points at a server where this user may create
 * databases:
 *
 *   PG_TEST_URL=postgres://postgres@localhost:5544/postgres npx vitest run server/db/real-postgres.test.ts
 *
 * Each run creates (and drops) its own database.
 */
const PG_URL = process.env.PG_TEST_URL
const suite = PG_URL ? describe : describe.skip
const SCHEMA = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8')

suite('on a real PostgreSQL', () => {
  const name = `psycrm_t_${Math.random().toString(36).slice(2, 10)}`
  let admin: Pool
  let pool: Pool
  let db: PgDatabase
  let loc: string
  let operatorId: string
  const actor = () => ({ operatorId, ip: '203.0.113.9', userAgent: 'UA' })

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL })
    await admin.query(`CREATE DATABASE ${name}`)
    const u = new URL(PG_URL!)
    u.pathname = `/${name}`
    pool = new Pool({ connectionString: u.toString(), max: 12 })
    pool.on('error', () => {}) // the server dropping idle connections when the test database is removed is expected
    await pool.query(SCHEMA)
    db = new PgDatabase(pool)
    const s = await seedPractice(db, { practiceName: 'Consultorio Real', ownerEmail: 'dra@example.com', ownerName: 'Dra', ownerPassword: 'a-long-test-password' })
    loc = s.locationId
    operatorId = s.operatorId
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin?.end()
  })

  test('the schema applies a second time without error, and the seed is idempotent', async () => {
    await pool.query(SCHEMA)
    const again = await seedPractice(db, { practiceName: 'Consultorio Real', ownerEmail: 'dra@example.com', ownerPassword: 'a-long-test-password' })
    expect(again.locationId).toBe(loc)
    expect((await pool.query('SELECT count(*)::int AS n FROM document_templates WHERE location_id=$1', [loc])).rows[0].n).toBe(9)
  })

  test('60 audit entries written at the same moment get one unbroken, verifiable chain', async () => {
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => db.transaction((tx) => audit(tx, loc, { action: 'contact.viewed', entityType: 'contact', entityId: `c${i}`, details: { i }, actor: { type: 'system', label: 'race test' } }))),
    )
    const rows = (await pool.query('SELECT chain_seq FROM audit_log WHERE location_id=$1 ORDER BY chain_seq', [loc])).rows.map((r) => Number(r.chain_seq))
    expect(rows).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1)) // 1..N, no gaps, no duplicates
    expect(Number((await pool.query('SELECT audit_log_verify($1) AS bad', [loc])).rows[0].bad)).toBe(0)
  })

  test('the acting person set for one transaction never leaks to the next use of the same connection', async () => {
    const one = new Pool({ connectionString: pool.options.connectionString, max: 1 })
    one.on('error', () => {})
    try {
      const d = new PgDatabase(one)
      await d.transaction(async (tx) => {
        await tx.query("SELECT set_config('psycrm.actor', 'op_x', true)")
        expect((await tx.query<{ a: string }>("SELECT current_setting('psycrm.actor', true) AS a"))[0]!.a).toBe('op_x')
      })
      expect((await d.query<{ a: string | null }>("SELECT current_setting('psycrm.actor', true) AS a"))[0]!.a ?? '').toBe('')
    } finally {
      await one.end()
    }
  })

  test('simultaneous edits of one session note are serialised: every one is recorded, none lost', async () => {
    const [c] = (await pool.query("INSERT INTO contacts (id, location_id, name, custom_fields) VALUES ('c_note',$1,'Ana','{}') RETURNING id", [loc])).rows
    const notes = new SessionNotesRepo(db, loc)
    const created = await notes.create({ contactId: c.id, sessionDate: '2026-11-01' } as never, actor())
    if (!created.ok) throw new Error('create failed')
    const id = created.note.id
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => notes.update(id, { dataSubjective: `version ${i}`, changeReason: 'race' } as never, actor())))
    expect(results.every((r) => r.ok)).toBe(true)
    const revs = (await pool.query('SELECT revision FROM session_note_revisions WHERE note_id=$1 ORDER BY revision', [id])).rows.map((r) => Number(r.revision))
    expect(revs).toEqual(Array.from({ length: revs.length }, (_, i) => i + 1)) // contiguous
    expect(revs.length).toBeGreaterThanOrEqual(2)
    const final = (await pool.query('SELECT data_subjective FROM session_notes WHERE id=$1', [id])).rows[0].data_subjective
    expect(final).toMatch(/^version \d+$/)
  })

  async function packetFixture(slug: string, roles: string[][]) {
    const c = `c_${slug}`
    await pool.query("INSERT INTO contacts (id, location_id, name, custom_fields) VALUES ($1,$2,$3,'{\"date_of_birth\":\"1990-04-12\"}')", [c, loc, `Cliente ${slug}`])
    const tids: string[] = []
    for (const [i, r] of roles.entries()) {
      const id = `t_${slug}_${i}`
      await pool.query(
        "INSERT INTO document_templates (id, location_id, family_id, translation_group_id, version, status, kind, title, body_md, signature, signer_roles) VALUES ($1,$2,$3,$3,1,'active','agreement','Doc','texto','{\"required\":true,\"drawn\":false}',$4)",
        [id, loc, `f_${slug}_${i}`, r],
      )
      tids.push(id)
    }
    const req = `r_${slug}`
    await pool.query("INSERT INTO document_requests (id, location_id, contact_id, packet_name, audience, template_ids, sent_by) VALUES ($1,$2,$3,'P','adult',$4,'op')", [req, loc, c, tids])
    return { c, tids, req }
  }
  const publicActor = (signerId: string, role: 'client' | 'guardian' | 'minor') => ({ signerId, role, ip: '198.51.100.7', userAgent: 'Phone' })
  const signInput = (signerId: string, templateId: string) => ({ signerId, templateId, signerName: 'Ana', signaturePng: null, agreeTerms: true, esignConsent: true, values: {} })

  test('the same document signed twice at the same moment is one signature, and both calls get it', async () => {
    const f = await packetFixture('dup', [['client']])
    await pool.query("INSERT INTO document_signers (id, location_id, request_id, role, name, email, token_hash) VALUES ('s_dup',$1,$2,'client','Ana','a@x.com',$3)", [loc, f.req, hashToken(newToken())])
    const repo = new DocumentRequestsRepo(db, loc)
    const rs = await Promise.all(Array.from({ length: 6 }, () => repo.sign(signInput('s_dup', f.tids[0]!), publicActor('s_dup', 'client'))))
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(new Set(rs.map((r) => (r.ok ? r.signed.id : ''))).size).toBe(1)
    expect((await pool.query("SELECT count(*)::int AS n FROM signed_documents WHERE signer_id='s_dup'")).rows[0].n).toBe(1)
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='document.signed' AND entity_type='signed_document' AND (details->>'requestId')=$1", [f.req])).rows[0].n).toBe(1)
  })

  test('two people finishing the last documents of a packet at the same moment complete it exactly once', async () => {
    const f = await packetFixture('two', [['guardian'], ['minor']])
    await pool.query("UPDATE document_requests SET audience='adolescent' WHERE id=$1", [f.req])
    await pool.query("INSERT INTO document_signers (id, location_id, request_id, role, name, email, token_hash) VALUES ('s_g',$1,$2,'guardian','Rosa','r@x.com',$3),('s_m',$1,$2,'minor','Pedro','p@x.com',$4)", [loc, f.req, hashToken(newToken()), hashToken(newToken())])
    const repo = new DocumentRequestsRepo(db, loc)
    const [a, b] = await Promise.all([repo.sign(signInput('s_g', f.tids[0]!), publicActor('s_g', 'guardian')), repo.sign(signInput('s_m', f.tids[1]!), publicActor('s_m', 'minor'))])
    expect(a.ok && b.ok).toBe(true)
    expect((await pool.query('SELECT status FROM document_requests WHERE id=$1', [f.req])).rows[0].status).toBe('completed')
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='packet.completed' AND entity_id=$1", [f.req])).rows[0].n).toBe(1)
    const completed = [a, b].filter((r) => r.ok && r.requestCompleted).length
    expect(completed).toBe(1) // only one of the two callers sees the completion, so only one dispatch is made
  })

  test('an invitation completed from several tabs at once creates one client', async () => {
    const tokenHash = hashToken(newToken())
    await pool.query("INSERT INTO client_invites (id, location_id, kind, name, email, token_hash, sent_by) VALUES ('inv_race',$1,'adult','Marta Prueba','marta@example.com',$2,'op')", [loc, tokenHash])
    const invite = { id: 'inv_race', kind: 'adult' as const, name: 'Marta Prueba', email: 'marta@example.com', status: 'sent' as const, sentAt: '', expiresAt: '', openedAt: null, completedAt: null, contactId: null }
    const rs = await Promise.all(Array.from({ length: 6 }, () => completeInvite(db, loc, invite, { firstName: 'Marta', lastName: 'Prueba', dateOfBirth: '1988-03-04' }, { ip: '1.2.3.4', userAgent: 'UA' })))
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'closed')).toBe(true)
    expect((await pool.query("SELECT count(*)::int AS n FROM contacts WHERE location_id=$1 AND emails @> ARRAY['marta@example.com']::text[]", [loc])).rows[0].n).toBe(1)
  })

  test('the database refuses what the application would refuse: a locked note, a signed document, the audit log', async () => {
    const [{ id }] = (await pool.query("SELECT id FROM signed_documents LIMIT 1")).rows
    await expect(pool.query("UPDATE signed_documents SET signer_name='X' WHERE id=$1", [id])).rejects.toThrow()
    await expect(pool.query('DELETE FROM audit_log WHERE location_id=$1', [loc])).rejects.toThrow()
    await expect(pool.query("UPDATE audit_log SET action='x' WHERE location_id=$1", [loc])).rejects.toThrow()
    const note = (await pool.query("SELECT id FROM session_notes LIMIT 1")).rows[0]
    await expect(pool.query('DELETE FROM session_notes WHERE id=$1', [note.id])).rejects.toThrow()
  })

  test('dates come back as plain text, whatever the server time zone', async () => {
    const note = (await pool.query("SELECT id FROM session_notes LIMIT 1")).rows[0]
    const got = await new SessionNotesRepo(db, loc).get(note.id)
    expect(got?.session_date).toBe('2026-11-01')
  })
})

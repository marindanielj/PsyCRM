import { addLocation, freshDb } from '../test-utils/pglite'

async function setup() {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  await db.query("INSERT INTO contacts (id, location_id, name) VALUES ('c1',$1,'Ana')", [loc])
  await db.query("INSERT INTO document_templates (id, location_id, family_id, translation_group_id, kind, title) VALUES ('t1',$1,'f','tg','agreement','T')", [loc])
  await db.query("INSERT INTO document_requests (id, location_id, contact_id, packet_name, template_ids, sent_by) VALUES ('r1',$1,'c1','P','{t1}','op')", [loc])
  await db.query("INSERT INTO document_signers (id, location_id, request_id, role, name, email, token_hash) VALUES ('s1',$1,'r1','client','Ana','a@x.com','h1')", [loc])
  const sign = (over: Record<string, unknown> = {}) => {
    const v = { id: 'd1', consent: true, signer: 's1', ...over }
    return pg.query(
      `INSERT INTO signed_documents (id, location_id, contact_id, request_id, signer_id, signer_role, template_id, template_title, template_version, locale, field_values, rendered_html, content_sha256, signer_name, esign_consent, signer_ip, signer_user_agent, verified_via)
       VALUES ($1,$2,'c1','r1',$3,'client','t1','T',1,'es','{}','<p>x</p>','abc','Ana',$4,'1.2.3.4','UA','email_otp')`,
      [v.id, loc, v.signer, v.consent],
    )
  }
  return { db, pg, loc, sign }
}
const fails = async (p: Promise<unknown>, re: RegExp) => expect(String(await p.then(() => 'ok', (e) => e.message))).toMatch(re)

test('a signature is evidence: it cannot be edited, deleted or truncated', async () => {
  const { pg, sign } = await setup()
  await sign()
  await fails(pg.query("UPDATE signed_documents SET signer_name='X'"), /immutable|append-only|not allowed/i)
  await fails(pg.query("UPDATE signed_documents SET rendered_html='<p>changed</p>'"), /immutable|append-only|not allowed/i)
  await fails(pg.query('DELETE FROM signed_documents'), /immutable|append-only|not allowed/i)
  await fails(pg.exec('TRUNCATE signed_documents'), /immutable|append-only|not allowed/i)
  expect((await pg.query('SELECT 1 FROM signed_documents')).rows).toHaveLength(1)
})

test('electronic-signature consent is always true', async () => {
  const { sign } = await setup()
  await fails(sign({ consent: false }), /esign_consent|check/i)
})

test('a signer signs each document once', async () => {
  const { sign } = await setup()
  await sign()
  await fails(sign({ id: 'd2' }), /duplicate|unique/i)
})

test('a signed document cannot lose its request, signer or client record', async () => {
  const { pg, sign } = await setup()
  await sign()
  await fails(pg.query("DELETE FROM document_requests WHERE id='r1'"), /foreign key|violates/i)
  await fails(pg.query("DELETE FROM document_signers WHERE id='s1'"), /foreign key|violates/i)
  await fails(pg.query("DELETE FROM contacts WHERE id='c1'"), /foreign key|violates/i)
})

test('a request has one signer per role and one link per signer, statuses are constrained', async () => {
  const { pg, loc } = await setup()
  await fails(pg.query("INSERT INTO document_signers (id, location_id, request_id, role, name, email, token_hash) VALUES ('s2',$1,'r1','client','B','b@x.com','h2')", [loc]), /duplicate|unique/i)
  await fails(pg.query("INSERT INTO document_signers (id, location_id, request_id, role, name, email, token_hash) VALUES ('s2',$1,'r1','guardian','B','b@x.com','h1')", [loc]), /duplicate|unique/i)
  await fails(pg.query("UPDATE document_requests SET status='done'"), /check/i)
  await fails(pg.query("UPDATE document_signers SET role='nurse'"), /check/i)
})

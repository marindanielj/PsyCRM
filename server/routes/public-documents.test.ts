import { createHash } from 'node:crypto'
import { hashToken } from '../lib/document-tokens'
import { NOW, documentsSetup } from '../test-utils/documents'

const ANA = 'ana@example.com'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

test('an unknown, malformed, voided or expired link all get the same page; a good one shows only a masked email', async () => {
  const s = await documentsSetup()
  const { request, token } = await s.sendAdult()
  const unknown = await s.visitor().call('GET', `/${'A'.repeat(43)}`)
  const malformed = await s.visitor().call('GET', '/short')
  expect(unknown.status).toBe(404)
  expect(malformed.text).toBe(unknown.text.replace(/nonce="[^"]+"/g, '')) // no script on either, so identical bytes
  expect(unknown.text).toContain('Este enlace no es válido o expiró')

  const good = await s.visitor().call('GET', `/${token}`)
  expect(good.status).toBe(200)
  expect(good.text).toContain('a***@example.com')
  for (const leak of ['Ana Rivera', 'Consentimiento', 'Admisión', '1990', 'ana@']) expect(good.text).not.toContain(leak)
  expect(good.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+'/)
  expect(good.headers.get('cache-control')).toBe('no-store')
  expect(good.headers.get('x-robots-tag')).toContain('noindex')

  await s.op('POST', `/requests/${request.id}/void`, { reason: 'x' })
  const voided = await s.visitor().call('GET', `/${token}`)
  expect(voided.status).toBe(404)
  expect(voided.text).toBe(unknown.text.replace(/nonce="[^"]+"/g, ''))
})

test('the code: five wrong tries lock the link, a right one opens it, and the session expires after an hour', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult()
  const v = s.visitor()
  expect((await v.call('POST', `/${token}/otp`)).status).toBe(200)
  const good = s.outbox.codeFor(ANA)
  const wrong = good === '000000' ? '111111' : '000000'
  for (let i = 1; i <= 4; i++) expect((await v.call('POST', `/${token}/verify`, { code: wrong })).json).toMatchObject({ error: 'code_invalid', remaining: 5 - i })
  expect((await v.call('POST', `/${token}/verify`, { code: wrong })).status).toBe(423)
  expect((await v.call('POST', `/${token}/verify`, { code: good })).status).toBe(423) // even the right code, now
  expect((await v.call('GET', `/${token}`)).text).toContain('bloqueado')
  expect((await s.audits()).map((a) => a.action)).toContain('signer.locked')

  // a fresh link from the therapist works, and the session lapses after 60 minutes
  const signerId = (await s.db.query<{ id: string }>('SELECT id FROM document_signers'))[0]!.id
  const requestId = (await s.db.query<{ id: string }>('SELECT id FROM document_requests'))[0]!.id
  await s.op('POST', `/requests/${requestId}/resend`, { signerId })
  const t2 = s.outbox.tokenFor(ANA)
  const w = await s.verified(t2, ANA)
  expect((await w.call('GET', `/${t2}`)).text).toContain('Consentimiento') // checklist
  s.clock.set(new Date(NOW.getTime() + 61 * 60_000))
  expect((await w.call('GET', `/${t2}`)).text).toContain('Verifique su identidad')
  expect((await w.call('POST', `/${t2}/sign/t_consent`, s.signBody())).status).toBe(401)
})

test('the code expires after 10 minutes and sending codes is rate limited', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult()
  const v = s.visitor()
  await v.call('POST', `/${token}/otp`)
  const code = s.outbox.codeFor(ANA)
  s.clock.set(new Date(NOW.getTime() + 11 * 60_000))
  expect((await v.call('POST', `/${token}/verify`, { code })).status).toBe(401)
  s.clock.set(NOW)
  expect((await v.call('POST', `/${token}/otp`)).status).toBe(200)
  expect((await v.call('POST', `/${token}/otp`)).status).toBe(200)
  expect((await v.call('POST', `/${token}/otp`)).status).toBe(429) // 3 per 15 min per signer
})

test('nothing is served before verification; the sign endpoint needs the signer\'s cookie and no other link\'s cookie works', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult()
  const anon = s.visitor()
  expect((await anon.call('POST', `/${token}/sign/t_consent`, s.signBody())).status).toBe(401)
  expect((await anon.call('POST', `/${token}/draft`, { templateId: 't_consent', values: {} })).status).toBe(401)
  expect((await anon.call('GET', `/${token}/copy`)).status).toBe(302)
  expect((await anon.call('GET', `/${token}?doc=1`)).text).not.toContain('Consentimiento')
})

test('signing a document stores an immutable record whose hash matches its text, and signing twice returns the first', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult()
  const v = await s.verified(token, ANA)
  const page = await v.call('GET', `/${token}?doc=1`)
  expect(page.text).toContain('Documento 1 de 2')
  expect(page.text).toContain('Yo, Ana Rivera, consiento.')
  expect(page.text).toContain('name="ini"')

  const first = await v.call('POST', `/${token}/sign/t_consent`, s.signBody({ values: { ini: 'AR' } }))
  expect(first.status, first.text).toBe(200)
  expect(first.json).toMatchObject({ ok: true, signerCompleted: false, next: `/d/${token}?doc=2` })
  const row = (await s.db.query<Record<string, any>>("SELECT * FROM signed_documents WHERE template_id='t_consent'"))[0]!
  expect(row).toMatchObject({ signer_name: 'Ana Rivera', signer_role: 'client', esign_consent: true, verified_via: 'email_otp', template_version: 1, locale: 'es', signer_ip: '198.51.100.7', signer_user_agent: 'Mobile/1' })
  expect(row.field_values).toEqual({ ini: 'AR' })
  expect(sha(row.rendered_html)).toBe(row.content_sha256)
  expect(row.rendered_html).toContain('Firmado electrónicamente por Ana Rivera')
  expect(row.rendered_html).toContain('5 de noviembre de 2026, 11:00 a. m. AST')
  expect(row.rendered_html).toContain('a***@example.com')
  expect(row.rendered_html).toContain(`Documento ${row.id}`)
  expect(row.rendered_html).toContain('data:image/png;base64,')
  expect(row.signature_png).toBe(s.png)

  // immutable
  for (const sql of ["UPDATE signed_documents SET signer_name='X'", 'DELETE FROM signed_documents', 'TRUNCATE signed_documents']) {
    await expect(s.db.query(sql)).rejects.toThrow()
  }
  // idempotent
  const again = await v.call('POST', `/${token}/sign/t_consent`, s.signBody({ values: { ini: 'ZZ' }, signerName: 'Otra Persona' }))
  expect(again.json.signedId).toBe(row.id)
  expect(await s.db.query('SELECT 1 FROM signed_documents')).toHaveLength(1)
  // the signed document is now read-only on the page
  expect((await v.call('GET', `/${token}?doc=1`)).text).toContain('ya firmado')
})

test('what is refused: missing consent, a wrong document, missing or invalid answers, a bad or oversized signature', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult()
  const v = await s.verified(token, ANA)
  const sign = (tid: string, body: unknown) => v.call('POST', `/${token}/sign/${tid}`, body)
  expect((await sign('t_consent', s.signBody({ values: { ini: 'A' }, esignConsent: false }))).json.error).toBe('consent_required')
  expect((await sign('t_consent', s.signBody({ values: { ini: 'A' }, agreeTerms: false }))).json.error).toBe('consent_required')
  expect((await sign('t_consent', s.signBody({ values: { ini: 'A' }, signerName: '  ' }))).json.error).toBe('name_required')
  expect((await sign('t_consent', s.signBody({ values: { ini: 'A' }, signaturePng: null }))).json.error).toBe('signature_required')
  expect((await sign('t_consent', s.signBody({ values: { ini: 'A' }, signaturePng: 'javascript:alert(1)' }))).status).toBe(422)
  expect((await sign('t_consent', s.signBody({ values: { ini: 'A' }, signaturePng: `data:image/png;base64,${'A'.repeat(160_000)}` }))).status).toBe(413)
  const missing = await sign('t_consent', s.signBody({ values: {} }))
  expect(missing.status).toBe(422)
  expect(missing.json).toMatchObject({ error: 'invalid_answers', issues: [{ key: 'ini', reason: 'required' }] })
  expect((await sign('t_guardian', s.signBody())).status).toBe(403) // not in this packet
  expect((await sign('t_nope', s.signBody())).status).toBe(403)
  expect(await s.db.query('SELECT 1 FROM signed_documents')).toHaveLength(0)

  // intake: conditional field is required only when shown; garbage in a typed field is refused
  const intake = (values: Record<string, unknown>) => sign('t_intake', s.signBody({ values, signaturePng: null }))
  const base = { first_name: 'Ana', dob: '1990-04-12' }
  expect((await intake({ ...base, meds: 'yes' })).json.issues).toEqual([{ key: 'which', reason: 'required' }])
  expect((await intake({ ...base, meds: 'no', email: 'not-an-email' })).json.issues).toEqual([{ key: 'email', reason: 'invalid' }])
  expect((await intake({ ...base, meds: 'maybe' })).json.issues).toEqual([{ key: 'meds', reason: 'invalid' }])
  expect((await intake({ ...base, meds: 'no', which: 'ignored because hidden' })).status).toBe(200)
  const stored = (await s.db.query<{ field_values: Record<string, unknown>; signature_png: string | null }>("SELECT field_values, signature_png FROM signed_documents WHERE template_id='t_intake'"))[0]!
  expect(stored.field_values).toEqual({ first_name: 'Ana', dob: '1990-04-12', meds: 'no' }) // the hidden answer was dropped
  expect(stored.signature_png).toBeNull() // this template asks for no drawn signature
})

test('finishing every document completes the packet once: audit as the client, one dispatch, the answers reach the record, and a copy is emailed', async () => {
  const s = await documentsSetup()
  const { request, token } = await s.sendAdult()
  const v = await s.verified(token, ANA)
  await v.call('POST', `/${token}/sign/t_consent`, s.signBody({ values: { ini: 'AR' } }))
  expect(s.events.filter((e) => e.triggerType === 'documents_completed')).toHaveLength(0)
  const last = await v.call('POST', `/${token}/sign/t_intake`, s.signBody({ signaturePng: null, values: { first_name: 'Anita', email: 'Ana@Example.com', phone: '(787) 555-0101', dob: '1990-04-12', emergency: 'Rosa Rivera', meds: 'no' } }))
  expect(last.json).toMatchObject({ ok: true, signerCompleted: true, next: `/d/${token}` })
  await v.call('POST', `/${token}/sign/t_intake`, s.signBody({ signaturePng: null, values: { first_name: 'Anita', dob: '1990-04-12', meds: 'no' } })) // replay
  expect(s.events.filter((e) => e.triggerType === 'documents_completed')).toEqual([{ locationId: 'loc_a', triggerType: 'documents_completed', contactId: 'c1', depth: 0, payload: { requestId: request.id, packetId: 'pk_adult' } }])
  // one document_signed per signature (the replay of the last one adds none), with the document's family
  expect(s.events.filter((e) => e.triggerType === 'document_signed').map((e) => e.payload?.templateFamilyId)).toEqual(['f_consent', 'f_intake'])

  const req = (await s.op('GET', `/requests/${request.id}`)).json.request
  expect(req.status).toBe('completed')
  expect(req.signers[0]).toMatchObject({ status: 'completed' })
  expect(req.documents.every((d: any) => d.signedAt)).toBe(true)

  const c = (await s.db.query<Record<string, any>>("SELECT first_name, emails, phones, custom_fields FROM contacts WHERE id='c1'"))[0]!
  expect(c.emails).toEqual(['ana@example.com'])
  expect(c.phones).toEqual(['+17875550101'])
  expect(c.custom_fields).toMatchObject({ date_of_birth: '1990-04-12', emergency_contact_name: 'Rosa Rivera' })
  expect(c.first_name).toBe('Ana') // the record already had a name: kept
  expect(c.custom_fields.intake_conflicts).toEqual({ first_name: { record: 'Ana', answered: 'Anita' } })

  const log = await s.audits()
  const by = (a: string) => log.filter((x) => x.action === a)
  expect(by('document.viewed')).toHaveLength(1)
  expect(by('document.signed')).toHaveLength(2)
  for (const a of ['document.viewed', 'document.signed', 'signer.completed', 'packet.completed', 'contact.updated_from_intake']) expect(by(a)[0]!.actor_type, a).toBe('client')
  const handoff = by('contact.updated_from_intake')[0]!.details
  expect([...handoff.fields].sort()).toEqual(['custom:date_of_birth', 'custom:emergency_contact_name', 'email', 'phone'])
  expect(handoff.conflicts).toEqual(['first_name'])
  expect(JSON.stringify(log)).not.toContain('Rosa Rivera')

  // the copy: email without PHI, then the printable page (audited)
  const mail = [...s.outbox.messages].reverse().find((m) => m.subject.includes('firmados'))!
  expect(mail.text).toContain(`https://app.test/d/${token}`)
  expect(`${mail.subject}${mail.text}`).not.toContain('Consentimiento')
  const copy = await v.call('GET', `/${token}/copy`)
  expect(copy.status).toBe(200)
  expect(copy.text).toContain('Yo, Ana Rivera, consiento.')
  expect(copy.text).toContain('Firmado electrónicamente por Ana Rivera')
  expect((await s.audits()).filter((x) => x.action === 'document.downloaded')).toHaveLength(1)
  expect((await v.call('GET', `/${token}`)).text).toContain('¡Gracias!')
  const { timeline } = { timeline: (await s.db.query<{ type: string }>("SELECT type FROM timeline_events WHERE contact_id='c1' ORDER BY occurred_at")).map((t) => t.type) }
  expect(timeline).toEqual(expect.arrayContaining(['documents_sent', 'document_signed', 'documents_completed']))
})

test('progress can be saved and resumed from the same link, and a many-document packet shows a checklist', async () => {
  const s = await documentsSetup()
  const { request, token } = await s.sendAdult()
  const v = await s.verified(token, ANA)
  const checklist = await v.call('GET', `/${token}`)
  expect(checklist.text).toContain('2</strong> documentos por completar')
  expect(checklist.text).toContain('Comenzar')

  const saved = await v.call('POST', `/${token}/draft`, { templateId: 't_intake', values: { first_name: 'Ana María', meds: 'yes', evil: '<script>', which: 'Sertralina' } })
  expect(saved.status).toBe(200)
  expect((await s.op('GET', `/requests/${request.id}`)).json.request.status).toBe('in_progress')
  const draft = (await s.db.query<{ draft_values: any; status: string }>('SELECT draft_values, status FROM document_signers'))[0]!
  expect(draft.status).toBe('in_progress')
  expect(draft.draft_values.t_intake).toEqual({ first_name: 'Ana María', meds: 'yes', which: 'Sertralina' }) // unknown keys dropped

  // back later: a new visit with a new code lands on the checklist, and the document shows what was saved
  const back = await s.visitor('198.51.100.8')
  await back.call('POST', `/${token}/otp`)
  await back.call('POST', `/${token}/verify`, { code: s.outbox.codeFor(ANA) })
  const list = await back.call('GET', `/${token}`)
  expect(list.text).toContain('◐')
  const doc = await back.call('GET', `/${token}?doc=2`)
  expect(doc.text).toContain('value="Ana María"')
  expect(doc.text).toContain('Sertralina')
  expect(doc.text).not.toContain('&lt;script')
  expect((await v.call('POST', `/${token}/draft`, { templateId: 't_guardian', values: {} })).status).toBe(403)
})

test('a date of birth that contradicts the record holds the packet for review; the therapist can accept it', async () => {
  const s = await documentsSetup()
  const { request, token } = await s.sendAdult()
  const v = await s.verified(token, ANA)
  await v.call('POST', `/${token}/sign/t_consent`, s.signBody({ values: { ini: 'AR' } }))
  await v.call('POST', `/${token}/sign/t_intake`, s.signBody({ signaturePng: null, values: { first_name: 'Ana', dob: '2011-04-12', meds: 'no' } }))
  const req = (await s.op('GET', `/requests/${request.id}`)).json.request
  expect(req).toMatchObject({ status: 'in_progress', needsReview: 'dob_mismatch' })
  expect(s.events.filter((e) => e.triggerType === 'documents_completed')).toHaveLength(0)
  expect((await s.audits()).map((a) => a.action)).toContain('packet.age_mismatch')
  const tasks = await s.db.query<{ title: string }>("SELECT title FROM contact_tasks WHERE contact_id='c1'")
  expect(tasks.map((t) => t.title)).toEqual(['Review: date of birth mismatch for Ana Rivera'])
  // the date of birth on the record was NOT replaced
  expect((await s.db.query<{ d: string }>("SELECT custom_fields->>'date_of_birth' AS d FROM contacts WHERE id='c1'"))[0]!.d).toBe('1990-04-12')

  expect((await s.op('POST', `/requests/${request.id}/accept-review`)).json.request.status).toBe('completed')
  expect((await s.op('POST', `/requests/${request.id}/accept-review`)).status).toBe(409)
  expect((await s.db.query<{ d: string; c: any }>("SELECT custom_fields->>'date_of_birth' AS d, custom_fields->'intake_conflicts' AS c FROM contacts WHERE id='c1'"))[0]).toMatchObject({ d: '1990-04-12', c: { date_of_birth: { record: '1990-04-12', answered: '2011-04-12' } } })
})

test('a minor\'s packet: guardian and minor each see only their own documents, and it completes when both finish', async () => {
  const s = await documentsSetup()
  const sent = await s.op('POST', '/requests', { contactId: 'c2', packetId: 'pk_teen', signers: [{ role: 'guardian', name: 'Rosa Mora', email: 'rosa@example.com' }, { role: 'minor', name: 'Pedro Mora', email: 'pedro@example.com' }] })
  const id = sent.json.request.id
  const g = await s.verified(s.outbox.tokenFor('rosa@example.com'), 'rosa@example.com')
  const m = await s.verified(s.outbox.tokenFor('pedro@example.com'), 'pedro@example.com')
  const gt = s.outbox.tokenFor('rosa@example.com')
  const mt = s.outbox.tokenFor('pedro@example.com')

  expect((await m.call('GET', `/${mt}`)).text).toContain('Estoy de acuerdo') // single document: straight to it
  expect((await m.call('POST', `/${mt}/sign/t_guardian`, s.signBody({ signerName: 'Pedro Mora' }))).status).toBe(403)
  expect((await g.call('POST', `/${gt}/sign/t_assent`, s.signBody({ signerName: 'Rosa Mora' }))).status).toBe(403)

  await g.call('POST', `/${gt}/sign/t_guardian`, s.signBody({ signerName: 'Rosa Mora' }))
  await g.call('POST', `/${gt}/sign/t_privacy`, s.signBody({ signerName: 'Rosa Mora' }))
  expect((await s.op('GET', `/requests/${id}`)).json.request.status).toBe('in_progress') // waiting for the minor
  expect((await g.call('GET', `/${gt}`)).text).toContain('Falta que las demás personas')
  expect(s.events.filter((e) => e.triggerType === 'documents_completed')).toHaveLength(0)
  await m.call('POST', `/${mt}/sign/t_assent`, s.signBody({ signerName: 'Pedro Mora' }))
  expect((await s.op('GET', `/requests/${id}`)).json.request.status).toBe('completed')
  expect(s.events.filter((e) => e.triggerType === 'documents_completed')).toHaveLength(1)
})

test('after the deadline the link is dead and signing is refused', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult()
  const v = await s.verified(token, ANA)
  // the deadline and completion times come from the database's own clock, so move relative to the real now
  s.clock.set(new Date(Date.now() + 15 * 24 * 3600_000))
  expect((await v.call('POST', `/${token}/sign/t_consent`, s.signBody({ values: { ini: 'A' } }))).status).toBe(404)
  expect((await s.db.query<{ status: string }>('SELECT status FROM document_requests'))[0]!.status).toBe('expired')
  expect(await s.db.query('SELECT 1 FROM signed_documents')).toHaveLength(0)
})

test('a copy link keeps working 30 days after completion, then stops', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult({ excludeFamilyIds: ['f_intake'] })
  const v = await s.verified(token, ANA)
  await v.call('POST', `/${token}/sign/t_consent`, s.signBody({ values: { ini: 'A' } }))
  s.clock.set(new Date(Date.now() + 29 * 24 * 3600_000))
  const later = await s.verified(token, ANA)
  expect((await later.call('GET', `/${token}/copy`)).status).toBe(200)
  s.clock.set(new Date(Date.now() + 31 * 24 * 3600_000))
  expect((await s.visitor().call('GET', `/${token}`)).status).toBe(404)
})

test('a practice that turned the documents module off serves only the "invalid link" page', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult()
  await s.db.query(`UPDATE locations SET settings = jsonb_set(settings, '{enabledModules}', '["contacts"]') WHERE id='loc_a'`)
  expect((await s.visitor().call('GET', `/${token}`)).status).toBe(404)
  expect((await s.visitor().call('POST', `/${token}/otp`)).status).toBe(404)
})

test('only the hash of a link is stored, and the page never puts a token in a log-able place beyond the URL', async () => {
  const s = await documentsSetup()
  const { token } = await s.sendAdult()
  const stored = (await s.db.query<{ token_hash: string }>('SELECT token_hash FROM document_signers'))[0]!.token_hash
  expect(stored).toBe(hashToken(token))
  const page = await (await s.verified(token, ANA)).call('GET', `/${token}?doc=1`)
  // the token appears only as part of the page's own URLs and as the endpoint prefix in its script
  expect(page.text.replaceAll(`/d/${token}`, '').replace(`const T="${token}";`, '')).not.toContain(token)
})

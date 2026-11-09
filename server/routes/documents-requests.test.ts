import { documentsSetup } from '../test-utils/documents'

test('sending the adult packet freezes the active versions, stores only token hashes and emails a link with no clinical or personal details', async () => {
  const s = await documentsSetup()
  const { request, token } = await s.sendAdult()
  const row = (await s.db.query<{ template_ids: string[]; audience: string; status: string }>('SELECT template_ids, audience, status FROM document_requests WHERE id=$1', [request.id]))[0]!
  expect(row).toEqual({ template_ids: ['t_consent', 't_intake'], audience: 'adult', status: 'sent' })
  const signer = (await s.db.query<{ token_hash: string }>('SELECT token_hash FROM document_signers'))[0]!
  expect(signer.token_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(await s.db.query('SELECT * FROM document_signers'))).not.toContain(token)

  const mail = s.outbox.messages[0]!
  expect(mail.to).toBe('ana@example.com')
  expect(mail.subject).toBe('Consultorio Rivera: documentos pendientes')
  const all = `${mail.subject}\n${mail.text}`
  for (const forbidden of ['Ana Rivera', 'Consentimiento', 'Admisión', 'psicoterapia', 'terapia']) expect(all).not.toContain(forbidden)
  expect(mail.text).toContain(`https://app.test/d/${token}`)
  expect(mail.text).toContain('14 días')

  const a = (await s.audits()).find((x) => x.action === 'packet.sent')!
  expect(a.details).toMatchObject({ audience: 'adult', signerRoles: ['client'], templates: [{ id: 't_consent', version: 1 }, { id: 't_intake', version: 1 }] })
  expect(JSON.stringify(a.details)).not.toContain('ana@example.com')
  expect((await s.db.query<{ type: string }>("SELECT type FROM timeline_events WHERE contact_id='c1'")).map((t) => t.type)).toContain('documents_sent')
})

test('the packet must fit the client\'s age, and the date of birth must be known', async () => {
  const s = await documentsSetup()
  const signers = [{ role: 'client', name: 'X Y', email: 'x@example.com' }]
  expect((await s.op('POST', '/requests', { contactId: 'c2', packetId: 'pk_adult', signers })).json).toMatchObject({ error: 'packet_audience_mismatch', expected: 'adolescent' })
  expect((await s.op('POST', '/requests', { contactId: 'c1', packetId: 'pk_teen', signers: [{ role: 'guardian', name: 'G', email: 'g@example.com' }] })).json).toMatchObject({ error: 'packet_audience_mismatch', expected: 'adult' })
  expect((await s.op('POST', '/requests', { contactId: 'c3', packetId: 'pk_adult', signers })).json.error).toBe('date_of_birth_required')
  expect(s.outbox.messages).toHaveLength(0)
})

test('who signs: an adult packet needs the client, a minor\'s packet needs the guardian, a document with nobody to sign it is refused', async () => {
  const s = await documentsSetup()
  const g = { role: 'guardian', name: 'Rosa Mora', email: 'rosa@example.com' }
  expect((await s.op('POST', '/requests', { contactId: 'c1', packetId: 'pk_adult', signers: [g] })).json).toMatchObject({ error: 'invalid_signers' })
  expect((await s.op('POST', '/requests', { contactId: 'c2', packetId: 'pk_teen', signers: [{ role: 'minor', name: 'Pedro', email: 'p@example.com' }] })).json).toMatchObject({ error: 'invalid_signers', issues: ['guardian_required'] })

  // guardian only: the minor's assent is left out (and the audit says so); the guardian also covers the client's privacy notice
  const r = await s.op('POST', '/requests', { contactId: 'c2', packetId: 'pk_teen', signers: [g] })
  expect(r.status).toBe(201)
  expect(r.json.warnings).toEqual(['skipped_minor_document:f_assent'])
  const view = (await s.op('GET', `/requests/${r.json.request.id}`)).json.request
  expect(view.documents.map((d: any) => [d.title, d.signerRole])).toEqual([['Tutor', 'guardian'], ['Privacidad', 'guardian']])

  // guardian + minor: each gets their own link and their own documents
  const both = await s.op('POST', '/requests', { contactId: 'c2', packetId: 'pk_teen', signers: [g, { role: 'minor', name: 'Pedro Mora', email: 'pedro@example.com' }] })
  const v2 = (await s.op('GET', `/requests/${both.json.request.id}`)).json.request
  expect(v2.documents.map((d: any) => [d.title, d.signerRole])).toEqual([['Tutor', 'guardian'], ['Asentimiento', 'minor'], ['Privacidad', 'guardian']])
  expect(new Set(both.json.signers.map((x: any) => x.link)).size).toBe(2)
})

test('only versions in force can be sent; a draft or retired one is refused, and excluded documents are not sent', async () => {
  const s = await documentsSetup()
  await s.pg.exec("SET session_replication_role = replica; UPDATE document_templates SET status='retired' WHERE id='t_intake'; SET session_replication_role = DEFAULT;")
  const signers = [{ role: 'client', name: 'Ana Rivera', email: 'ana@example.com' }]
  expect((await s.op('POST', '/requests', { contactId: 'c1', packetId: 'pk_adult', signers })).json).toMatchObject({ error: 'template_not_active', familyIds: ['f_intake'] })
  const ok = await s.op('POST', '/requests', { contactId: 'c1', packetId: 'pk_adult', excludeFamilyIds: ['f_intake'], signers })
  expect(ok.status).toBe(201)
  const v = (await s.op('GET', `/requests/${ok.json.request.id}`)).json.request
  expect(v.documents.map((d: any) => d.title)).toEqual(['Consentimiento'])
  expect((await s.op('POST', '/requests', { contactId: 'c1', packetId: 'pk_adult', excludeFamilyIds: ['f_consent', 'f_intake'], signers })).json.error).toBe('no_documents')
})

test('with no email provider the request is still created and the link is returned to copy', async () => {
  const s = await documentsSetup({ emailConfigured: false })
  const r = await s.op('POST', '/requests', { contactId: 'c1', packetId: 'pk_adult', signers: [{ role: 'client', name: 'Ana Rivera', email: 'ana@example.com' }] })
  expect(r.status).toBe(201)
  expect(r.json.signers[0]).toMatchObject({ emailed: false, emailIssue: 'no email provider connected' })
  expect(r.json.signers[0].link).toMatch(/^https:\/\/app\.test\/d\/[A-Za-z0-9_-]{43}$/)
})

test('unknown or foreign contacts and packets are refused; another practice cannot see the request', async () => {
  const s = await documentsSetup()
  const signers = [{ role: 'client', name: 'A B', email: 'a@example.com' }]
  expect((await s.op('POST', '/requests', { contactId: 'nope', packetId: 'pk_adult', signers })).status).toBe(400)
  expect((await s.op('POST', '/requests', { contactId: 'cx', packetId: 'pk_adult', signers })).status).toBe(400)
  expect((await s.op('POST', '/requests', { contactId: 'c1', packetId: 'nope', signers })).status).toBe(400)
  const { request } = await s.sendAdult()
  const b = s.mountOperator(s.other)
  expect((await s.op('GET', `/requests/${request.id}`, undefined, b)).status).toBe(404)
  expect((await s.op('GET', '/requests', undefined, b)).json.requests).toEqual([])
  expect((await s.op('POST', `/requests/${request.id}/void`, { reason: 'x' }, b)).status).toBe(404)
})

test('re-sending replaces the signer\'s link (the old one stops working) and unlocks them', async () => {
  const s = await documentsSetup()
  const { request, token } = await s.sendAdult()
  const signerId = (await s.db.query<{ id: string }>('SELECT id FROM document_signers'))[0]!.id
  const v = s.visitor()
  await v.call('POST', `/${token}/otp`)
  for (let i = 0; i < 5; i++) await v.call('POST', `/${token}/verify`, { code: '000000' })
  expect((await v.call('POST', `/${token}/otp`)).status).toBe(423) // locked

  const r = await s.op('POST', `/requests/${request.id}/resend`, { signerId })
  expect(r.status).toBe(200)
  const fresh = s.outbox.tokenFor('ana@example.com')
  expect(fresh).not.toBe(token)
  expect((await s.visitor().call('GET', `/${token}`)).status).toBe(404) // old link is dead
  const page = await s.visitor().call('GET', `/${fresh}`)
  expect(page.status).toBe(200)
  expect(page.text).toContain('Enviar código') // unlocked
  expect((await s.audits()).map((a) => a.action)).toContain('packet.resent')
  expect((await s.op('POST', `/requests/${request.id}/resend`, { signerId: 'nope' })).status).toBe(404)
})

test('"copy link" issues a new link without emailing anything: the old one dies, the new one works, the audit says it was copied', async () => {
  const s = await documentsSetup()
  const { request, token } = await s.sendAdult()
  const signerId = (await s.db.query<{ id: string }>('SELECT id FROM document_signers'))[0]!.id
  const sentBefore = s.outbox.messages.length

  const r = await s.op('POST', `/requests/${request.id}/resend`, { signerId, deliver: 'none' })
  expect(r.status).toBe(200)
  expect(r.json.signer).toMatchObject({ id: signerId, role: 'client', emailed: false, emailIssue: null })
  const link: string = r.json.signer.link
  expect(link).toMatch(/^https:\/\/app\.test\/d\/[A-Za-z0-9_-]{43}$/)
  expect(s.outbox.messages).toHaveLength(sentBefore) // nothing was emailed

  const fresh = link.split('/d/')[1]!
  expect(fresh).not.toBe(token)
  expect((await s.visitor().call('GET', `/${token}`)).status).toBe(404) // the old link is dead
  expect((await s.visitor().call('GET', `/${fresh}`)).status).toBe(200) // the copied one opens
  expect(JSON.stringify(await s.db.query('SELECT * FROM document_signers'))).not.toContain(fresh) // still only a hash is stored

  const log = (await s.audits()).filter((a) => a.action === 'packet.resent')
  expect(log.at(-1)!.details).toMatchObject({ signerId, role: 'client', delivery: 'copy' })
  expect(JSON.stringify(log)).not.toContain(fresh)

  // the default is unchanged: a body without `deliver` still emails
  await s.op('POST', `/requests/${request.id}/resend`, { signerId })
  expect(s.outbox.messages).toHaveLength(sentBefore + 1)
  expect((await s.audits()).filter((a) => a.action === 'packet.resent').at(-1)!.details).toMatchObject({ delivery: 'email' })
  expect((await s.op('POST', `/requests/${request.id}/resend`, { signerId, deliver: 'sms' })).status).toBe(400)
})

test('voiding closes the link; the reason stays on the request, not in the audit log', async () => {
  const s = await documentsSetup()
  const { request, token } = await s.sendAdult()
  const r = await s.op('POST', `/requests/${request.id}/void`, { reason: 'SECRETO enviado al correo equivocado' })
  expect(r.json.request.status).toBe('voided')
  expect((await s.visitor().call('GET', `/${token}`)).status).toBe(404)
  expect((await s.op('POST', `/requests/${request.id}/void`, { reason: 'otra vez' })).status).toBe(409)
  expect(JSON.stringify(await s.audits())).not.toContain('SECRETO')
  expect((await s.audits()).map((a) => a.action)).toContain('packet.voided')
})

test('a request past its deadline becomes expired, with a follow-up task, the first time anyone looks', async () => {
  const s = await documentsSetup()
  const { request } = await s.sendAdult()
  await s.pg.exec("SET session_replication_role = replica; UPDATE document_requests SET expires_at = now() - interval '1 hour'; SET session_replication_role = DEFAULT;")
  const list = (await s.op('GET', '/requests?contactId=c1')).json.requests
  expect(list[0]).toMatchObject({ id: request.id, status: 'expired' })
  const tasks = await s.db.query<{ title: string }>("SELECT title FROM contact_tasks WHERE contact_id='c1'")
  expect(tasks.map((t) => t.title)).toEqual(['Follow up: onboarding documents expired for Ana Rivera'])
  await s.op('GET', '/requests') // second look: no duplicate task
  expect(await s.db.query("SELECT 1 FROM contact_tasks WHERE contact_id='c1'")).toHaveLength(1)
  expect((await s.audits()).map((a) => a.action)).toContain('packet.expired')
})

test('the starter packets from the seed can be sent once their documents are active', async () => {
  const s = await documentsSetup({ seed: true })
  await s.pg.query("UPDATE document_templates SET status='active' WHERE family_id LIKE 'seed_%'")
  const r = await s.op('POST', '/requests', { contactId: 'c1', packetId: 'seed_packet_adult_loc_a', signers: [{ role: 'client', name: 'Ana Rivera', email: 'ana@example.com' }] })
  expect(r.status, JSON.stringify(r.json)).toBe(201)
  const teen = await s.op('POST', '/requests', { contactId: 'c2', packetId: 'seed_packet_adolescent_loc_a', signers: [{ role: 'guardian', name: 'Rosa Mora', email: 'rosa@example.com' }, { role: 'minor', name: 'Pedro Mora', email: 'pedro@example.com' }] })
  expect(teen.status, JSON.stringify(teen.json)).toBe(201)
  const v = (await s.op('GET', `/requests/${teen.json.request.id}`)).json.request
  expect(v.documents.every((d: any) => d.signerRole)).toBe(true)
  expect(v.documents.filter((d: any) => d.signerRole === 'minor').map((d: any) => d.title)).toEqual(['Asentimiento del menor'])
})

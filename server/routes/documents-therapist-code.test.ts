import { documentsSetup } from '../test-utils/documents'

type S = Awaited<ReturnType<typeof documentsSetup>>
const signerOf = async (s: S) => (await s.db.query<{ id: string }>('SELECT id FROM document_signers'))[0]!.id
const enable = (s: S, on = true) => s.op('PUT', '/verification', { therapistCode: on })
const issue = (s: S, requestId: string, signerId: string, app?: Parameters<S['op']>[3]) => s.op('POST', `/requests/${requestId}/signers/${signerId}/code`, undefined, app)

test('codes given by the therapist are OFF by default: nothing can be issued until the practice turns them on', async () => {
  const s = await documentsSetup()
  const { request } = await s.sendAdult()
  expect((await s.op('GET', '/verification')).json).toEqual({ therapistCode: false })
  const r = await issue(s, request.id, await signerOf(s))
  expect(r.status).toBe(403)
  expect(r.json).toEqual({ error: 'not_enabled' })
  expect((await s.audits()).map((a) => a.action)).not.toContain('packet.code_issued')
})

test('turning it on and off is a deliberate, audited act that needs a real boolean', async () => {
  const s = await documentsSetup()
  expect((await s.op('PUT', '/verification', { therapistCode: 'yes' })).status).toBe(400)
  expect((await s.op('PUT', '/verification', {})).status).toBe(400)
  expect((await enable(s)).json).toEqual({ ok: true, therapistCode: true })
  expect((await s.op('GET', '/verification')).json).toEqual({ therapistCode: true })
  await enable(s, false)
  expect((await s.op('GET', '/verification')).json).toEqual({ therapistCode: false })
  const log = (await s.audits()).filter((a) => a.action === 'document.verification_changed')
  expect(log.map((a) => a.details)).toEqual([{ therapistCode: true }, { therapistCode: false }])
})

test('an issued code is six digits, shown once, valid for 30 minutes, stored only as a hash and never in the audit log', async () => {
  const s = await documentsSetup()
  await enable(s)
  const { request } = await s.sendAdult()
  const signerId = await signerOf(s)
  const before = Date.now()
  const r = await issue(s, request.id, signerId)
  expect(r.status).toBe(200)
  const code: string = r.json.code
  expect(code).toMatch(/^\d{6}$/)
  expect(r.json.signer).toEqual({ id: signerId, role: 'client' })
  const ttl = new Date(r.json.expiresAt).getTime() - before
  expect(ttl).toBeGreaterThan(29 * 60_000)
  expect(ttl).toBeLessThan(31 * 60_000)

  const row = (await s.db.query<{ otp_hash: string; otp_via: string }>('SELECT otp_hash, otp_via FROM document_signers'))[0]!
  expect(row.otp_via).toBe('therapist_code')
  expect(row.otp_hash).not.toContain(code)
  expect(JSON.stringify(await s.db.query('SELECT * FROM document_signers'))).not.toContain(`"${code}"`)
  const issued = (await s.audits()).filter((a) => a.action === 'packet.code_issued')
  expect(issued).toHaveLength(1)
  expect(issued[0]!.details).toEqual({ signerId, role: 'client' })
  expect(JSON.stringify(await s.audits())).not.toContain(code)
  expect(s.outbox.messages.filter((m) => /código/.test(m.text))).toHaveLength(0) // nothing was emailed
})

test('the client\'s page opens the code box when the therapist gave a code, and asks for the emailed one otherwise', async () => {
  const s = await documentsSetup()
  await enable(s)
  const { request, token } = await s.sendAdult()
  const plain = (await s.visitor().call('GET', `/${token}`)).text
  expect(plain).toContain('enviaremos un código')
  expect(plain).toMatch(/id="codebox" hidden/)

  await issue(s, request.id, await signerOf(s))
  const withCode = (await s.visitor().call('GET', `/${token}`)).text
  expect(withCode).toContain('Su terapeuta le dio un código')
  expect(withCode).not.toMatch(/id="codebox" hidden/)
  expect(withCode).toContain('Prefiero recibirlo por correo')
})

test('the code opens the documents, and every document signed this way says so; the emailed code still says email', async () => {
  const s = await documentsSetup()
  await enable(s)
  const { request, token } = await s.sendAdult()
  const r = await issue(s, request.id, await signerOf(s))
  const v = s.visitor()
  expect((await v.call('POST', `/${token}/verify`, { code: r.json.code })).status).toBe(200)
  expect((await v.call('POST', `/${token}/sign/t_consent`, s.signBody({ values: { ini: 'AR' } }))).status).toBe(200)
  const row = (await s.db.query<{ verified_via: string }>('SELECT verified_via FROM signed_documents'))[0]!
  expect(row.verified_via).toBe('therapist_code')
  const signed = (await s.audits()).find((a) => a.action === 'document.signed')!
  expect(signed.details).toMatchObject({ verifiedVia: 'therapist_code' })

  // the same practice, a different person verified by the emailed code
  const s2 = await documentsSetup()
  await enable(s2)
  const sent = await s2.sendAdult()
  const w = s2.visitor()
  await w.call('POST', `/${sent.token}/otp`)
  expect((await w.call('POST', `/${sent.token}/verify`, { code: s2.outbox.codeFor('ana@example.com') })).status).toBe(200)
  await w.call('POST', `/${sent.token}/sign/t_consent`, s2.signBody({ values: { ini: 'AR' } }))
  expect((await s2.db.query<{ verified_via: string }>('SELECT verified_via FROM signed_documents'))[0]!.verified_via).toBe('email_otp')
})

test('a wrong code counts like any other: five lock the link, and a new code from the therapist reopens it', async () => {
  const s = await documentsSetup()
  await enable(s)
  const { request, token } = await s.sendAdult()
  const signerId = await signerOf(s)
  const first = await issue(s, request.id, signerId)
  const v = s.visitor()
  const wrong = first.json.code === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) await v.call('POST', `/${token}/verify`, { code: wrong })
  expect((await v.call('POST', `/${token}/verify`, { code: first.json.code })).status).toBe(423) // locked, even with the right code

  const second = await issue(s, request.id, signerId)
  expect(second.status).toBe(200)
  expect((await s.visitor().call('POST', `/${token}/verify`, { code: second.json.code })).status).toBe(200)
})

test('a code expires after its 30 minutes', async () => {
  const s = await documentsSetup()
  await enable(s)
  const { request, token } = await s.sendAdult()
  const r = await issue(s, request.id, await signerOf(s))
  s.clock.set(new Date(Date.now() + 31 * 60_000)) // the public page's clock, 31 minutes later
  const res = await s.visitor().call('POST', `/${token}/verify`, { code: r.json.code })
  expect(res.status).toBe(401)
  expect(res.json.error).toBe('code_invalid')
})

test('a new code replaces the previous one, and a new link clears the verification', async () => {
  const s = await documentsSetup()
  await enable(s)
  const { request, token } = await s.sendAdult()
  const signerId = await signerOf(s)
  const a = await issue(s, request.id, signerId)
  const b = await issue(s, request.id, signerId)
  expect((await s.visitor().call('POST', `/${token}/verify`, { code: a.json.code })).status).toBe(401) // the first no longer works
  expect((await s.visitor().call('POST', `/${token}/verify`, { code: b.json.code })).status).toBe(200)

  await s.op('POST', `/requests/${request.id}/resend`, { signerId, deliver: 'none' })
  const row = (await s.db.query<{ verified_via: string | null; otp_via: string | null; verified_at: unknown }>('SELECT verified_via, otp_via, verified_at FROM document_signers'))[0]!
  expect(row).toEqual({ verified_via: null, otp_via: null, verified_at: null })
})

test('without email, asking the page to email a code fails but keeps the therapist\'s code alive', async () => {
  const s = await documentsSetup({ emailConfigured: false })
  await enable(s)
  const { request } = await (async () => {
    const r = await s.op('POST', '/requests', { contactId: 'c1', packetId: 'pk_adult', signers: [{ role: 'client', name: 'Ana Rivera', email: 'ana@example.com' }] })
    expect(r.status).toBe(201)
    return { request: r.json.request as { id: string }, signerId: r.json.signers[0].id as string }
  })()
  const signerId = await signerOf(s)
  const link = (await s.op('POST', `/requests/${request.id}/resend`, { signerId, deliver: 'none' })).json.signer.link as string
  const token = link.split('/d/')[1]!
  const code = (await issue(s, request.id, signerId)).json.code as string

  const v = s.visitor()
  expect((await v.call('POST', `/${token}/otp`)).status).toBe(503) // no email provider
  expect((await v.call('POST', `/${token}/verify`, { code })).status).toBe(200) // the therapist's code survived
})

test('only open requests, uncompleted signers and this practice\'s own requests can get a code', async () => {
  const s = await documentsSetup()
  await enable(s)
  const { request } = await s.sendAdult()
  const signerId = await signerOf(s)
  expect((await issue(s, request.id, 'nope')).status).toBe(404)
  expect((await issue(s, 'nope', signerId)).status).toBe(404)
  expect((await issue(s, request.id, signerId, s.mountOperator('loc_b'))).status).toBe(403) // the setting is per practice: off in the other one
  await s.db.query(`UPDATE locations SET settings = '{"documentVerification":{"therapistCode":true}}'::jsonb WHERE id = 'loc_b'`)
  expect((await issue(s, request.id, signerId, s.mountOperator('loc_b'))).status).toBe(404) // on there, but the request is not theirs
  await s.op('POST', `/requests/${request.id}/void`, { reason: 'x' })
  expect((await issue(s, request.id, signerId)).status).toBe(409)
})

test('asking for codes in a loop is throttled', async () => {
  const s = await documentsSetup()
  await enable(s)
  const { request } = await s.sendAdult()
  const signerId = await signerOf(s)
  for (let i = 0; i < 10; i++) expect((await issue(s, request.id, signerId)).status).toBe(200)
  expect((await issue(s, request.id, signerId)).status).toBe(429)
})

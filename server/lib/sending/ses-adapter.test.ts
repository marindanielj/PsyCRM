import type { SendEmailCommandInput } from '@aws-sdk/client-sesv2'
import { createSesAdapter, displayName, isSafeAddress, mailbox } from './ses-adapter'

const make = (over: Partial<Parameters<typeof createSesAdapter>[0]> = {}) => {
  const calls: SendEmailCommandInput[] = []
  const sender = createSesAdapter({ fromEmail: 'no-reply@consultorio.example', fromName: 'Consultorio Rivera', region: 'us-east-1', send: async (i) => (calls.push(i), { MessageId: 'ses-123' }), ...over })
  return { sender, calls }
}

test('sends a plain-text message through SES v2 and returns the message id', async () => {
  const { sender, calls } = make()
  const r = await sender.sendEmail({ to: 'ana@example.com', toName: 'Ana Rivera', subject: 'Documentos pendientes', text: 'Hola Ana:\n\nSu enlace: https://app.example/d/x' })
  expect(r).toEqual({ externalId: 'ses-123', provider: 'ses' })
  expect(sender.name).toBe('ses')
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual({
    FromEmailAddress: '"Consultorio Rivera" <no-reply@consultorio.example>',
    Destination: { ToAddresses: ['"Ana Rivera" <ana@example.com>'] },
    Content: { Simple: { Subject: { Data: 'Documentos pendientes', Charset: 'UTF-8' }, Body: { Text: { Data: 'Hola Ana:\n\nSu enlace: https://app.example/d/x', Charset: 'UTF-8' } } } },
  })
})

test('a configuration set (bounce and complaint tracking) is added only when there is one', async () => {
  const withSet = make({ configurationSet: 'psycrm-events' })
  await withSet.sender.sendEmail({ to: 'a@example.com', subject: 's', text: 't' })
  expect(withSet.calls[0]!.ConfigurationSetName).toBe('psycrm-events')
  const without = make()
  await without.sender.sendEmail({ to: 'a@example.com', subject: 's', text: 't' })
  expect('ConfigurationSetName' in without.calls[0]!).toBe(false)
})

test('a name with accents is sent as an RFC 2047 encoded word, and a plain address needs no name', async () => {
  expect(displayName('Dra. Díaz')).toBe(`=?UTF-8?B?${Buffer.from('Dra. Díaz').toString('base64')}?=`)
  expect(displayName('Consultorio Rivera')).toBe('"Consultorio Rivera"')
  expect(displayName('   ')).toBe('')
  expect(mailbox('a@example.com')).toBe('a@example.com')
  const { sender, calls } = make({ fromName: undefined })
  await sender.sendEmail({ to: 'a@example.com', subject: 's', text: 't' })
  expect(calls[0]!.FromEmailAddress).toBe('no-reply@consultorio.example')
})

test('a name cannot break out of its header: quotes, angle brackets and line breaks are removed', () => {
  expect(displayName('Evil" <attacker@evil.example>\r\nBcc: x@evil.example')).not.toMatch(/[<>\r\n"].*[<>\r\n]/s)
  const out = displayName('Evil" <attacker@evil.example>\r\nBcc: x@evil.example')
  expect(out).not.toContain('\n')
  expect(out).not.toContain('<')
  expect(out.startsWith('"') && out.endsWith('"')).toBe(true)
  expect(out.slice(1, -1)).not.toContain('"')
})

test('an address that could add recipients or headers is refused before anything is sent', async () => {
  const { sender, calls } = make()
  for (const bad of ['a@example.com, b@evil.example', 'a@example.com\r\nBcc: b@evil.example', 'Name <a@example.com>', 'no-at-sign', 'a b@example.com', '', 'a@example.com;b@evil.example']) {
    await expect(sender.sendEmail({ to: bad, subject: 's', text: 't' }), JSON.stringify(bad)).rejects.toThrow(/recipient address is not valid/)
  }
  expect(calls).toHaveLength(0)
  expect(isSafeAddress('ana.rivera+tag@sub.example.com')).toBe(true)
  expect(() => createSesAdapter({ fromEmail: 'not an address', region: 'us-east-1' })).toThrow(/sender address/)
})

test('a line break in the subject is flattened: the subject cannot add a header', async () => {
  const { sender, calls } = make()
  await sender.sendEmail({ to: 'a@example.com', subject: 'Hola\r\nBcc: x@evil.example', text: 't' })
  expect(calls[0]!.Content!.Simple!.Subject!.Data).toBe('Hola Bcc: x@evil.example')
})

test('a failure keeps only the error kind: the SDK message (which can echo the recipient) never leaves the adapter', async () => {
  const { sender } = make({ send: async () => { throw Object.assign(new Error('Email address is not verified: ana@example.com in us-east-1'), { name: 'MessageRejected' }) } })
  const err = (await sender.sendEmail({ to: 'ana@example.com', subject: 's', text: 't' }).catch((e) => e)) as Error
  expect(err.message).toBe('ses send failed: MessageRejected')
  expect(err.message).not.toContain('ana@')
  const noId = make({ send: async () => ({}) })
  await expect(noId.sender.sendEmail({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toThrow(/ses send failed/)
})

// ---- the real SDK, against a local stand-in for SES: proves the request that would reach AWS ----------------

test('the real client signs and sends the exact SES v2 request (checked against a local server, no AWS)', async () => {
  const { createServer } = await import('node:http')
  const seen: { method?: string; url?: string; auth?: string; body?: any } = {}
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      Object.assign(seen, { method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ MessageId: 'local-msg-1' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY }
  process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST'
  process.env.AWS_SECRET_ACCESS_KEY = 'secretsecretsecretsecretsecretsecretsecret'
  try {
    const sender = createSesAdapter({ fromEmail: 'no-reply@consultorio.example', fromName: 'Consultorio Díaz', region: 'us-east-1', endpoint: `http://127.0.0.1:${port}`, configurationSet: 'psycrm-events' })
    const r = await sender.sendEmail({ to: 'ana@example.com', toName: 'Ana', subject: 'Código de verificación', text: 'Su código es 123456' })
    expect(r).toEqual({ externalId: 'local-msg-1', provider: 'ses' })
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/v2/email/outbound-emails')
    expect(seen.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTESTTEST\/\d{8}\/us-east-1\/ses\/aws4_request/) // signed for SES in the right region
    expect(seen.body).toMatchObject({
      FromEmailAddress: `=?UTF-8?B?${Buffer.from('Consultorio Díaz').toString('base64')}?= <no-reply@consultorio.example>`,
      Destination: { ToAddresses: ['"Ana" <ana@example.com>'] },
      ConfigurationSetName: 'psycrm-events',
      Content: { Simple: { Subject: { Data: 'Código de verificación', Charset: 'UTF-8' }, Body: { Text: { Data: 'Su código es 123456', Charset: 'UTF-8' } } } },
    })
  } finally {
    server.close()
    if (saved.id === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = saved.id
    if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = saved.secret
  }
})

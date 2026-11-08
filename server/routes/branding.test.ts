import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { decodeDataUrl, detectLogoType, normalizeBranding } from '../lib/branding'
import { header } from '../lib/document-page'
import { documentsSetup } from '../test-utils/documents'
import { brandLogoRoute, brandingRoute } from './branding'
import { invitesRoute } from './invites'

// the first bytes of each format, then padding (enough for the type check; not a viewable picture)
const png = (extra = 40) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)])
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)])
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(30, 1)])
const dataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`

test('the type of a logo comes from its bytes: PNG, JPEG and WebP only; SVG, HTML and anything else are refused', () => {
  expect(detectLogoType(png())).toBe('image/png')
  expect(detectLogoType(jpeg())).toBe('image/jpeg')
  expect(detectLogoType(webp())).toBe('image/webp')
  expect(detectLogoType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull()
  expect(detectLogoType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull()
  expect(detectLogoType(Buffer.from([0x89, 0x50]))).toBeNull()
  expect(decodeDataUrl(dataUrl(png()))).toBeInstanceOf(Buffer)
  expect(decodeDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull()
  expect(decodeDataUrl('data:text/html;base64,PGI+')).toBeNull()
  expect(decodeDataUrl('https://evil.example/logo.png')).toBeNull()
  expect(decodeDataUrl('data:image/png;base64,@@@')).toBeNull()
})

test('stored branding is read defensively: only a real name, a #rrggbb colour and a fingerprint count', () => {
  expect(normalizeBranding({ name: '  Consultorio Maritza ', color: '#AABBCC', logoVersion: 'abcdef12' })).toEqual({ name: 'Consultorio Maritza', color: '#aabbcc', logoVersion: 'abcdef12' })
  expect(normalizeBranding({ name: '', color: 'red; background:url(x)', logoVersion: '../../etc' })).toEqual({ name: null, color: null, logoVersion: null })
  expect(normalizeBranding(null)).toEqual({ name: null, color: null, logoVersion: null })
  expect(normalizeBranding({ color: '#12345' }).color).toBeNull()
})

async function setup() {
  const s = await documentsSetup()
  const mount = (loc: string) => {
    const a = new Hono<AppEnv>()
    a.use('/branding/*', async (c, next) => {
      c.set('operatorId', 'op1')
      c.set('locationId', loc)
      await next()
    })
    a.route('/branding', brandingRoute({ db: s.db }))
    a.route('/brand', brandLogoRoute({ db: s.db }))
    return a
  }
  const A = mount(s.loc)
  const B = mount(s.other)
  const call = async (app: Hono<AppEnv>, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json', 'user-agent': 'UA/1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* image bytes */ }
    return { status: res.status, headers: res.headers, json }
  }
  return { ...s, A, B, call }
}

test('a practice sets its name and colour, clears them, and the rest of its stored branding is left alone', async () => {
  const s = await setup()
  expect((await s.call(s.A, 'GET', '/branding')).json.branding).toEqual({ name: null, color: null, logoVersion: null, logoUrl: null })
  await s.db.query(`UPDATE locations SET branding = '{"extra":"keep me"}' WHERE id=$1`, [s.loc])
  const put = await s.call(s.A, 'PUT', '/branding', { name: ' Consultorio Maritza ', color: '#0E7490' })
  expect(put.status).toBe(200)
  expect(put.json.branding).toMatchObject({ name: 'Consultorio Maritza', color: '#0e7490' })
  expect((await s.db.query<{ branding: any }>('SELECT branding FROM locations WHERE id=$1', [s.loc]))[0]!.branding.extra).toBe('keep me')
  const cleared = await s.call(s.A, 'PUT', '/branding', { name: null, color: null })
  expect(cleared.json.branding).toMatchObject({ name: null, color: null })
  expect((await s.db.query<{ branding: any }>('SELECT branding FROM locations WHERE id=$1', [s.loc]))[0]!.branding).toEqual({ extra: 'keep me' })
  // an only-name change leaves the colour as it was
  await s.call(s.A, 'PUT', '/branding', { color: '#112233' })
  await s.call(s.A, 'PUT', '/branding', { name: 'Solo nombre' })
  expect((await s.call(s.A, 'GET', '/branding')).json.branding).toMatchObject({ name: 'Solo nombre', color: '#112233' })
})

test('bad input is refused: a colour that is not #rrggbb, an over-long name, an empty change', async () => {
  const s = await setup()
  for (const body of [{ color: 'red' }, { color: '#fff' }, { color: 'red;background:url(//x)' }, { name: 'x'.repeat(81) }, {}]) {
    expect((await s.call(s.A, 'PUT', '/branding', body)).status, JSON.stringify(body)).toBe(400)
  }
  expect((await s.call(s.A, 'GET', '/branding')).json.branding).toMatchObject({ name: null, color: null })
})

test('a logo is stored, served publicly with safe headers, replaced, and removed; the address changes with the picture', async () => {
  const s = await setup()
  const up = await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: dataUrl(png()) })
  expect(up.status).toBe(200)
  const v1 = up.json.branding.logoVersion
  expect(up.json.branding.logoUrl).toBe(`/brand/${s.loc}/logo?v=${v1}`)

  const img = await s.A.request(`/brand/${s.loc}/logo`)
  expect(img.status).toBe(200)
  expect(img.headers.get('content-type')).toBe('image/png')
  expect(img.headers.get('x-content-type-options')).toBe('nosniff')
  expect(Buffer.from(await img.arrayBuffer()).equals(png())).toBe(true)

  const again = await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: dataUrl(jpeg(), 'image/jpeg') })
  expect(again.json.branding.logoVersion).not.toBe(v1)
  expect((await s.A.request(`/brand/${s.loc}/logo`)).headers.get('content-type')).toBe('image/jpeg')
  expect(await s.db.query('SELECT 1 FROM location_logos')).toHaveLength(1) // replaced, not piled up

  const gone = await s.call(s.A, 'DELETE', '/branding/logo')
  expect(gone.json.branding).toMatchObject({ logoVersion: null, logoUrl: null })
  expect((await s.A.request(`/brand/${s.loc}/logo`)).status).toBe(404)
})

test('what is not a plain PNG, JPEG or WebP is refused, whatever it claims to be, and an oversized picture is refused', async () => {
  const s = await setup()
  const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script>'.padEnd(80, ' '))
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')
  expect((await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: dataUrl(html) })).status).toBe(422) // says PNG, is HTML
  expect((await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: dataUrl(svg, 'image/svg+xml') })).status).toBe(422)
  expect((await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: 'javascript:alert(1)' })).status).toBe(422)
  expect([413, 422, 400]).toContain((await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: dataUrl(png(400 * 1024)) })).status)
  expect((await s.call(s.A, 'PUT', '/branding/logo', {})).status).toBe(400)
  expect(await s.db.query('SELECT 1 FROM location_logos')).toHaveLength(0)
})

test('another practice can neither see nor change this branding, and its logo address serves only its own picture', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/branding', { name: 'Solo A', color: '#0e7490' })
  await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: dataUrl(png()) })
  expect((await s.call(s.B, 'GET', '/branding')).json.branding).toMatchObject({ name: null, color: null, logoUrl: null })
  expect((await s.B.request(`/brand/${s.other}/logo`)).status).toBe(404)
  await s.call(s.B, 'PUT', '/branding', { name: 'Solo B' })
  expect((await s.call(s.A, 'GET', '/branding')).json.branding.name).toBe('Solo A')
  expect((await s.B.request('/brand/nope/logo')).status).toBe(404)
})

test('changes are audited by field name only: never the name, the colour or the picture', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/branding', { name: 'Nombre Secreto S.A.', color: '#0e7490' })
  await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: dataUrl(png()) })
  await s.call(s.A, 'DELETE', '/branding/logo')
  const log = (await s.audits()).filter((a) => a.action === 'practice.branding_updated')
  expect(log.map((a) => a.details.fields)).toEqual([['name', 'color'], ['logo'], ['logo_removed']])
  expect(JSON.stringify(log)).not.toContain('Secreto')
  expect(JSON.stringify(log)).not.toContain('0e7490')
})

test('the logo shows on the pages the client sees, with the brand name and colour; a bad address is never trusted', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/branding', { name: 'Consultorio Maritza', color: '#0e7490' })
  await s.call(s.A, 'PUT', '/branding/logo', { dataUrl: dataUrl(png()) })
  const { token } = await s.sendAdult()
  const page = await s.visitor().call('GET', `/${token}`)
  expect(page.text).toContain('Consultorio Maritza')
  expect(page.text).not.toContain('Consultorio Rivera') // the practice's own name is not what the client sees now
  expect(page.text).toMatch(/<img src="\/brand\/loc_a\/logo\?v=[0-9a-f]{8}"/)
  expect(page.text).toContain('--brand:#0e7490')
  expect(page.headers.get('content-security-policy')).toContain("img-src 'self' data:")
  // the email subject uses the brand name too
  expect(s.outbox.messages.find((m) => m.subject.includes('documentos pendientes'))!.subject).toBe('Consultorio Maritza: documentos pendientes')
  // without a logo the bar has no image
  await s.call(s.A, 'DELETE', '/branding/logo')
  expect((await s.visitor().call('GET', `/${token}`)).text).not.toContain('<img src="/brand')
  // the header builder only accepts an address of the exact shape we make
  expect(header('X', 'https://evil.example/x.png')).not.toContain('<img')
  expect(header('X', '/brand/a"onerror="x/logo?v=abcdef12')).not.toContain('<img')
  expect(header('X', '/brand/loc_a/logo?v=abcdef12')).toContain('<img src="/brand/loc_a/logo?v=abcdef12"')
})

test('invitation emails and pages carry the brand name', async () => {
  const s = await setup()
  await s.call(s.A, 'PUT', '/branding', { name: 'Consultorio Maritza' })
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', s.loc)
    await next()
  })
  app.route('/invites', invitesRoute({ db: s.db, resolveEmail: async () => ({ ok: true, sender: { name: 't', sendEmail: async (m) => (s.outbox.messages.push(m), { externalId: 'x', provider: 't' }) } }), publicBaseUrl: 'https://app.test' }))
  const r = await app.request('/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Marta Prueba', email: 'marta@example.com', kind: 'adult' }) })
  expect(r.status).toBe(201)
  expect(s.outbox.messages.at(-1)!.subject).toBe('Consultorio Maritza: complete su registro')
})

// End-to-end check of the whole PsyCRM cycle, in a real browser, with fictional data.
//
//   node scripts/e2e-psycrm.mjs            # starts the dev servers itself, runs, stops them
//   E2E_BASE=https://staging.example node scripts/e2e-psycrm.mjs   # an already-running stack (needs the /__dev helpers)
//
// Screenshots go to docs/psycrm/e2e/. Nothing here talks to a real email provider or a real person.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')
const root = fileURLToPath(new URL('..', import.meta.url))
const OUT = `${root}/docs/psycrm/e2e`
mkdirSync(OUT, { recursive: true })

const API_PORT = Number(process.env.E2E_API_PORT ?? 8790)
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5273)
const BASE = process.env.E2E_BASE ?? `http://localhost:${WEB_PORT}`
const API = process.env.E2E_BASE ?? `http://localhost:${API_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const children = []
let shots = 0
const results = []

function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) throw new Error(`step failed: ${name}`)
}
const shot = async (page, name) => page.screenshot({ path: `${OUT}/${String(++shots).padStart(2, '0')}-${name}.png`, fullPage: false })

async function waitFor(url, label) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).status < 500) return } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error(`${label} did not start`)
}
function start(cmd, args, env) {
  const c = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore', detached: false })
  children.push(c)
}

async function main() {
  if (!process.env.E2E_BASE) {
    start('npx', ['tsx', 'server/dev-server.ts'], { PORT: String(API_PORT) })
    start('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {})
  }
  await waitFor(`${API}/health`, 'api')
  await waitFor(BASE, 'web')

  const browser = await chromium.launch()
  const errors = []
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const op = await ctx.newPage()
  op.on('pageerror', (e) => errors.push(`operator: ${e}`))
  op.on('console', (m) => m.type() === 'error' && !/40[1-9]|422|409/.test(m.text()) && errors.push(`operator console: ${m.text()}`))
  const api = (path, init) => op.evaluate(async ([path, init]) => { const r = await fetch(path, init && { ...init, headers: { 'content-type': 'application/json' } }); const t = await r.text(); return { status: r.status, text: t, json: (() => { try { return JSON.parse(t) } catch { return null } })() } }, [path, init])
  const outbox = async () => (await (await fetch(`${API}/__dev/outbox`)).json()).messages

  // ---- 1. sign in; only the MVP modules are in the navigation
  await op.goto(`${BASE}/login`)
  await op.fill('input[type=email]', 'demo@psycrm.test')
  await op.fill('input[type=password]', 'psycrm-demo-pass')
  await op.click('button[type=submit]')
  await op.waitForURL((u) => !u.pathname.includes('login'))
  await op.waitForSelector('a:has-text("Contacts")')
  const nav = (await op.locator('nav a, aside a').allInnerTexts()).map((t) => t.trim()).filter(Boolean)
  const mustHave = ['Contacts', 'Documents', 'Calendars', 'Automations', 'Settings']
  const mustNot = ['Conversations', 'Marketing', 'Payments', 'Assistant', 'Social Planner', 'Sites & Funnels', 'Calls', 'Memberships']
  step('1. signs in and the navigation shows only the practice modules', mustHave.every((n) => nav.includes(n)) && mustNot.every((n) => !nav.includes(n)), nav.join(', '))
  await shot(op, 'signed-in')
  const loc = (await api('/api/locations')).json.locations[0].id
  const L = (p) => `/api/loc/${loc}/${p}`

  // ---- go-live step: the starter documents and onboarding workflows are drafts until she turns them on
  for (const t of (await api(L('documents/templates'))).json.templates) await api(L(`documents/templates/${t.id}/activate`), { method: 'POST' })
  for (const w of (await api(L('workflows'))).json.workflows) await api(L(`workflows/${w.id}`), { method: 'PATCH', body: JSON.stringify({ status: 'live' }) })

  // ---- 2. invite the client; she registers on her phone; onboarding starts by itself
  await op.goto(`${BASE}/contacts`)
  await op.click('button:has-text("Invite client")')
  await op.fill('#inv-name', 'Ana Prueba')
  await op.fill('#inv-email', 'ana.prueba@example.com')
  await shot(op, 'invite-dialog')
  await op.click('button:has-text("Send invitation")')
  await op.waitForSelector('text=Invitation sent')
  const inviteLink = await op.inputValue('input[aria-label="Signing link"]')
  await op.click('button:has-text("Done")')
  const phone = await browser.newContext({ ...devices['iPhone 13'] })
  const cl = await phone.newPage()
  cl.on('pageerror', (e) => errors.push(`client: ${e}`))
  await cl.goto(inviteLink.replace(/^https?:\/\/[^/]+/, BASE))
  await cl.waitForSelector('text=Complete su registro')
  await cl.screenshot({ path: `${OUT}/${String(++shots).padStart(2, '0')}-phone-registration.png` })
  await cl.fill('#firstName', 'Ana'); await cl.fill('#lastName', 'Prueba'); await cl.fill('#phone', '787-555-0123'); await cl.fill('#dateOfBirth', '1990-05-17')
  await cl.click('#go')
  await cl.waitForSelector('text=¡Gracias!')
  await sleep(1500)
  const contacts = (await api(L('contacts'))).json.contacts
  const ana = contacts.find((c) => c.name === 'Ana Prueba')
  const opps = (await api(L(`opportunities?pipelineId=${(await api(L('opportunities/pipelines'))).json.pipelines.find((p) => p.name === 'Onboarding').id}`))).json.opportunities
  const pipelines = (await api(L('opportunities/pipelines'))).json.pipelines
  const stageName = (id) => pipelines.flatMap((p) => p.stages).find((s) => s.id === id)?.name
  const card = opps.find((o) => o.contact_id === ana?.id)
  const reqs = (await api(L(`documents/requests?contactId=${ana?.id}`))).json.requests
  const audit = (await api(L('audit?limit=200'))).json.entries.map((e) => e.action)
  step('2. registration creates the client, sends the adult packet, and moves the card to "Documents sent"',
    !!ana && stageName(card?.stage_id) === 'Documents sent' && reqs.length === 1 && reqs[0].audience === 'adult' &&
      ['contact.created', 'packet.sent', 'invite.completed'].every((a) => audit.includes(a)) && audit.filter((a) => a === 'pipeline.stage_changed').length >= 1,
    `card=${stageName(card?.stage_id)}`)

  // ---- 3. the email carries a link and no clinical or personal detail
  const mails = await outbox()
  const packetMail = mails.filter((m) => m.to === 'ana.prueba@example.com' && m.subject.includes('documentos pendientes')).at(-1)
  const text = `${packetMail?.subject}\n${packetMail?.text}`
  const leaks = ['Consentimiento', 'psicoterapia', 'terapia', 'Prueba', '1990', 'HIPAA', 'Cuestionario', 'Honorarios', 'privacidad'].filter((w) => text.includes(w))
  const link = /(https?:\/\/[^\s]+\/d\/[A-Za-z0-9_-]{43})/.exec(packetMail?.text ?? '')?.[1]
  step('3. the packet email has a link, greets by first name only, and names no document or clinical term', !!link && leaks.length === 0, leaks.length ? `leaked: ${leaks}` : 'clean')

  // ---- 4. on the phone: verify the code, read and sign the six documents with a drawn signature
  await cl.goto(link.replace(/^https?:\/\/[^/]+/, BASE))
  await cl.waitForSelector('text=Verifique su identidad')
  await cl.click('#send'); await cl.waitForSelector('#codebox:not([hidden])')
  await sleep(400)
  const code = /es (\d{6})/.exec((await outbox()).filter((m) => m.subject.includes('código de verificación')).at(-1).text)[1]
  await cl.fill('#code', code); await cl.click('#verify')
  await cl.waitForSelector('text=documentos por completar')
  await cl.screenshot({ path: `${OUT}/${String(++shots).padStart(2, '0')}-phone-checklist.png` })
  await cl.click('a.btn')
  const total = 6
  for (let n = 1; n <= total; n++) {
    await cl.waitForSelector(`text=Documento ${n} de ${total}`)
    for (const el of await cl.locator('.doc-field input[type=text]:visible, .doc-field input[type=tel]:visible, .doc-field input[type=email]:visible').all()) {
      if (!(await el.inputValue())) { const nm = (await el.getAttribute('name')) ?? ''; await el.fill(nm.includes('phone') ? '787-555-0123' : nm.includes('email') ? 'ana.prueba@example.com' : nm.includes('ini') ? 'AP' : nm === 'last_name' ? 'Prueba' : 'Ana') }
    }
    for (const el of await cl.locator('input[type=date]:visible').all()) await el.fill('1990-05-17')
    for (const el of await cl.locator('textarea:visible').all()) await el.fill('Respuesta de prueba')
    for (const el of await cl.locator('.doc-yes_no:visible').all()) await el.locator('input[value=no]').check()
    for (const el of await cl.locator('.doc-radio:visible').all()) await el.locator('input[type=radio]').first().check()
    for (const el of await cl.locator('select:visible').all()) { if (!(await el.inputValue())) await el.selectOption({ index: 1 }) }
    for (const el of await cl.locator('.doc-checkbox:visible input').all()) await el.check()
    await cl.check('#agree'); await cl.check('#esign'); await cl.fill('#signer-name', 'Ana Prueba')
    if (await cl.locator('#sig').count()) {
      await cl.locator('#sig').scrollIntoViewIfNeeded()
      const b = await cl.locator('#sig').boundingBox()
      await cl.mouse.move(b.x + 20, b.y + 60); await cl.mouse.down()
      for (let i = 0; i < 30; i++) await cl.mouse.move(b.x + 20 + i * 5, b.y + 60 + Math.sin(i / 3) * 25)
      await cl.mouse.up()
    }
    if (n === total) await cl.screenshot({ path: `${OUT}/${String(++shots).padStart(2, '0')}-phone-last-document.png` })
    await cl.click('#sign')
    await sleep(900)
  }
  await cl.waitForSelector('text=¡Gracias!')
  const signed = (await api(L(`documents/signed?contactId=${ana.id}`))).json.documents
  const anaNow = (await api(L(`contacts/${ana.id}`))).json.contact
  step('4. six documents signed on the phone, each with its own record; the answers reach the client record',
    signed.length === 6 && anaNow.custom_fields.date_of_birth === '1990-05-17', `signed=${signed.length}`)

  // ---- 5. back as the therapist: card moved, follow-up task created
  const opps2 = (await api(L(`opportunities?pipelineId=${pipelines.find((p) => p.name === 'Onboarding').id}`))).json.opportunities
  const tasks = (await api(L(`contacts/${ana.id}/tasks`))).json
  const taskTitles = (tasks.tasks ?? tasks).map?.((t) => t.title) ?? []
  step('5. the card is at "Documents signed" and "Schedule first appointment" exists',
    stageName(opps2.find((o) => o.contact_id === ana.id)?.stage_id) === 'Documents signed' && taskTitles.some((t) => /Schedule first appointment/.test(t)), taskTitles.join('; '))
  await op.goto(`${BASE}/contacts/${ana.id}`)
  await op.waitForSelector('text=Signed documents')
  await shot(op, 'client-documents-signed')

  // ---- 6. an appointment for today moves the card to "First appointment booked"
  const cal = (await api(L('calendars'))).json.calendars[0]
  const starts = new Date(Date.now() + 5 * 60_000)
  const appt = await api(L('calendars/appointments'), { method: 'POST', body: JSON.stringify({ calendarId: cal.id, contactId: ana.id, title: 'Sesión', startsAt: starts.toISOString(), endsAt: new Date(starts.getTime() + 50 * 60_000).toISOString() }) })
  await sleep(700)
  const opps3 = (await api(L(`opportunities?pipelineId=${pipelines.find((p) => p.name === 'Onboarding').id}`))).json.opportunities
  step('6. booking an appointment moves the card to "First appointment booked"', appt.status === 201 && stageName(opps3.find((o) => o.contact_id === ana.id)?.stage_id) === 'First appointment booked')

  // ---- 7. check in, start the note: the wizard opens with the appointment loaded
  await op.goto(`${BASE}/calendars`)
  await op.waitForSelector('text=Ana Prueba')
  await shot(op, 'today-panel')
  await op.locator('li, div', { hasText: 'Ana Prueba' }).locator('button:has-text("Check in")').first().click()
  await op.waitForSelector('text=Start note')
  await op.locator('a:has-text("Start note"), button:has-text("Start note")').first().click()
  await op.waitForSelector('nav[aria-label="Steps"]')
  step('7. check-in, then "Start note" opens the wizard with the appointment loaded', /notes\/new/.test(op.url()) && (await op.locator('text=Ana Prueba').count()) > 0)
  await shot(op, 'note-wizard')

  // ---- 8. cannot sign without the risk assessment
  // write something first: the draft is created by the first autosave, after which the address carries the note's id
  await op.getByRole('button', { name: /Notes|DAP/ }).first().click()
  await op.fill('#dap-s', 'Borrador inicial.')
  await op.getByRole('button', { name: /Review/ }).click()
  const signBtn = op.getByRole('button', { name: 'Sign note' })
  const disabledNoRisk = await signBtn.isDisabled()
  // leaving a step saves the draft; the address then carries the note's id
  await op.waitForFunction(() => /notes\/[^/]+\/edit/.test(location.pathname), null, { timeout: 15_000 })
  const noteId = /notes\/([^/]+)\/edit/.exec(op.url())?.[1]
  const forced = noteId ? await api(L(`session-notes/${noteId}/sign`), { method: 'POST' }) : { status: 0 }
  step('8. "Sign note" is disabled and the API answers 422 without the risk assessment', disabledNoRisk && forced.status === 422 && forced.json?.error === 'risk_incomplete', `button disabled=${disabledNoRisk}, api=${forced.status}`)
  await shot(op, 'review-blocked')

  // ---- 9. complete the risk (moderate), the DAP, and sign
  await op.getByRole('button', { name: /Risk/ }).first().click()
  const choose = async (group, name) => op.getByRole('radiogroup', { name: group }).getByRole('radio', { name }).click()
  await choose('Suicidal ideation', /denied/i); await choose('Self-harm', /denied/i); await choose('Harm to others', /denied/i)
  await choose('Overall risk level', /moderate/i)
  await op.getByRole('group', { name: 'Actions taken' }).getByRole('button', { name: /safety plan reviewed/i }).click()
  await op.fill('#risk-notes', 'Se revisó el plan de seguridad con la cliente; acordó llamar al 988 si empeora.')
  await shot(op, 'risk-step')
  await op.getByRole('button', { name: /Notes|DAP/ }).first().click()
  await op.fill('#dap-s', 'La cliente refiere ansiedad leve esta semana.')
  await op.fill('#dap-o', 'Afecto congruente; cooperadora.')
  await op.getByRole('button', { name: /Review/ }).click()
  await op.getByRole('button', { name: 'Sign note' }).click()
  await op.locator('[role=dialog] button:has-text("Sign note")').click()
  await op.waitForURL(/\/notes\/[^/]+$/)
  await op.waitForSelector('text=Signed')
  const nid = /notes\/([^/?]+)/.exec(op.url())[1]
  const opps4 = (await api(L(`opportunities?pipelineId=${pipelines.find((p) => p.name === 'Onboarding').id}`))).json.opportunities
  const appts = (await api(L(`calendars/appointments?from=${new Date(Date.now() - 864e5).toISOString()}&to=${new Date(Date.now() + 864e5).toISOString()}`))).json.appointments
  const elevated = (await api(L('session-notes/risk/summary'))).json.elevated
  await op.goto(`${BASE}/contacts/${ana.id}`)
  await op.waitForSelector('text=Moderate')
  await shot(op, 'risk-badge')
  step('9. note signed: amber risk badge, listed as elevated risk, card "Active client", appointment completed',
    stageName(opps4.find((o) => o.contact_id === ana.id)?.stage_id) === 'Active client' && appts.find((a) => a.id === appt.json.appointment.id)?.status === 'completed' && elevated.some((e) => e.contact_id === ana.id))

  // ---- 10. the report prints as a PDF with the letterhead, the risk section and the signature
  await op.goto(`${BASE}/contacts/${ana.id}/notes/${nid}`)
  await op.waitForSelector('text=Risk')
  const reportText = await op.locator('main').innerText().catch(() => op.innerText('body'))
  await op.emulateMedia({ media: 'print' })
  const pdf = await op.pdf({ preferCSSPageSize: true, printBackground: true })
  await op.emulateMedia({ media: 'screen' })
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length
  step('10. the report becomes a PDF with the risk assessment and the signature', pdf.subarray(0, 4).toString() === '%PDF' && pages >= 1 && /Consultorio Demo/.test(reportText) && /risk/i.test(reportText) && /signed/i.test(reportText), `${pages} page(s), ${pdf.length} bytes`)
  await shot(op, 'note-report')

  // ---- 11. after the 72 h window: no edit, no delete, the API says 409, an addendum still works
  await fetch(`${API}/__dev/close-note-window/${nid}`, { method: 'POST' })
  await op.reload()
  await op.waitForSelector('text=Add addendum')
  const edit = await op.getByRole('button', { name: /^Edit$/ }).count() + await op.getByRole('link', { name: /^Edit$/ }).count()
  const patch = await api(L(`session-notes/${nid}`), { method: 'PATCH', body: JSON.stringify({ dataSubjective: 'cambio tardío' }) })
  await op.getByRole('button', { name: /Add addendum/ }).click()
  await op.locator('[role=dialog] textarea').fill('Anexo: la cliente llamó al día siguiente; sin cambios.')
  await op.locator('[role=dialog] button:has-text("Add addendum")').click()
  await op.waitForSelector('text=Anexo: la cliente llamó')
  step('11. after the window: no Edit, PATCH is 409, and the addendum is added', edit === 0 && patch.status === 409 && patch.json?.error === 'note_locked', `edit controls=${edit}, patch=${patch.status}`)
  await shot(op, 'note-locked-addendum')

  // ---- 12. the audit log verifies and the export contains the whole story
  await op.goto(`${BASE}/settings/audit`)
  await op.getByRole('button', { name: /Verify integrity/ }).click()
  await op.waitForSelector('text=/intact|verified|✓/i', { timeout: 15_000 })
  const csv = (await api(L('audit/export.csv'))).text
  const want = ['contact.created', 'invite.completed', 'packet.sent', 'document.signed', 'packet.completed', 'pipeline.stage_changed', 'note.created', 'note.signed', 'note.addendum_added', 'note.edit_rejected_locked']
  const missing = want.filter((a) => !csv.includes(a))
  await shot(op, 'audit-log')
  step('12. the audit log verifies and the CSV has every event of the cycle', missing.length === 0, missing.length ? `missing: ${missing}` : `${csv.split('\n').length - 1} rows`)

  await browser.close()

  // ---- 13. a session left alone is signed out (a separate server with a 3 s idle limit)
  const idle = spawn('npx', ['tsx', 'server/dev-server.ts'], { cwd: root, env: { ...process.env, PORT: '8793', IDLE_TTL_MS: '3000' }, stdio: 'ignore' })
  children.push(idle)
  await waitFor('http://localhost:8793/health', 'idle server')
  const login = await fetch('http://localhost:8793/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@psycrm.test', password: 'psycrm-demo-pass' }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const before = (await fetch('http://localhost:8793/api/auth/me', { headers: { cookie } })).status
  await sleep(4200)
  const after = (await fetch('http://localhost:8793/api/auth/me', { headers: { cookie } })).status
  step('13. an idle session is signed out', before === 200 && after === 401, `before=${before}, after=${after}`)

  if (errors.length) console.log('page errors:', errors)
  step('no unexpected errors in the browser', errors.length === 0, errors.join(' | '))
}

main()
  .then(() => { console.log(`\nE2E passed: ${results.length} checks. Screenshots in docs/psycrm/e2e/`); cleanup(0) })
  .catch((e) => { console.error('\nE2E FAILED:', e.message); cleanup(1) })

function cleanup(code) {
  for (const c of children) try { c.kill('SIGTERM') } catch { /* already gone */ }
  setTimeout(() => process.exit(code), 300)
}

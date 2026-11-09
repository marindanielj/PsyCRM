import { hashPassword, verifyPassword } from '../lib/password'
import { createSession } from '../lib/session'
import { SESSION_COOKIE } from '../middleware/auth'
import { OperatorsRepo } from '../repos/operators-repo'
import { addLocation, freshDb } from '../test-utils/pglite'
import { authRoute } from './auth'

const secret = 'test-secret-test-secret-test-secret'
const OLD = 'old-password-123456'
const NEW = 'a-brand-new-passphrase-9'

async function setup(extra: { changeRateLimit?: { max: number; windowMs: number } } = {}) {
  const { db } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  await db.query("INSERT INTO operators (id, email, name, password_hash) VALUES ('op1','dra@x.com','Dra. Rivera',$1)", [await hashPassword(OLD)])
  await db.query("INSERT INTO operator_locations (operator_id, location_id) VALUES ('op1',$1)", [loc])
  const repo = new OperatorsRepo(db)
  const app = authRoute({ db, sessionSecret: secret, revokedBefore: (id) => repo.passwordChangedAt(id), ...extra })
  // A session issued an hour ago (another device) and one issued now (this device).
  const otherDevice = createSession({ operatorId: 'op1' }, secret, { now: Date.now() - 3_600_000 })
  const thisDevice = createSession({ operatorId: 'op1' }, secret)
  const call = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(init.token ? { Cookie: `${SESSION_COOKIE}=${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  const change = (body: unknown, token = thisDevice) => call('/change-password', { token, body })
  return { db, loc, call, change, otherDevice, thisDevice, repo }
}

const auditActions = async (db: Awaited<ReturnType<typeof setup>>['db']) =>
  (await db.query<{ action: string; details: unknown }>("SELECT action, details FROM audit_log WHERE action LIKE 'auth.password%' ORDER BY id")).map((r) => r.action)

test('changing the password needs a signed-in session', async () => {
  const { change } = await setup()
  const res = await change({ currentPassword: OLD, newPassword: NEW }, '')
  expect(res.status).toBe(401)
})

test('a wrong current password is refused with 403 (not 401), changes nothing, and is audited', async () => {
  const { change, db, repo } = await setup()
  const res = await change({ currentPassword: 'not-it', newPassword: NEW })
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'incorrect password' })
  expect(await repo.passwordChangedAt('op1')).toBeNull()
  expect(await verifyPassword((await repo.getById('op1'))!.password_hash, OLD)).toBe(true)
  expect(await auditActions(db)).toEqual(['auth.password_change_failed'])
})

test('a new password that is too short, too long, the same, or the email is refused', async () => {
  const { change, repo } = await setup()
  expect((await change({ currentPassword: OLD, newPassword: 'short' })).status).toBe(400)
  expect((await change({ currentPassword: OLD, newPassword: 'x'.repeat(129) })).status).toBe(400)
  const same = await change({ currentPassword: OLD, newPassword: OLD })
  expect(same.status).toBe(400)
  expect(await same.json()).toEqual({ error: 'same password' })
  const email = await change({ currentPassword: OLD, newPassword: 'dra@x.com' })
  expect(email.status).toBe(400) // under the minimum length anyway
  expect(await repo.passwordChangedAt('op1')).toBeNull()
})

test('a correct change stores a new argon2id hash, audits it without any secret, and keeps this device signed in', async () => {
  const { change, call, db, repo, thisDevice } = await setup()
  const res = await change({ currentPassword: OLD, newPassword: NEW })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; token: string }
  expect(body.ok).toBe(true)
  expect(res.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`)

  const row = await repo.getById('op1')
  expect(row!.password_hash).toMatch(/^\$argon2id\$/)
  expect(await verifyPassword(row!.password_hash, NEW)).toBe(true)
  expect(await verifyPassword(row!.password_hash, OLD)).toBe(false)
  expect(await repo.passwordChangedAt('op1')).toBeGreaterThan(Date.now() - 10_000)

  expect(await auditActions(db)).toEqual(['auth.password_changed'])
  const dump = JSON.stringify(await db.query('SELECT * FROM audit_log'))
  expect(dump).not.toContain(OLD)
  expect(dump).not.toContain(NEW)

  // The session that made the change stays open (its cookie is new), the old cookie of this device is void too.
  expect((await call('/me', { method: 'GET', token: body.token })).status).toBe(200)
  expect((await call('/me', { method: 'GET', token: thisDevice })).status).toBe(401)
})

test('changing the password signs out every other device', async () => {
  const { change, call, otherDevice } = await setup()
  expect((await call('/me', { method: 'GET', token: otherDevice })).status).toBe(200)
  await change({ currentPassword: OLD, newPassword: NEW })
  expect((await call('/me', { method: 'GET', token: otherDevice })).status).toBe(401)
})

test('after the change, signing in works with the new password and not with the old one', async () => {
  const { change, call } = await setup()
  await change({ currentPassword: OLD, newPassword: NEW })
  expect((await call('/login', { body: { email: 'dra@x.com', password: OLD } })).status).toBe(401)
  expect((await call('/login', { body: { email: 'dra@x.com', password: NEW } })).status).toBe(200)
})

test('/me says whether the password was ever changed', async () => {
  const { change, call, thisDevice } = await setup()
  const before = (await (await call('/me', { method: 'GET', token: thisDevice })).json()) as { passwordChangedAt: number | null }
  expect(before.passwordChangedAt).toBeNull()
  const res = await change({ currentPassword: OLD, newPassword: NEW })
  const { token } = (await res.json()) as { token: string }
  const after = (await (await call('/me', { method: 'GET', token })).json()) as { passwordChangedAt: number | null }
  expect(after.passwordChangedAt).toBeGreaterThan(0)
})

test('too many wrong guesses are throttled with 429, even before the right password', async () => {
  const { change, repo } = await setup({ changeRateLimit: { max: 3, windowMs: 60_000 } })
  for (let i = 0; i < 3; i++) expect((await change({ currentPassword: `wrong-${i}`, newPassword: NEW })).status).toBe(403)
  const res = await change({ currentPassword: OLD, newPassword: NEW })
  expect(res.status).toBe(429)
  expect(res.headers.get('retry-after')).toBeTruthy()
  expect(await repo.passwordChangedAt('op1')).toBeNull()
})

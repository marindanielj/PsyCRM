import { Hono } from 'hono'
import type { AppEnv } from '../app-env'
import { FakeDatabase } from '../db/fake-database'
import { contactsRoute } from './contacts'

function harness(db: FakeDatabase, locationId = 'locA') {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', locationId)
    await next()
  })
  app.route('/', contactsRoute({ db }))
  return app
}

test('lists contacts scoped to the current location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Bob' }]) // list
  const res = await harness(db).request('/')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ contacts: [{ id: 'c1', name: 'Bob' }] })
  expect(db.calls[0]?.params[0]).toBe('locA')
})

test('get returns the contact with its timeline, both location-scoped', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Bob' }]) // get
  db.enqueue([{ id: 't1', type: 'message' }]) // listByContact
  const res = await harness(db).request('/c1')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    contact: { id: 'c1', name: 'Bob' },
    timeline: [{ id: 't1', type: 'message' }],
  })
  expect(db.calls.every((call) => call.params.includes('locA'))).toBe(true)
})

test('get returns 404 when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // get -> none
  const res = await harness(db).request('/missing')
  expect(res.status).toBe(404)
})

test('creates a contact from name + phone and returns 201', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c9', name: 'Admin', phones: ['+15035550142'], emails: [] }]) // upsertByMatch RETURNING *
  const res = await harness(db).request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', phone: '+15035550142' }),
  })
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({
    ok: true,
    contact: { id: 'c9', name: 'Admin', phones: ['+15035550142'], emails: [] },
  })
  // upsertByMatch params: [id, locationId, name, phones, emails, key, source, externalIds]
  expect(db.calls[0]?.params[1]).toBe('locA') // location scoped
  expect(db.calls[0]?.params[2]).toBe('Admin') // name from the body
  expect(db.calls[0]?.params[6]).toBe('manual') // operator-entered source
})

test('rejects a create with no name, phone, or email before touching the db', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '   ' }), // whitespace-only collapses to nothing
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

// --- soft-delete (archive / restore) --------------------------------------
// The "Delete" control is operator-only (this route is behind operatorAuth) and
// is a SOFT delete — it archives, never hard-deletes. The AI assistant has no
// delete tool by construction; only the operator's own click reaches here.

test('DELETE /:id archives the contact and returns it (soft delete)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Admin', archived_at: '2026-06-19T03:00:00Z' }]) // archive RETURNING *
  const res = await harness(db).request('/c1', { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    ok: true,
    contact: { id: 'c1', name: 'Admin', archived_at: '2026-06-19T03:00:00Z' },
  })
  expect(db.calls[0]?.params).toEqual(['locA', 'c1']) // location-scoped, by id
})

test('DELETE /:id returns 404 when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // archive matched no row
  const res = await harness(db).request('/missing', { method: 'DELETE' })
  expect(res.status).toBe(404)
})

test('POST /:id/restore brings an archived contact back', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Admin', archived_at: null }]) // restore RETURNING *
  const res = await harness(db).request('/c1/restore', { method: 'POST' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    ok: true,
    contact: { id: 'c1', name: 'Admin', archived_at: null },
  })
  expect(db.calls[0]?.params).toEqual(['locA', 'c1'])
})

test('POST /:id/restore returns 404 when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // restore matched no row
  const res = await harness(db).request('/missing/restore', { method: 'POST' })
  expect(res.status).toBe(404)
})

test('GET /archived lists archived contacts (routes to listArchived, not get(:id))', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Admin', archived_at: '2026-06-19T03:00:00Z' }])
  const res = await harness(db).request('/archived')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    contacts: [{ id: 'c1', name: 'Admin', archived_at: '2026-06-19T03:00:00Z' }],
  })
  // proves it hit listArchived (archived_at IS NOT NULL), not get('archived')
  expect(db.calls[0]?.sql).toMatch(/archived_at IS NOT NULL/i)
})

test('lists a contact notes scoped to the location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'n1', body: 'Pinned note', pinned: true }])
  const res = await harness(db).request('/c1/notes')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ notes: [{ id: 'n1', body: 'Pinned note', pinned: true }] })
  expect(db.calls[0]?.params).toEqual(['locA', 'c1'])
})

test('creates a note on a contact and returns 201', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'n1', contact_id: 'c1', body: 'Called back', author: 'AL' }])
  const res = await harness(db).request('/c1/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'Called back', author: 'AL' }),
  })
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({
    ok: true,
    note: { id: 'n1', contact_id: 'c1', body: 'Called back', author: 'AL' },
  })
  expect(db.calls[0]?.params[0]).toBe('locA') // location scoped
  expect(db.calls[0]?.params[2]).toBe('c1') // contact from the path
})

test('rejects a note with an empty body', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/c1/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: '' }),
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('updates a note (pin toggle) and returns it', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'n1', pinned: true }])
  const res = await harness(db).request('/c1/notes/n1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned: true }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, note: { id: 'n1', pinned: true } })
})

test('patch with no fields is rejected before touching the db', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/c1/notes/n1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('patch returns 404 when the note is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // update -> no row
  const res = await harness(db).request('/c1/notes/missing', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'edit' }),
  })
  expect(res.status).toBe(404)
})

test('deletes a note and returns ok', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'n1' }]) // remove -> one row
  const res = await harness(db).request('/c1/notes/n1', { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  // The note is deleted through the contact it belongs to: location, contact, then note id.
  expect(db.calls[0]?.params).toEqual(['locA', 'c1', 'n1'])
})

test('delete returns 404 when the note is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // remove -> no row
  const res = await harness(db).request('/c1/notes/missing', { method: 'DELETE' })
  expect(res.status).toBe(404)
})

test('lists a contact tasks scoped to the location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 't1', title: 'Call back', completed_at: null }])
  const res = await harness(db).request('/c1/tasks')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ tasks: [{ id: 't1', title: 'Call back', completed_at: null }] })
  expect(db.calls[0]?.params).toEqual(['locA', 'c1'])
})

test('creates a task on a contact and returns 201', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 't1', contact_id: 'c1', title: 'Send the revised quote' }])
  const res = await harness(db).request('/c1/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Send the revised quote', dueAt: '2026-06-05T17:00:00Z' }),
  })
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({
    ok: true,
    task: { id: 't1', contact_id: 'c1', title: 'Send the revised quote' },
  })
  expect(db.calls[0]?.params[0]).toBe('locA') // location scoped
  expect(db.calls[0]?.params[2]).toBe('c1') // contact from the path
  expect(db.calls[0]?.params[3]).toBe('Send the revised quote') // title
  expect(db.calls[0]?.params[5]).toBe('2026-06-05T17:00:00Z') // due_at
})

test('rejects a task with an empty title', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/c1/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '' }),
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('completes a task (toggle) and returns it', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 't1', completed_at: '2026-06-03T18:00:00Z' }])
  const res = await harness(db).request('/c1/tasks/t1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ completed: true }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, task: { id: 't1', completed_at: '2026-06-03T18:00:00Z' } })
  expect(db.calls[0]?.sql).toMatch(/completed_at=now\(\)/i)
})

test('task patch with no fields is rejected before touching the db', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/c1/tasks/t1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('task patch returns 404 when the task is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // update -> no row
  const res = await harness(db).request('/c1/tasks/missing', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'edit' }),
  })
  expect(res.status).toBe(404)
})

test('deletes a task and returns ok', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 't1' }]) // remove -> one row
  const res = await harness(db).request('/c1/tasks/t1', { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  // The task is deleted through the contact it belongs to: location, contact, then task id.
  expect(db.calls[0]?.params).toEqual(['locA', 'c1', 't1'])
})

test('task delete returns 404 when the task is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // remove -> no row
  const res = await harness(db).request('/c1/tasks/missing', { method: 'DELETE' })
  expect(res.status).toBe(404)
})

test('adds a tag to a contact and returns the updated contact', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', tags: ['vip'] }]) // addTag RETURNING *
  const res = await harness(db).request('/c1/tags', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag: 'vip' }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, contact: { id: 'c1', tags: ['vip'] } })
  expect(db.calls[0]?.params).toEqual(['locA', 'vip', 'c1']) // location, tag, contact id
})

test('trims a tag before adding (matches the automation runner)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', tags: ['vip'] }])
  await harness(db).request('/c1/tags', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag: '  vip  ' }),
  })
  expect(db.calls[0]?.params[1]).toBe('vip') // trimmed, not '  vip  '
})

test('rejects an empty tag before touching the db', async () => {
  const db = new FakeDatabase()
  const res = await harness(db).request('/c1/tags', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag: '   ' }),
  })
  expect(res.status).toBe(400)
  expect(db.calls).toHaveLength(0)
})

test('add tag returns 404 when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // addTag -> no row
  const res = await harness(db).request('/missing/tags', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag: 'vip' }),
  })
  expect(res.status).toBe(404)
})

test('removes a tag from a contact and returns the updated contact', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', tags: [] }]) // removeTag RETURNING *
  const res = await harness(db).request('/c1/tags/vip', { method: 'DELETE' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, contact: { id: 'c1', tags: [] } })
  expect(db.calls[0]?.params).toEqual(['locA', 'vip', 'c1'])
})

test('remove tag returns 404 when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // removeTag -> no row
  const res = await harness(db).request('/missing/tags/vip', { method: 'DELETE' })
  expect(res.status).toBe(404)
})

test('sets a custom-field value on a contact, coerced by the field type', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'f1', key: 'roof_age', type: 'number' }]) // getByKey
  db.enqueue([{ id: 'c1', custom_fields: { roof_age: 12 } }]) // setCustomField RETURNING *
  const res = await harness(db).request('/c1/custom-fields/roof_age', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: '12' }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    ok: true,
    contact: { id: 'c1', custom_fields: { roof_age: 12 } },
  })
  // '12' coerced to number 12 then JSON-encoded for the jsonb merge
  expect(db.calls[1]?.params).toEqual(['locA', 'roof_age', '12', 'c1'])
})

test('clearing a custom field (null) removes the key', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'f1', key: 'roof_age', type: 'number' }]) // getByKey
  db.enqueue([{ id: 'c1', custom_fields: {} }]) // setCustomField RETURNING *
  const res = await harness(db).request('/c1/custom-fields/roof_age', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: null }),
  })
  expect(res.status).toBe(200)
  expect(db.calls[1]?.sql).toMatch(/custom_fields - \$2/i)
  expect(db.calls[1]?.params).toEqual(['locA', 'roof_age', 'c1']) // no value param on clear
})

test('setting a value for an unknown field key is 404 (no write)', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // getByKey -> none
  const res = await harness(db).request('/c1/custom-fields/ghost', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x' }),
  })
  expect(res.status).toBe(404)
  expect(db.calls).toHaveLength(1) // only the getByKey lookup
})

test('set custom field returns 404 when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'f1', key: 'roof_age', type: 'text' }]) // getByKey hits
  db.enqueue([]) // setCustomField -> no row
  const res = await harness(db).request('/missing/custom-fields/roof_age', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x' }),
  })
  expect(res.status).toBe(404)
})

// --- contact state (per-state legal texting hours) ------------------------
// The State control on the contact record pins which legal texting window the
// gateway enforces (8am-9pm in THAT state's own timezone). Operator-only
// (behind operatorAuth); free text at the route because the gateway is the
// single legal authority — the dropdown constrains input to AZ/NC/not-set in
// practice. Empty clears it back to "not set", which the gateway then refuses
// as unknown_state rather than guessing a timezone.

test('PUT /:id/state sets the state and returns the updated contact', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Admin', state: 'AZ' }]) // setState RETURNING *
  const res = await harness(db).request('/c1/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'AZ' }),
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, contact: { id: 'c1', name: 'Admin', state: 'AZ' } })
  expect(db.calls[0]?.params).toEqual(['locA', 'AZ', 'c1']) // location, state, contact id
})

test('PUT /:id/state with null clears the state', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Admin', state: null }])
  const res = await harness(db).request('/c1/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: null }),
  })
  expect(res.status).toBe(200)
  expect(db.calls[0]?.params).toEqual(['locA', null, 'c1'])
})

test('PUT /:id/state treats a whitespace-only string as clearing (null)', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Admin', state: null }])
  const res = await harness(db).request('/c1/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: '   ' }), // trims to empty -> null, never stored as ''
  })
  expect(res.status).toBe(200)
  expect(db.calls[0]?.params).toEqual(['locA', null, 'c1'])
})

test('PUT /:id/state returns 404 when the contact is not in this location', async () => {
  const db = new FakeDatabase()
  db.enqueue([]) // setState matched no row
  const res = await harness(db).request('/missing/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'AZ' }),
  })
  expect(res.status).toBe(404)
})



// --- audit + date of birth -----------------------------------------------------

import { addLocation, freshDb } from '../test-utils/pglite'

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function auditHarness(db: FakeDatabase, opts: { requireDateOfBirth?: boolean; today?: () => string } = {}) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', 'locA')
    await next()
  })
  app.route('/', contactsRoute({ db, ...opts }))
  return app
}

test('creating a client writes contact.created in the same transaction, naming fields but not values', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Ana Rivera', custom_fields: {}, inserted: true }])
  const res = await auditHarness(db).request('/', json({ name: 'Ana Rivera', email: 'ana@example.com' }))
  expect(res.status).toBe(201)
  expect(db.transactions).toBe(1)
  expect(db.auditEntries()).toEqual([
    { locationId: 'locA', actorType: 'operator', actorId: 'op1', action: 'contact.created', entityType: 'contact', entityId: 'c1', contactId: 'c1', details: { source: 'manual', fields: ['name', 'email'] } },
  ])
  expect(JSON.stringify(db.audits)).not.toContain('ana@example.com')
})

test('a create that matches an existing client is not audited as a creation', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Ana', custom_fields: {}, inserted: false }])
  const res = await auditHarness(db).request('/', json({ name: 'Ana', email: 'ana@example.com' }))
  expect(res.status).toBe(201)
  expect(db.audits).toHaveLength(0)
})

test('PsyCRM: date of birth is required, must be a real date, and cannot be in the future (database untouched)', async () => {
  const db = new FakeDatabase()
  const app = auditHarness(db, { requireDateOfBirth: true, today: () => '2026-11-05' })
  const post = (body: unknown) => app.request('/', json(body))
  expect((await post({ name: 'Ana' })).status).toBe(400)
  expect((await post({ name: 'Ana', dateOfBirth: '2024-02-31' })).status).toBe(400)
  expect((await post({ name: 'Ana', dateOfBirth: '05/11/1990' })).status).toBe(400)
  expect((await post({ name: 'Ana', dateOfBirth: '2026-11-06' })).status).toBe(400)
  expect(db.calls).toHaveLength(0)
  expect(db.audits).toHaveLength(0)
})

test('PsyCRM: a valid date of birth is stored as the date_of_birth custom field, once', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Ana', custom_fields: {}, inserted: true }]) // upsert
  db.enqueue([{ id: 'c1', name: 'Ana', custom_fields: { date_of_birth: '1990-05-17' } }]) // setCustomField
  const res = await auditHarness(db, { requireDateOfBirth: true, today: () => '2026-11-05' }).request('/', json({ name: 'Ana', dateOfBirth: '1990-05-17' }))
  expect(res.status).toBe(201)
  expect(db.calls[1]?.sql).toContain('custom_fields')
  expect(JSON.stringify(db.calls[1]?.params)).toContain('date_of_birth')
  expect(db.auditEntries()[0]?.details.fields).toEqual(['name', 'date_of_birth'])
  expect(JSON.stringify(db.audits)).not.toContain('1990-05-17') // the value is PHI: never in the log

  // an existing client that already has a date of birth keeps it
  const keep = new FakeDatabase()
  keep.enqueue([{ id: 'c1', name: 'Ana', custom_fields: { date_of_birth: '1985-01-01' }, inserted: false }])
  await auditHarness(keep, { requireDateOfBirth: true, today: () => '2026-11-05' }).request('/', json({ name: 'Ana', dateOfBirth: '1990-05-17' }))
  expect(keep.calls).toHaveLength(1) // only the upsert; no overwrite
})

test('without requireDateOfBirth (plain OpenLevel) a date of birth is optional', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Bob', custom_fields: {}, inserted: true }])
  expect((await auditHarness(db).request('/', json({ name: 'Bob' }))).status).toBe(201)
})

test('opening a client record is audited as contact.viewed', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1', name: 'Ana' }]) // get
  db.enqueue([]) // timeline
  const res = await auditHarness(db).request('/c1')
  expect(res.status).toBe(200)
  expect(db.auditEntries()).toMatchObject([{ action: 'contact.viewed', entityId: 'c1', contactId: 'c1', actorId: 'op1' }])
  const missing = new FakeDatabase()
  missing.enqueue([])
  expect((await auditHarness(missing).request('/nope')).status).toBe(404)
  expect(missing.audits).toHaveLength(0) // nothing was accessed
})

test('archive and restore are audited; a 404 is not', async () => {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'c1' }])
  await auditHarness(db).request('/c1', { method: 'DELETE' })
  db.enqueue([{ id: 'c1' }])
  await auditHarness(db).request('/c1/restore', { method: 'POST' })
  expect(db.auditEntries().map((e) => e.action)).toEqual(['contact.archived', 'contact.restored'])
  const none = new FakeDatabase()
  none.enqueue([])
  expect((await auditHarness(none).request('/zzz', { method: 'DELETE' })).status).toBe(404)
  expect(none.audits).toHaveLength(0)
})

test('tags, custom fields and tasks are audited (custom field: key only, never the value)', async () => {
  const db = new FakeDatabase()
  const app = auditHarness(db)
  db.enqueue([{ id: 'c1', tags: ['anxiety'] }])
  await app.request('/c1/tags', json({ tag: 'anxiety' }))
  db.enqueue([{ id: 'c1', tags: [] }])
  await app.request('/c1/tags/anxiety', { method: 'DELETE' })
  db.enqueue([{ id: 'f1', key: 'pronouns', type: 'text' }]) // getByKey
  db.enqueue([{ id: 'c1', custom_fields: { pronouns: 'she/her' } }])
  await app.request('/c1/custom-fields/pronouns', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'she/her' }) })
  db.enqueue([{ id: 't1', title: 'Call Ana' }])
  await app.request('/c1/tasks', json({ title: 'Call Ana' }))
  db.enqueue([{ id: 't1', completed_at: 'now' }])
  await app.request('/c1/tasks/t1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: true }) })

  expect(db.auditEntries().map((e) => [e.action, e.entityId])).toEqual([
    ['contact.tag_added', 'c1'],
    ['contact.tag_removed', 'c1'],
    ['contact.custom_fields_updated', 'c1'],
    ['task.created', 't1'],
    ['task.completed', 't1'],
  ])
  expect(db.auditEntries()[2]?.details).toEqual({ fields: ['pronouns'], cleared: false })
  expect(JSON.stringify(db.audits)).not.toContain('she/her')
  expect(JSON.stringify(db.audits)).not.toContain('Call Ana') // task titles are free text: not logged
})

test('legacy free-text contact notes are audited without their text', async () => {
  const db = new FakeDatabase()
  const app = auditHarness(db)
  db.enqueue([{ id: 'n1', body: 'client discussed trauma history' }])
  await app.request('/c1/notes', json({ body: 'client discussed trauma history' }))
  db.enqueue([{ id: 'n1' }])
  await app.request('/c1/notes/n1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'edited text', pinned: true }) })
  db.enqueue([{ id: 'n1' }])
  await app.request('/c1/notes/n1', { method: 'DELETE' })
  expect(db.auditEntries().map((e) => e.action)).toEqual(['contact.note_added', 'contact.note_updated', 'contact.note_deleted'])
  expect(db.auditEntries()[1]?.details).toEqual({ fields: ['body', 'pinned'] })
  expect(JSON.stringify(db.audits)).not.toContain('trauma')
  expect(JSON.stringify(db.audits)).not.toContain('edited text')
})

test('against a real database the change and its audit row are atomic: if the audit cannot be written, the client is not created', async () => {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db)
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('operatorId', 'op1')
    c.set('locationId', loc)
    await next()
  })
  app.route('/', contactsRoute({ db }))

  const ok = await app.request('/', json({ name: 'Ana Rivera', email: 'ana@example.com' }))
  expect(ok.status).toBe(201)
  expect(await db.query('SELECT 1 FROM contacts')).toHaveLength(1)
  const rows = await db.query<{ action: string; contact_id: string; details: { fields: string[] } }>('SELECT action, contact_id, details FROM audit_log')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ action: 'contact.created', details: { fields: ['name', 'email'] } })

  // Break the audit table; the next create must fail AND leave no contact behind.
  await pg.exec('ALTER TABLE audit_log RENAME TO audit_log_gone')
  const failed = await app.request('/', json({ name: 'Second Person', email: 'second@example.com' }))
  expect(failed.status).toBe(500)
  expect(await db.query('SELECT 1 FROM contacts')).toHaveLength(1)
})

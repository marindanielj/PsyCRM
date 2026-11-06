import type { PGlite } from '@electric-sql/pglite'
import { addLocation, freshDb } from '../test-utils/pglite'

async function setup() {
  const { db, pg } = await freshDb()
  const loc = await addLocation(db, 'loc_a')
  const insert = (id: string, family: string, version: number, status = 'draft', body = 'texto') =>
    pg.query(
      `INSERT INTO document_templates (id, location_id, family_id, translation_group_id, version, status, kind, title, body_md)
       VALUES ($1,$2,$3,'tg',$4,$5,'agreement','T',$6)`,
      [id, loc, family, version, status, body],
    )
  return { db, pg, loc, insert }
}
const fails = async (p: Promise<unknown>, re: RegExp) => expect(String(await p.then(() => 'ok', (e) => e.message))).toMatch(re)
const run = (pg: PGlite, sql: string, params: unknown[] = []) => pg.query(sql, params)

test('a draft can be edited freely', async () => {
  const { pg, insert } = await setup()
  await insert('t1', 'f', 1)
  await run(pg, "UPDATE document_templates SET body_md='nuevo', title='Otro' WHERE id='t1'")
  expect((await run(pg, "SELECT body_md FROM document_templates WHERE id='t1'")).rows[0]).toEqual({ body_md: 'nuevo' })
})

test('activating stamps activated_at; after that the content cannot change by UPDATE', async () => {
  const { pg, insert } = await setup()
  await insert('t1', 'f', 1)
  await run(pg, "UPDATE document_templates SET status='active' WHERE id='t1'")
  const row = (await run(pg, "SELECT activated_at FROM document_templates WHERE id='t1'")).rows[0] as { activated_at: unknown }
  expect(row.activated_at).not.toBeNull()
  for (const set of ["body_md='x'", "title='x'", "fields='[{\"key\":\"a\"}]'::jsonb", "signature='{\"required\":false,\"drawn\":false}'::jsonb", "signer_roles='{guardian}'", "kind='intake_form'", "version=2", "activated_at=now()"]) {
    await fails(run(pg, `UPDATE document_templates SET ${set} WHERE id='t1'`), /document_template_immutable/)
  }
})

test('active -> retired is allowed; nothing leaves retired; draft cannot be un-drafted backwards', async () => {
  const { pg, insert } = await setup()
  await insert('t1', 'f', 1, 'active')
  await run(pg, "UPDATE document_templates SET status='retired' WHERE id='t1'")
  await fails(run(pg, "UPDATE document_templates SET status='active' WHERE id='t1'"), /document_template_status/)
  await fails(run(pg, "UPDATE document_templates SET status='draft' WHERE id='t1'"), /document_template_status/)
})

test('only active/retired versions are protected from DELETE; drafts can be removed', async () => {
  const { pg, insert } = await setup()
  await insert('d', 'f', 2)
  await insert('a', 'g', 1, 'active')
  await run(pg, "DELETE FROM document_templates WHERE id='d'")
  await fails(run(pg, "DELETE FROM document_templates WHERE id='a'"), /document_template_immutable/)
})

test('one active version per family, but many across families', async () => {
  const { pg, insert } = await setup()
  await insert('a1', 'f', 1, 'active')
  await insert('a2', 'f', 2, 'draft')
  await fails(run(pg, "UPDATE document_templates SET status='active' WHERE id='a2'"), /document_templates_one_active|duplicate key/)
  await insert('b1', 'g', 1, 'active')
})

test('signer_roles must be known and non-empty; locale and kind are constrained', async () => {
  const { pg, loc } = await setup()
  const bad = (cols: string, vals: string) =>
    run(pg, `INSERT INTO document_templates (id, location_id, family_id, translation_group_id, ${cols}) VALUES ('x',$1,'f','tg',${vals})`, [loc])
  await fails(bad('kind, title, signer_roles', "'agreement','T','{nurse}'"), /check/i)
  await fails(bad('kind, title, signer_roles', "'agreement','T','{}'"), /check/i)
  await fails(bad('kind, title, locale', "'agreement','T','fr'"), /check/i)
  await fails(bad('kind, title', "'form','T'"), /check/i)
})

test('the schema applies twice without error (idempotent)', async () => {
  const { pg } = await setup()
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8')
  await pg.exec(sql)
})

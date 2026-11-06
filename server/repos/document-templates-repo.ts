import { nanoid } from 'nanoid'
import type { Database } from '../db/database'
import { type AuditEntry, audit } from '../lib/audit'
import type { CreateTemplateInput, PatchTemplateInput, SignerRole, TemplateField } from '../lib/document-vocab'
import { LocationScopedRepo } from './base-repo'

export type DocActor = Pick<AuditEntry, 'ip' | 'userAgent'> & { operatorId: string }

export interface DocumentTemplate {
  id: string
  familyId: string
  translationGroupId: string
  locale: 'es' | 'en'
  version: number
  status: 'draft' | 'active' | 'retired'
  kind: 'agreement' | 'intake_form'
  title: string
  bodyMd: string
  fields: TemplateField[]
  signature: { required: boolean; drawn: boolean }
  signerRoles: SignerRole[]
  createdAt: string
  updatedAt: string
  activatedAt: string | null
}

export interface TemplateSummary extends Omit<DocumentTemplate, 'bodyMd' | 'fields'> {
  /** Version currently in force for this family (null while only drafts exist). */
  activeVersion: number | null
  fieldCount: number
}

export type TemplateError =
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'template_immutable' }
  | { ok: false; error: 'draft_exists'; draftId: string }
  | { ok: false; error: 'not_draft' }
  | { ok: false; error: 'not_active' }
export type TemplateResult<T> = ({ ok: true } & T) | TemplateError

interface Row {
  id: string
  family_id: string
  translation_group_id: string
  locale: 'es' | 'en'
  version: number
  status: 'draft' | 'active' | 'retired'
  kind: 'agreement' | 'intake_form'
  title: string
  body_md: string
  fields: TemplateField[]
  signature: { required: boolean; drawn: boolean }
  signer_roles: SignerRole[]
  created_at: Date | string
  updated_at: Date | string
  activated_at: Date | string | null
}

const COLS =
  'id, family_id, translation_group_id, locale, version, status, kind, title, body_md, fields, signature, signer_roles, created_at, updated_at, activated_at'

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString())

function toTemplate(r: Row): DocumentTemplate {
  return {
    id: r.id,
    familyId: r.family_id,
    translationGroupId: r.translation_group_id,
    locale: r.locale,
    version: Number(r.version),
    status: r.status,
    kind: r.kind,
    title: r.title,
    bodyMd: r.body_md,
    fields: r.fields ?? [],
    signature: r.signature,
    signerRoles: r.signer_roles,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    activatedAt: iso(r.activated_at),
  }
}

export class DocumentTemplatesRepo extends LocationScopedRepo {
  private auditCtx(actor: DocActor): Pick<AuditEntry, 'actor' | 'ip' | 'userAgent'> {
    return { actor: { type: 'operator', id: actor.operatorId }, ip: actor.ip, userAgent: actor.userAgent }
  }

  /** The newest version of each family, with the version in force. */
  async list(): Promise<TemplateSummary[]> {
    const rows = await this.db.query<Row & { active_version: number | null }>(
      `SELECT DISTINCT ON (t.family_id) t.id, t.family_id, t.translation_group_id, t.locale, t.version, t.status, t.kind,
              t.title, t.body_md, t.fields, t.signature, t.signer_roles, t.created_at, t.updated_at, t.activated_at,
              (SELECT a.version FROM document_templates a
                WHERE a.location_id = t.location_id AND a.family_id = t.family_id AND a.status = 'active') AS active_version
         FROM document_templates t
        WHERE t.location_id = $1
        ORDER BY t.family_id, t.version DESC`,
      [this.locationId],
    )
    return rows
      .map((r) => {
        const { bodyMd: _b, fields, ...rest } = toTemplate(r)
        return { ...rest, activeVersion: r.active_version === null ? null : Number(r.active_version), fieldCount: fields.length }
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  async get(id: string): Promise<DocumentTemplate | null> {
    const rows = await this.db.query<Row>(`SELECT ${COLS} FROM document_templates WHERE location_id = $1 AND id = $2`, [this.locationId, id])
    return rows[0] ? toTemplate(rows[0]) : null
  }

  /** The version currently in force for a family, if any. */
  async getActiveByFamily(familyId: string): Promise<DocumentTemplate | null> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM document_templates WHERE location_id = $1 AND family_id = $2 AND status = 'active'`,
      [this.locationId, familyId],
    )
    return rows[0] ? toTemplate(rows[0]) : null
  }

  async history(familyId: string): Promise<DocumentTemplate[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM document_templates WHERE location_id = $1 AND family_id = $2 ORDER BY version DESC`,
      [this.locationId, familyId],
    )
    return rows.map(toTemplate)
  }

  async create(input: CreateTemplateInput, actor: DocActor): Promise<DocumentTemplate> {
    const id = nanoid()
    const familyId = nanoid()
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<Row>(
        `INSERT INTO document_templates (id, location_id, family_id, translation_group_id, locale, version, status, kind, title, body_md, fields, signature, signer_roles)
         VALUES ($1,$2,$3,$4,$5,1,'draft',$6,$7,$8,$9::jsonb,$10::jsonb,$11) RETURNING ${COLS}`,
        [
          id, this.locationId, familyId, nanoid(), input.locale ?? 'es', input.kind, input.title, input.bodyMd ?? '',
          JSON.stringify(input.fields ?? []), JSON.stringify(input.signature ?? { required: true, drawn: true }),
          input.signerRoles ?? ['client'],
        ],
      )
      await audit(tx, this.locationId, {
        action: 'template.created', entityType: 'document_template', entityId: id,
        details: { familyId, version: 1, kind: input.kind, locale: input.locale ?? 'es' }, ...this.auditCtx(actor),
      })
      return toTemplate(rows[0]!)
    })
  }

  async update(id: string, patch: PatchTemplateInput, actor: DocActor): Promise<TemplateResult<{ template: DocumentTemplate }>> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM document_templates WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      if (cur.status !== 'draft') return { ok: false, error: 'template_immutable' }
      const cols: Record<string, unknown> = {
        title: patch.title, kind: patch.kind, body_md: patch.bodyMd, locale: patch.locale, signer_roles: patch.signerRoles,
        fields: patch.fields === undefined ? undefined : JSON.stringify(patch.fields),
        signature: patch.signature === undefined ? undefined : JSON.stringify(patch.signature),
      }
      const names = Object.keys(cols).filter((k) => cols[k] !== undefined)
      if (names.length === 0) return { ok: true, template: toTemplate(cur) }
      const casts: Record<string, string> = { fields: '::jsonb', signature: '::jsonb' }
      const sets = names.map((k, i) => `${k} = $${i + 3}${casts[k] ?? ''}`)
      const rows = await tx.query<Row>(
        `UPDATE document_templates SET ${sets.join(', ')}, updated_at = now() WHERE location_id = $1 AND id = $2 RETURNING ${COLS}`,
        [this.locationId, id, ...names.map((k) => cols[k])],
      )
      await audit(tx, this.locationId, {
        action: 'template.updated', entityType: 'document_template', entityId: id,
        details: { familyId: cur.family_id, version: Number(cur.version), changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) },
        ...this.auditCtx(actor),
      })
      return { ok: true, template: toTemplate(rows[0]!) }
    })
  }

  /** Clone a non-draft template into the next draft version of its family. */
  async newVersion(id: string, actor: DocActor): Promise<TemplateResult<{ template: DocumentTemplate }>> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM document_templates WHERE location_id = $1 AND id = $2`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      if (cur.status === 'draft') return { ok: false, error: 'not_active' }
      // Serialize concurrent "new version" clicks on the same family.
      await tx.query('SELECT 1 FROM document_templates WHERE location_id = $1 AND family_id = $2 FOR UPDATE', [this.locationId, cur.family_id])
      const draft = (await tx.query<{ id: string }>(
        `SELECT id FROM document_templates WHERE location_id = $1 AND family_id = $2 AND status = 'draft'`,
        [this.locationId, cur.family_id],
      ))[0]
      if (draft) return { ok: false, error: 'draft_exists', draftId: draft.id }
      const max = (await tx.query<{ v: number }>(
        'SELECT max(version) AS v FROM document_templates WHERE location_id = $1 AND family_id = $2',
        [this.locationId, cur.family_id],
      ))[0]
      const nid = nanoid()
      const rows = await tx.query<Row>(
        `INSERT INTO document_templates (id, location_id, family_id, translation_group_id, locale, version, status, kind, title, body_md, fields, signature, signer_roles)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING ${COLS}`,
        [nid, this.locationId, cur.family_id, cur.translation_group_id, cur.locale, Number(max?.v ?? 0) + 1, cur.kind, cur.title, cur.body_md,
          JSON.stringify(cur.fields), JSON.stringify(cur.signature), cur.signer_roles],
      )
      await audit(tx, this.locationId, {
        action: 'template.version_created', entityType: 'document_template', entityId: nid,
        details: { familyId: cur.family_id, version: Number(max?.v ?? 0) + 1, basedOnVersion: Number(cur.version) }, ...this.auditCtx(actor),
      })
      return { ok: true, template: toTemplate(rows[0]!) }
    })
  }

  /** Put a draft in force; the version it replaces is retired in the same transaction. */
  async activate(id: string, actor: DocActor): Promise<TemplateResult<{ template: DocumentTemplate; retiredVersion: number | null }>> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM document_templates WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      if (cur.status !== 'draft') return { ok: false, error: 'not_draft' }
      const retired = await tx.query<{ id: string; version: number }>(
        `UPDATE document_templates SET status = 'retired', updated_at = now()
          WHERE location_id = $1 AND family_id = $2 AND status = 'active' RETURNING id, version`,
        [this.locationId, cur.family_id],
      )
      const rows = await tx.query<Row>(
        `UPDATE document_templates SET status = 'active', updated_at = now() WHERE location_id = $1 AND id = $2 RETURNING ${COLS}`,
        [this.locationId, id],
      )
      const retiredVersion = retired[0] ? Number(retired[0].version) : null
      if (retired[0]) {
        await audit(tx, this.locationId, {
          action: 'template.retired', entityType: 'document_template', entityId: retired[0].id,
          details: { familyId: cur.family_id, version: retiredVersion, via: 'replaced_by_activation' }, ...this.auditCtx(actor),
        })
      }
      await audit(tx, this.locationId, {
        action: 'template.activated', entityType: 'document_template', entityId: id,
        details: { familyId: cur.family_id, version: Number(cur.version), retiredVersion }, ...this.auditCtx(actor),
      })
      return { ok: true, template: toTemplate(rows[0]!), retiredVersion }
    })
  }

  async retire(id: string, actor: DocActor): Promise<TemplateResult<{ template: DocumentTemplate }>> {
    return this.db.transaction(async (tx) => {
      const cur = (await tx.query<Row>(`SELECT ${COLS} FROM document_templates WHERE location_id = $1 AND id = $2 FOR UPDATE`, [this.locationId, id]))[0]
      if (!cur) return { ok: false, error: 'not_found' }
      if (cur.status !== 'active') return { ok: false, error: 'not_active' }
      const rows = await tx.query<Row>(
        `UPDATE document_templates SET status = 'retired', updated_at = now() WHERE location_id = $1 AND id = $2 RETURNING ${COLS}`,
        [this.locationId, id],
      )
      await audit(tx, this.locationId, {
        action: 'template.retired', entityType: 'document_template', entityId: id,
        details: { familyId: cur.family_id, version: Number(cur.version), via: 'manual' }, ...this.auditCtx(actor),
      })
      return { ok: true, template: toTemplate(rows[0]!) }
    })
  }

  /** Latest version of each requested family (the active one when there is one), in the order given. */
  async resolveFamilies(familyIds: string[]): Promise<{ familyId: string; template: DocumentTemplate; active: boolean }[]> {
    if (familyIds.length === 0) return []
    const rows = await this.db.query<Row>(
      `SELECT ${COLS} FROM document_templates WHERE location_id = $1 AND family_id = ANY($2::text[])
        ORDER BY family_id, (status = 'active') DESC, version DESC`,
      [this.locationId, familyIds],
    )
    const best = new Map<string, DocumentTemplate>()
    for (const r of rows) if (!best.has(r.family_id)) best.set(r.family_id, toTemplate(r))
    return familyIds.flatMap((f) => {
      const t = best.get(f)
      return t ? [{ familyId: f, template: t, active: t.status === 'active' }] : []
    })
  }

  async existingFamilies(familyIds: string[]): Promise<Set<string>> {
    if (familyIds.length === 0) return new Set()
    const rows = await this.db.query<{ family_id: string }>(
      'SELECT DISTINCT family_id FROM document_templates WHERE location_id = $1 AND family_id = ANY($2::text[])',
      [this.locationId, familyIds],
    )
    return new Set(rows.map((r) => r.family_id))
  }
}

/**
 * Turn a product module on for one practice (the operator's alternative to hand-written SQL on the production database).
 *
 * A practice that already exists keeps its own saved list of modules, so a module added to the product later does not appear
 * on its own: it has to be added to that list. This does exactly that, once, safely:
 *  - the module name must be a real one (a typo can never be saved);
 *  - it is idempotent (running it twice changes nothing the second time);
 *  - it touches only `settings.enabledModules`, leaving every other setting alone;
 *  - the change is written to the audit log, so it is never a silent edit.
 *
 * Turning a module ON is not the same as enabling an integration: integrations (ENABLED_INTEGRATIONS) are a deployment setting,
 * and modules that depend on a third party still need the review in docs/psycrm/INTEGRACIONES.md first.
 */
import type { Database } from '../db/database'
import { audit } from './audit'
import { enabledModules, isModule, type Module } from './modules'

export type EnableModuleResult =
  | { ok: true; changed: boolean; modules: Module[] }
  | { ok: false; error: 'unknown_module' | 'unknown_practice' }

export async function enableModule(db: Database, practiceSlug: string, module: string): Promise<EnableModuleResult> {
  if (!isModule(module)) return { ok: false, error: 'unknown_module' }
  return db.transaction(async (tx): Promise<EnableModuleResult> => {
    const rows = await tx.query<{ id: string; settings: Record<string, unknown> | null }>(
      'SELECT id, settings FROM locations WHERE slug = $1 FOR UPDATE',
      [practiceSlug],
    )
    const loc = rows[0]
    if (!loc) return { ok: false, error: 'unknown_practice' }

    const hasList = Array.isArray(loc.settings?.enabledModules)
    // No saved list means the practice follows the product defaults; if the module is one of them it is already on.
    const current = enabledModules(loc.settings)
    if (current.includes(module)) return { ok: true, changed: false, modules: current }

    const next = [...current, module]
    await tx.query(
      `UPDATE locations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{enabledModules}', $2::jsonb, true) WHERE id = $1`,
      [loc.id, JSON.stringify(next)],
    )
    await audit(tx, loc.id, {
      action: 'practice.module_enabled',
      entityType: 'location',
      entityId: loc.id,
      details: { module, hadSavedList: hasList },
      actor: { type: 'system', label: 'Operations script' },
    })
    return { ok: true, changed: true, modules: next }
  })
}

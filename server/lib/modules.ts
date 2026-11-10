/**
 * Which product modules a location has turned on. PsyCRM ships the full
 * OpenLevel codebase but exposes only the modules a therapy practice needs;
 * everything else stays dark (hidden in the UI and 404 on the API) unless a
 * location lists it in `settings.enabledModules`. Pure + shared with the web
 * (see src/lib/modules.ts for the nav mapping).
 */
export const ALL_MODULES = [
  'assistant',
  'conversations',
  'contacts',
  'tags',
  'opportunities',
  'tasks',
  'calendars',
  'calls',
  'marketing',
  'templates',
  'social',
  'automations',
  'reporting',
  'sites',
  'forms',
  'surveys',
  'payments',
  'proposals',
  'reputation',
  'memberships',
  'communities',
  'blog',
  'trigger_links',
  'affiliates',
  // PsyCRM clinical modules (built in later days; listed now so the gate and
  // nav already know them).
  'documents',
  'session_notes',
  'audit',
  'billing',
] as const

export type Module = (typeof ALL_MODULES)[number]

/** What a fresh PsyCRM practice gets. */
export const PSYCRM_DEFAULT_MODULES: readonly Module[] = [
  'contacts',
  'tags',
  'opportunities',
  'tasks',
  'calendars',
  'automations',
  'reporting',
  'documents',
  'session_notes',
  'audit',
  'billing',
]

const KNOWN = new Set<string>(ALL_MODULES)

export function isModule(value: unknown): value is Module {
  return typeof value === 'string' && KNOWN.has(value)
}

/**
 * Read the enabled set from a location's `settings` jsonb. A missing or
 * malformed list falls back to the PsyCRM default; unknown names are dropped
 * (a typo can never open a route that does not exist).
 */
export function enabledModules(settings: unknown): Module[] {
  const raw =
    typeof settings === 'object' && settings !== null
      ? (settings as { enabledModules?: unknown }).enabledModules
      : undefined
  if (!Array.isArray(raw)) return [...PSYCRM_DEFAULT_MODULES]
  const seen = new Set<Module>()
  for (const m of raw) if (isModule(m)) seen.add(m)
  return [...seen]
}

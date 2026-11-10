// Module keys the API reports per location (server/lib/modules.ts is the source
// of truth). The web only needs the string union and a tiny helper.

export type ModuleKey =
  | 'assistant'
  | 'conversations'
  | 'contacts'
  | 'tags'
  | 'opportunities'
  | 'tasks'
  | 'calendars'
  | 'calls'
  | 'marketing'
  | 'templates'
  | 'social'
  | 'automations'
  | 'reporting'
  | 'sites'
  | 'forms'
  | 'surveys'
  | 'payments'
  | 'proposals'
  | 'reputation'
  | 'memberships'
  | 'communities'
  | 'blog'
  | 'trigger_links'
  | 'affiliates'
  | 'documents'
  | 'session_notes'
  | 'audit'
  | 'billing'

/** True when the location has the module on. A location object without the list
 *  (an older server) is treated as "everything on", i.e. the original product. */
export function moduleEnabled(
  location: { enabledModules?: readonly string[] } | null | undefined,
  module: ModuleKey,
): boolean {
  if (!location?.enabledModules) return true
  return location.enabledModules.includes(module)
}

/** Where to land when the requested page's module is off: the first of these the
 *  location has, else the settings page (always available). */
const LANDING_ORDER: { to: string; module: ModuleKey }[] = [
  { to: '/calendars', module: 'calendars' },
  { to: '/contacts', module: 'contacts' },
  { to: '/conversations', module: 'conversations' },
  { to: '/opportunities', module: 'opportunities' },
]

export function landingPath(location: { enabledModules?: readonly string[] } | null | undefined): string {
  return LANDING_ORDER.find((l) => moduleEnabled(location, l.module))?.to ?? '/settings'
}

import { AUDIT_CATEGORIES as WEB_CATEGORIES, AUDIT_LABELS as WEB_LABELS } from '../../src/lib/audit-vocab'
import { AUDIT_ACTIONS, AUDIT_CATEGORIES } from './audit-vocab'

test('the web mirror of the audit vocabulary matches the server (same actions, labels, categories)', () => {
  expect(WEB_LABELS).toEqual(AUDIT_ACTIONS)
  expect(WEB_CATEGORIES.map((c) => ({ key: c.key, label: c.label, prefixes: [...c.prefixes] }))).toEqual(
    AUDIT_CATEGORIES.map((c) => ({ key: c.key, label: c.label, prefixes: [...c.prefixes] })),
  )
})

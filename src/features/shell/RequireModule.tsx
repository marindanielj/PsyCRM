import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { type ModuleKey, landingPath, moduleEnabled } from '../../lib/modules'
import { useTenant } from '../../state/location'

/** Renders its page only when the current location has the module on; otherwise
 *  bounces to the location's landing page. Hiding the nav link alone would still
 *  let a typed URL open the page. */
export function RequireModule({ module, children }: { module: ModuleKey; children: ReactNode }) {
  const { current, status } = useTenant()
  if (status === 'loading') return null
  if (!moduleEnabled(current, module)) return <Navigate to={landingPath(current)} replace />
  return <>{children}</>
}

/** The index route: land on the first available page, not a hardcoded module. */
export function Landing() {
  const { current, status } = useTenant()
  if (status === 'loading') return null
  return <Navigate to={landingPath(current)} replace />
}

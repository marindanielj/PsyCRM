import type { SignerRole } from './document-vocab'

/**
 * Who signs which document is decided by the system, never by the client.
 * A guardian stands in for the client on a minor's packet, so on that packet a
 * 'guardian' signer also covers the documents written for the 'client' role.
 */
export type RequestAudience = 'adult' | 'adolescent'

export const coveredRoles = (signer: SignerRole): SignerRole[] => (signer === 'guardian' ? ['guardian', 'client'] : [signer])

export interface SignerLike {
  role: SignerRole
}

/** The signer who signs a document written for `templateRoles`: an exact role match first, then a guardian covering 'client'. */
export function assignSigner<S extends SignerLike>(templateRoles: readonly SignerRole[], signers: readonly S[]): S | null {
  const exact = signers.find((s) => templateRoles.includes(s.role))
  if (exact) return exact
  return signers.find((s) => coveredRoles(s.role).some((r) => templateRoles.includes(r))) ?? null
}

export type SignerIssue = 'client_required' | 'guardian_required' | 'client_not_allowed' | 'guardian_not_allowed' | 'minor_not_allowed' | 'duplicate_role'

/** Which people a packet needs: adults sign for themselves; a minor's packet needs the guardian (the minor's own assent is optional). */
export function validateSignerRoles(audience: RequestAudience, roles: readonly SignerRole[]): SignerIssue[] {
  const issues: SignerIssue[] = []
  if (new Set(roles).size !== roles.length) issues.push('duplicate_role')
  if (audience === 'adult') {
    if (!roles.includes('client')) issues.push('client_required')
    if (roles.includes('guardian')) issues.push('guardian_not_allowed')
    if (roles.includes('minor')) issues.push('minor_not_allowed')
  } else {
    if (!roles.includes('guardian')) issues.push('guardian_required')
    if (roles.includes('client')) issues.push('client_not_allowed')
  }
  return issues
}

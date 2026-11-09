import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { api, type Operator } from '../lib/api'

type Status = 'loading' | 'authed' | 'anon'

interface AuthValue {
  status: Status
  operator: Operator | null
  /** When the operator last chose a password (epoch ms); null = never, it is still the one the account started with. */
  passwordChangedAt: number | null
  /** Call after a successful password change so the reminder banner goes away. */
  markPasswordChanged: () => void
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

/** Resolves the current operator from the session cookie on mount, and exposes
 *  login/logout. `status` drives the route guard (loading → anon → authed). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [operator, setOperator] = useState<Operator | null>(null)
  const [passwordChangedAt, setPasswordChangedAt] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    api
      .me()
      .then((r) => {
        if (!active) return
        setOperator(r.operator)
        setPasswordChangedAt(r.passwordChangedAt ?? null)
        setStatus('authed')
      })
      .catch(() => {
        if (!active) return
        setOperator(null)
        setStatus('anon')
      })
    return () => {
      active = false
    }
  }, [])

  // api.ts raises this when a signed-in request comes back 401 (session expired
  // or idled out server-side): drop to the login screen instead of leaving every
  // page showing a confusing error.
  useEffect(() => {
    const onUnauthorized = () => {
      setOperator(null)
      setStatus('anon')
    }
    window.addEventListener('ol:unauthorized', onUnauthorized)
    return () => window.removeEventListener('ol:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password)
    setOperator(r.operator)
    setPasswordChangedAt(r.passwordChangedAt ?? null)
    setStatus('authed')
  }, [])

  const logout = useCallback(async () => {
    await api.logout().catch(() => {})
    setOperator(null)
    setStatus('anon')
  }, [])

  const markPasswordChanged = useCallback(() => setPasswordChangedAt(Date.now()), [])

  return <AuthContext.Provider value={{ status, operator, passwordChangedAt, markPasswordChanged, login, logout }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

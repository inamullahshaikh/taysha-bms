import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { api, ApiError, setUnauthorizedHandler } from './api'

export type Action = 'view' | 'create' | 'edit' | 'archive' | 'approve' | 'export'
export type User = { id: number; name: string; email: string; is_owner: boolean; is_active: boolean; totp_enabled: boolean }
type Session = { user: User; access: Record<string, string[]> }

type Ctx = {
  user: User
  access: Record<string, string[]>
  can: (feature: string, action?: Action) => boolean
  refresh: () => Promise<unknown>
}

const AuthCtx = createContext<Ctx | null>(null)

/** Loads the session; children render only when signed in. The backend still enforces every grant. */
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async (): Promise<Session | null> => {
      try {
        const user = await api.get<User>('/auth/me')
        const access = await api.get<Record<string, string[]>>('/auth/me/access')
        return { user, access }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function AuthProvider({ session, children }: { session: Session; children: ReactNode }) {
  const qc = useQueryClient()
  useEffect(() => {
    setUnauthorizedHandler(() => qc.setQueryData(['session'], null))
  }, [qc])
  const can = (feature: string, action: Action = 'view') =>
    session.user.is_owner || (session.access[feature]?.includes(action) ?? false)
  return (
    <AuthCtx.Provider
      value={{ ...session, can, refresh: () => qc.invalidateQueries({ queryKey: ['session'] }) }}
    >
      {children}
    </AuthCtx.Provider>
  )
}

export function useAuth() {
  const c = useContext(AuthCtx)
  if (!c) throw new Error('useAuth outside AuthProvider')
  return c
}

export const useCan = () => useAuth().can

/** Renders children only with the grant. */
export function Can({ feature, action = 'view', children }: { feature: string; action?: Action; children: ReactNode }) {
  return useCan()(feature, action) ? <>{children}</> : null
}

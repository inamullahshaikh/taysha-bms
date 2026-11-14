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

/**
 * Features whose catalogue lacks some actions (mirror of backend app/auth/features.py).
 * Like the backend, a missing create/archive falls back to edit and a missing export to view.
 * Features not listed have every CRUD action.
 */
const CATALOGUE: Record<string, string> = {
  access_management: 'view edit export', settings: 'view edit', audit: 'view export', product_prices: 'edit',
  product_costs: 'view edit', orders: 'view create edit export', order_pricing: 'edit', order_payments: 'view create',
  invoices: 'view create edit export', expenses: 'view create edit approve export',
  inventory: 'view create edit approve export', purchasing: 'view create edit approve export',
  supplier_bills: 'view create edit export', returns: 'view create edit export', complaints: 'view create edit export',
  recipes: 'view edit approve', production: 'view create edit export', quality: 'view create edit export',
  pos: 'view create edit export', distribution: 'view edit', marketing: 'view edit',
  accounting: 'view create edit approve export', partners: 'view edit approve', approvals: 'view approve',
  documents: 'view create edit archive', confidential_documents: 'view', assets: 'view create edit archive',
  reports: 'view create edit archive', rnd: 'view create edit archive', automation: 'view edit',
}
const FALLBACK: Partial<Record<Action, Action>> = { create: 'edit', archive: 'edit', export: 'view' }

function effective(feature: string, action: Action): Action {
  const actions = CATALOGUE[feature]
  return actions && !actions.split(' ').includes(action) && FALLBACK[action] ? FALLBACK[action]! : action
}

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
    session.user.is_owner || (session.access[feature]?.includes(effective(feature, action)) ?? false)
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

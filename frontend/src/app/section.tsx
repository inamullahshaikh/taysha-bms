import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Action } from '../lib/auth'

/** "orders" (view), "expenses.approve", or a list where any one is enough. "*" = any signed-in user. */
export type Access = string | string[]

export type Page = {
  path: string
  label: string
  access: Access
  element: ReactNode
}

/**
 * A sidebar entry. `pages` become tabs under one header; `routes` are record pages (no tabs).
 * Record paths mirror the API paths (/orders/12, /purchase-orders/3) so links in notifications work as-is.
 */
export type Section = {
  key: string
  label: string
  icon: LucideIcon
  pages: Page[]
  routes?: Page[]
  subtitle?: string
  /** sidebar group; a thin divider separates groups */
  group: 'main' | 'ops' | 'growth' | 'admin'
  /** pages render their own header (no section title/tabs) */
  bare?: boolean
}

export function allowed(can: (f: string, a?: Action) => boolean, access: Access): boolean {
  return (Array.isArray(access) ? access : [access]).some((a) => {
    if (a === '*') return true
    const [f, act] = a.split('.')
    return can(f, (act as Action) ?? 'view')
  })
}

import { LayoutDashboard } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Dashboard = lazy(() => import('../pages/dashboard/Dashboard'))

export const dashboard: Section = {
  key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'main', bare: true,
  pages: [{ path: '/', label: 'Overview', access: '*', element: <Dashboard /> }],
}

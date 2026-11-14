import { LayoutDashboard } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Home = lazy(() => import('../pages/simple/Home'))
const QuickOrder = lazy(() => import('../pages/simple/QuickOrder'))
const QuickExpense = lazy(() => import('../pages/simple/QuickExpense'))

export const dashboard: Section = {
  key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'main', bare: true,
  pages: [{ path: '/', label: 'Overview', access: '*', element: <Home /> }],
  routes: [
    { path: '/quick/order', label: 'New order', access: 'orders.create', element: <QuickOrder /> },
    { path: '/quick/expense', label: 'Add expense', access: 'expenses.create', element: <QuickExpense /> },
  ],
}

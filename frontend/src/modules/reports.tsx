import { ChartColumnBig } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Sales = lazy(() => import('../pages/reports/Sales'))
const Expenses = lazy(() => import('../pages/reports/Expenses'))
const Compare = lazy(() => import('../pages/reports/Compare'))
const StockHealth = lazy(() => import('../pages/reports/StockHealth'))
const Forecast = lazy(() => import('../pages/reports/Forecast'))
const Scheduled = lazy(() => import('../pages/reports/Scheduled'))

export const reports: Section = {
  key: 'reports', label: 'Reports', icon: ChartColumnBig, group: 'growth',
  pages: [
    { path: '/reports/sales', label: 'Sales', access: 'orders', element: <Sales /> },
    { path: '/reports/expenses', label: 'Expenses', access: 'expenses', element: <Expenses /> },
    { path: '/reports/compare', label: 'Compare periods', access: 'orders', element: <Compare /> },
    { path: '/reports/stock', label: 'Stock health', access: 'inventory', element: <StockHealth /> },
    { path: '/forecast', label: 'Forecast', access: ['orders', 'production', 'purchasing'], element: <Forecast /> },
    { path: '/scheduled-reports', label: 'Scheduled', access: 'reports', element: <Scheduled /> },
  ],
}

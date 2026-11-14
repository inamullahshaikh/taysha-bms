import { ChartColumnBig } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const reports: Section = {
  key: 'reports', label: 'Reports', icon: ChartColumnBig, group: 'growth',
  pages: [
    { path: '/reports/sales', label: 'Sales', access: 'orders', element: <Stub name="Sales report" /> },
    { path: '/reports/expenses', label: 'Expenses', access: 'expenses', element: <Stub name="Expense report" /> },
    { path: '/reports/compare', label: 'Compare periods', access: 'orders', element: <Stub name="Compare" /> },
    { path: '/reports/stock', label: 'Stock health', access: 'inventory', element: <Stub name="Stock health" /> },
    { path: '/forecast', label: 'Forecast', access: ['orders', 'production', 'inventory'], element: <Stub name="Forecast" /> },
    { path: '/scheduled-reports', label: 'Scheduled', access: 'reports', element: <Stub name="Scheduled reports" /> },
  ],
}

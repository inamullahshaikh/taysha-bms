import { Landmark } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const finance: Section = {
  key: 'finance', label: 'Finance', icon: Landmark, group: 'growth',
  pages: [
    { path: '/finance', label: 'Overview', access: 'accounting', element: <Stub name="Finance overview" /> },
    { path: '/expenses', label: 'Expenses', access: ['expenses', 'expenses.create'], element: <Stub name="Expenses" /> },
    { path: '/receivables', label: 'Receivables & payables', access: ['invoices', 'supplier_bills'], element: <Stub name="Receivables" /> },
    { path: '/accounting/journal', label: 'Journal', access: 'accounting', element: <Stub name="Journal" /> },
    { path: '/accounting/accounts', label: 'Accounts', access: 'accounting', element: <Stub name="Accounts" /> },
    { path: '/budgets', label: 'Budgets', access: 'accounting', element: <Stub name="Budgets" /> },
    { path: '/assets', label: 'Assets', access: 'assets', element: <Stub name="Assets" /> },
    { path: '/partners', label: 'Partners', access: 'partners', element: <Stub name="Partners" /> },
  ],
  routes: [
    { path: '/expenses/:id', label: 'Expense', access: ['expenses', 'expenses.create'], element: <Stub name="Expense" /> },
    { path: '/accounting/journal/:id', label: 'Journal entry', access: 'accounting', element: <Stub name="Journal entry" /> },
    { path: '/accounting/ledger/:id', label: 'Ledger', access: 'accounting', element: <Stub name="Ledger" /> },
    { path: '/budgets/:id', label: 'Budget', access: 'accounting', element: <Stub name="Budget" /> },
    { path: '/assets/:id', label: 'Asset', access: 'assets', element: <Stub name="Asset" /> },
    { path: '/partners/:id', label: 'Partner', access: 'partners', element: <Stub name="Partner" /> },
  ],
}

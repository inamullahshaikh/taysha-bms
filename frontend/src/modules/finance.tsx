import { Landmark } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Overview = lazy(() => import('../pages/finance/Overview'))
const Expenses = lazy(() => import('../pages/finance/Expenses'))
const ExpenseDetail = lazy(() => import('../pages/finance/ExpenseDetail'))
const Receivables = lazy(() => import('../pages/finance/Receivables'))
const Journal = lazy(() => import('../pages/finance/Accounting'))
const JournalEntry = lazy(() => import('../pages/finance/Accounting').then((m) => ({ default: m.JournalEntry })))
const Accounts = lazy(() => import('../pages/finance/Accounting').then((m) => ({ default: m.Accounts })))
const Ledger = lazy(() => import('../pages/finance/Accounting').then((m) => ({ default: m.Ledger })))
const Budgets = lazy(() => import('../pages/finance/Budgets'))
const BudgetDetail = lazy(() => import('../pages/finance/Budgets').then((m) => ({ default: m.BudgetDetail })))
const Assets = lazy(() => import('../pages/finance/Assets'))
const AssetDetail = lazy(() => import('../pages/finance/Assets').then((m) => ({ default: m.AssetDetail })))
const Partners = lazy(() => import('../pages/finance/Partners'))
const PartnerDetail = lazy(() => import('../pages/finance/Partners').then((m) => ({ default: m.PartnerDetail })))

export const finance: Section = {
  key: 'finance', label: 'Finance', icon: Landmark, group: 'growth',
  pages: [
    { path: '/finance', label: 'Overview', access: 'accounting', element: <Overview /> },
    { path: '/expenses', label: 'Expenses', access: ['expenses', 'expenses.create'], element: <Expenses /> },
    { path: '/receivables', label: 'Receivables & payables', access: ['invoices', 'supplier_bills'], element: <Receivables /> },
    { path: '/accounting/journal', label: 'Journal', access: 'accounting', element: <Journal /> },
    { path: '/accounting/accounts', label: 'Accounts', access: 'accounting', element: <Accounts /> },
    { path: '/budgets', label: 'Budgets', access: 'accounting', element: <Budgets /> },
    { path: '/assets', label: 'Assets', access: 'assets', element: <Assets /> },
    { path: '/partners', label: 'Partners', access: 'partners', element: <Partners /> },
  ],
  routes: [
    { path: '/expenses/:id', label: 'Expense', access: ['expenses', 'expenses.create'], element: <ExpenseDetail /> },
    { path: '/accounting/journal/:id', label: 'Journal entry', access: 'accounting', element: <JournalEntry /> },
    { path: '/accounting/ledger/:id', label: 'Ledger', access: 'accounting', element: <Ledger /> },
    { path: '/budgets/:id', label: 'Budget', access: 'accounting', element: <BudgetDetail /> },
    { path: '/assets/:id', label: 'Asset', access: 'assets', element: <AssetDetail /> },
    { path: '/partners/:id', label: 'Partner', access: 'partners', element: <PartnerDetail /> },
  ],
}

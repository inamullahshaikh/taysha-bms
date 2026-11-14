import { Warehouse } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Stock = lazy(() => import('../pages/inventory/Stock'))
const Movements = lazy(() => import('../pages/inventory/Movements'))
const Batches = lazy(() => import('../pages/inventory/Batches'))
const BatchPage = lazy(() => import('../pages/inventory/Batches').then((m) => ({ default: m.BatchPage })))
const Transfers = lazy(() => import('../pages/inventory/Transfers'))
const TransferPage = lazy(() => import('../pages/inventory/Transfers').then((m) => ({ default: m.TransferPage })))
const Counts = lazy(() => import('../pages/inventory/Counts'))
const CountPage = lazy(() => import('../pages/inventory/Counts').then((m) => ({ default: m.CountPage })))
const Valuation = lazy(() => import('../pages/inventory/Valuation'))
const Warehouses = lazy(() => import('../pages/inventory/Warehouses'))

export const inventory: Section = {
  key: 'inventory', label: 'Inventory', icon: Warehouse, group: 'ops',
  pages: [
    { path: '/stock', label: 'Stock', access: 'inventory', element: <Stock /> },
    { path: '/stock/movements', label: 'Movements', access: 'inventory', element: <Movements /> },
    { path: '/stock/batches', label: 'Batches', access: 'inventory', element: <Batches /> },
    { path: '/stock/transfers', label: 'Transfers', access: 'inventory', element: <Transfers /> },
    { path: '/stock/counts', label: 'Counts', access: 'inventory', element: <Counts /> },
    { path: '/stock/valuation', label: 'Valuation', access: 'product_costs', element: <Valuation /> },
    { path: '/warehouses', label: 'Warehouses', access: 'inventory', element: <Warehouses /> },
  ],
  routes: [
    { path: '/stock/batches/:id', label: 'Batch', access: 'inventory', element: <BatchPage /> },
    { path: '/stock/transfers/:id', label: 'Transfer', access: 'inventory', element: <TransferPage /> },
    { path: '/stock/counts/:id', label: 'Count', access: 'inventory', element: <CountPage /> },
  ],
}

import { Warehouse } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const inventory: Section = {
  key: 'inventory', label: 'Inventory', icon: Warehouse, group: 'ops',
  pages: [
    { path: '/stock', label: 'Stock', access: 'inventory', element: <Stub name="Stock" /> },
    { path: '/stock/movements', label: 'Movements', access: 'inventory', element: <Stub name="Movements" /> },
    { path: '/stock/batches', label: 'Batches', access: 'inventory', element: <Stub name="Batches" /> },
    { path: '/stock/transfers', label: 'Transfers', access: 'inventory', element: <Stub name="Transfers" /> },
    { path: '/stock/counts', label: 'Counts', access: 'inventory', element: <Stub name="Counts" /> },
    { path: '/stock/valuation', label: 'Valuation', access: 'inventory', element: <Stub name="Valuation" /> },
    { path: '/warehouses', label: 'Warehouses', access: 'inventory', element: <Stub name="Warehouses" /> },
  ],
  routes: [
    { path: '/stock/batches/:id', label: 'Batch', access: 'inventory', element: <Stub name="Batch" /> },
    { path: '/stock/transfers/:id', label: 'Transfer', access: 'inventory', element: <Stub name="Transfer" /> },
    { path: '/stock/counts/:id', label: 'Count', access: 'inventory', element: <Stub name="Count" /> },
  ],
}

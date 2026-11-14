import { Truck } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const purchasing: Section = {
  key: 'purchasing', label: 'Purchasing', icon: Truck, group: 'ops',
  pages: [
    { path: '/purchase-orders', label: 'Purchase orders', access: 'purchasing', element: <Stub name="Purchase orders" /> },
    { path: '/purchase-requests', label: 'Requests', access: 'purchasing', element: <Stub name="Requests" /> },
    { path: '/goods-receipts', label: 'Receipts', access: 'purchasing', element: <Stub name="Receipts" /> },
    { path: '/supplier-bills', label: 'Bills', access: 'supplier_bills', element: <Stub name="Bills" /> },
    { path: '/suppliers', label: 'Suppliers', access: 'suppliers', element: <Stub name="Suppliers" /> },
    { path: '/purchasing/price-changes', label: 'Price changes', access: 'purchasing', element: <Stub name="Price changes" /> },
  ],
  routes: [
    { path: '/purchase-orders/new', label: 'New purchase order', access: 'purchasing.create', element: <Stub name="New PO" /> },
    { path: '/purchase-orders/:id', label: 'Purchase order', access: 'purchasing', element: <Stub name="Purchase order" /> },
    { path: '/purchase-requests/:id', label: 'Purchase request', access: 'purchasing', element: <Stub name="Purchase request" /> },
    { path: '/goods-receipts/:id', label: 'Goods receipt', access: 'purchasing', element: <Stub name="Goods receipt" /> },
    { path: '/supplier-bills/:id', label: 'Bill', access: 'supplier_bills', element: <Stub name="Bill" /> },
    { path: '/suppliers/:id', label: 'Supplier', access: 'suppliers', element: <Stub name="Supplier" /> },
  ],
}

import { Truck } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const POs = lazy(() => import('../pages/purchasing/PurchaseOrders'))
const PO = lazy(() => import('../pages/purchasing/PurchaseOrders').then((m) => ({ default: m.PurchaseOrderPage })))
const Requests = lazy(() => import('../pages/purchasing/Requests'))
const Request = lazy(() => import('../pages/purchasing/Requests').then((m) => ({ default: m.RequestPage })))
const Receipts = lazy(() => import('../pages/purchasing/Receipts'))
const Receipt = lazy(() => import('../pages/purchasing/Receipts').then((m) => ({ default: m.ReceiptPage })))
const Bills = lazy(() => import('../pages/purchasing/Bills'))
const Bill = lazy(() => import('../pages/purchasing/Bills').then((m) => ({ default: m.BillPage })))
const Suppliers = lazy(() => import('../pages/purchasing/Suppliers'))
const Supplier = lazy(() => import('../pages/purchasing/Suppliers').then((m) => ({ default: m.SupplierPage })))
const PriceChanges = lazy(() => import('../pages/purchasing/PriceChanges'))

export const purchasing: Section = {
  key: 'purchasing', label: 'Purchasing', icon: Truck, group: 'ops',
  pages: [
    { path: '/purchase-orders', label: 'Purchase orders', access: 'purchasing', element: <POs /> },
    { path: '/purchase-requests', label: 'Requests', access: 'purchasing', element: <Requests /> },
    { path: '/goods-receipts', label: 'Receipts', access: 'purchasing', element: <Receipts /> },
    { path: '/supplier-bills', label: 'Bills', access: 'supplier_bills', element: <Bills /> },
    { path: '/suppliers', label: 'Suppliers', access: 'suppliers', element: <Suppliers /> },
    { path: '/purchasing/price-changes', label: 'Price changes', access: 'purchasing', element: <PriceChanges /> },
  ],
  routes: [
    { path: '/purchase-orders/:id', label: 'Purchase order', access: 'purchasing', element: <PO /> },
    { path: '/purchase-requests/:id', label: 'Purchase request', access: 'purchasing', element: <Request /> },
    { path: '/goods-receipts/:id', label: 'Goods receipt', access: 'purchasing', element: <Receipt /> },
    { path: '/supplier-bills/:id', label: 'Bill', access: 'supplier_bills', element: <Bill /> },
    { path: '/suppliers/:id', label: 'Supplier', access: 'suppliers', element: <Supplier /> },
  ],
}

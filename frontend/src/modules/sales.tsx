import { ShoppingBag } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const sales: Section = {
  key: 'sales', label: 'Sales', icon: ShoppingBag, group: 'ops',
  pages: [
    { path: '/orders', label: 'Orders', access: 'orders', element: <Stub name="Orders" /> },
    { path: '/documents', label: 'Invoices & quotes', access: 'invoices', element: <Stub name="Invoices" /> },
    { path: '/customers', label: 'Customers', access: 'customers', element: <Stub name="Customers" /> },
    { path: '/returns', label: 'Returns', access: 'returns', element: <Stub name="Returns" /> },
    { path: '/complaints', label: 'Complaints', access: 'complaints', element: <Stub name="Complaints" /> },
    { path: '/discount-codes', label: 'Discount codes', access: 'discount_codes', element: <Stub name="Discount codes" /> },
    { path: '/recurring-orders', label: 'Wholesale', access: 'orders', element: <Stub name="Wholesale" /> },
    { path: '/routes', label: 'Deliveries', access: 'distribution', element: <Stub name="Deliveries" /> },
  ],
  routes: [
    { path: '/orders/new', label: 'New order', access: 'orders.create', element: <Stub name="New order" /> },
    { path: '/orders/:id', label: 'Order', access: 'orders', element: <Stub name="Order" /> },
    { path: '/documents/:id', label: 'Document', access: 'invoices', element: <Stub name="Document" /> },
    { path: '/customers/:id', label: 'Customer', access: 'customers', element: <Stub name="Customer" /> },
    { path: '/returns/:id', label: 'Return', access: 'returns', element: <Stub name="Return" /> },
    { path: '/routes/:id', label: 'Route', access: 'distribution', element: <Stub name="Route" /> },
  ],
}

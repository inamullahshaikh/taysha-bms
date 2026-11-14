import { Package } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const products: Section = {
  key: 'products', label: 'Products', icon: Package, group: 'ops',
  pages: [
    { path: '/products', label: 'Products', access: 'products', element: <Stub name="Products" /> },
    { path: '/product-categories', label: 'Categories', access: 'products', element: <Stub name="Categories" /> },
    { path: '/labels', label: 'Labels', access: ['products', 'inventory'], element: <Stub name="Labels" /> },
  ],
  routes: [
    { path: '/products/:id', label: 'Product', access: 'products', element: <Stub name="Product" /> },
  ],
}

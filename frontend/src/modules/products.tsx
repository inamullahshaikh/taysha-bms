import { Package } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Products = lazy(() => import('../pages/products/Products'))
const ProductDetail = lazy(() => import('../pages/products/ProductDetail'))
const Categories = lazy(() => import('../pages/products/Categories'))
const Labels = lazy(() => import('../pages/products/Labels'))

export const products: Section = {
  key: 'products', label: 'Products', icon: Package, group: 'ops',
  pages: [
    { path: '/products', label: 'Products', access: 'products', element: <Products /> },
    { path: '/product-categories', label: 'Categories', access: 'products', element: <Categories /> },
    { path: '/labels', label: 'Labels', access: 'products', element: <Labels /> },
  ],
  routes: [
    { path: '/products/:id', label: 'Product', access: 'products', element: <ProductDetail /> },
  ],
}

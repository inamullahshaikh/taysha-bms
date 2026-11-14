import { CookingPot } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

const Orders = lazy(() => import('../pages/production/Orders'))
const Order = lazy(() => import('../pages/production/Order'))
const Plan = lazy(() => import('../pages/production/Plan'))
const Recipes = lazy(() => import('../pages/production/Recipes'))
const Recipe = lazy(() => import('../pages/production/Recipe'))

export const production: Section = {
  key: 'production', label: 'Production', icon: CookingPot, group: 'ops',
  pages: [
    { path: '/production-orders', label: 'Production orders', access: 'production', element: <Orders /> },
    { path: '/production/plan', label: 'Plan', access: 'production', element: <Plan /> },
    { path: '/recipes', label: 'Recipes', access: 'recipes', element: <Recipes /> },
    { path: '/qc/checks', label: 'Quality', access: 'quality', element: <Stub name="Quality" /> },
    { path: '/recalls', label: 'Recalls & trace', access: 'quality', element: <Stub name="Recalls" /> },
    { path: '/food-safety', label: 'Food safety', access: 'quality', element: <Stub name="Food safety" /> },
    { path: '/rnd/ideas', label: 'R&D', access: 'rnd', element: <Stub name="R&D" /> },
  ],
  routes: [
    { path: '/production-orders/:id', label: 'Production order', access: 'production', element: <Order /> },
    { path: '/recipes/:id', label: 'Recipe', access: 'recipes', element: <Recipe /> },
    { path: '/qc/checks/:id', label: 'QC check', access: 'quality', element: <Stub name="QC check" /> },
    { path: '/recalls/:id', label: 'Recall', access: 'quality', element: <Stub name="Recall" /> },
    { path: '/rnd/ideas/:id', label: 'Idea', access: 'rnd', element: <Stub name="Idea" /> },
  ],
}

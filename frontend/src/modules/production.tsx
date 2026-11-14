import { CookingPot } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Orders = lazy(() => import('../pages/production/Orders'))
const Order = lazy(() => import('../pages/production/Order'))
const Plan = lazy(() => import('../pages/production/Plan'))
const Recipes = lazy(() => import('../pages/production/Recipes'))
const Recipe = lazy(() => import('../pages/production/Recipe'))
const Quality = lazy(() => import('../pages/production/Quality'))
const QCCheck = lazy(() => import('../pages/production/Quality').then((m) => ({ default: m.QCCheck })))
const Recalls = lazy(() => import('../pages/production/Recalls'))
const Recall = lazy(() => import('../pages/production/Recalls').then((m) => ({ default: m.Recall })))
const FoodSafety = lazy(() => import('../pages/production/FoodSafety'))
const Ideas = lazy(() => import('../pages/production/Rnd'))
const Idea = lazy(() => import('../pages/production/Rnd').then((m) => ({ default: m.Idea })))

export const production: Section = {
  key: 'production', label: 'Production', icon: CookingPot, group: 'ops',
  pages: [
    { path: '/production-orders', label: 'Production orders', access: 'production', element: <Orders /> },
    { path: '/production/plan', label: 'Plan', access: 'production', element: <Plan /> },
    { path: '/recipes', label: 'Recipes', access: 'recipes', element: <Recipes /> },
    { path: '/qc/checks', label: 'Quality', access: 'quality', element: <Quality /> },
    { path: '/recalls', label: 'Recalls & trace', access: 'quality', element: <Recalls /> },
    { path: '/food-safety', label: 'Food safety', access: 'quality', element: <FoodSafety /> },
    { path: '/rnd/ideas', label: 'R&D', access: 'rnd', element: <Ideas /> },
  ],
  routes: [
    { path: '/production-orders/:id', label: 'Production order', access: 'production', element: <Order /> },
    { path: '/recipes/:id', label: 'Recipe', access: 'recipes', element: <Recipe /> },
    { path: '/qc/checks/:id', label: 'QC check', access: 'quality', element: <QCCheck /> },
    { path: '/recalls/:id', label: 'Recall', access: 'quality', element: <Recall /> },
    { path: '/rnd/ideas/:id', label: 'Idea', access: 'rnd', element: <Idea /> },
  ],
}

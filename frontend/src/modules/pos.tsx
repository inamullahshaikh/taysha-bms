import { Store } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Events = lazy(() => import('../pages/pos/Events'))
const EventDetail = lazy(() => import('../pages/pos/Events').then((m) => ({ default: m.EventDetail })))
const Register = lazy(() => import('../pages/pos/Register'))

export const pos: Section = {
  key: 'pos', label: 'Point of sale', icon: Store, group: 'ops', subtitle: 'Stalls, pop-ups and events',
  pages: [{ path: '/pos', label: 'Events', access: 'pos', element: <Events /> }],
  routes: [
    { path: '/pos/events/:id', label: 'Event', access: 'pos', element: <EventDetail /> },
    { path: '/pos/register/:sessionId', label: 'Register', access: 'pos.create', element: <Register /> },
  ],
}

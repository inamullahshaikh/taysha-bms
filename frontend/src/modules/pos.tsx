import { Store } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const pos: Section = {
  key: 'pos', label: 'Point of sale', icon: Store, group: 'ops', subtitle: 'Stalls, pop-ups and events',
  pages: [{ path: '/pos', label: 'Events', access: 'pos', element: <Stub name="Events" /> }],
  routes: [
    { path: '/pos/events/:id', label: 'Event', access: 'pos', element: <Stub name="Event" /> },
    { path: '/pos/register/:sessionId', label: 'Register', access: 'pos.create', element: <Stub name="Register" /> },
  ],
}

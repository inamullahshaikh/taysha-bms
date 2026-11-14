import { Megaphone } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const marketing: Section = {
  key: 'marketing', label: 'Marketing', icon: Megaphone, group: 'growth',
  pages: [
    { path: '/marketing', label: 'Overview', access: 'marketing', element: <Stub name="Marketing overview" /> },
    { path: '/campaigns', label: 'Campaigns', access: 'marketing', element: <Stub name="Campaigns" /> },
    { path: '/content', label: 'Content', access: 'marketing', element: <Stub name="Content" /> },
    { path: '/influencers', label: 'Influencers', access: 'marketing', element: <Stub name="Influencers" /> },
    { path: '/leads', label: 'Leads', access: 'customers', element: <Stub name="Leads" /> },
    { path: '/follow-ups', label: 'Follow-ups', access: 'customers', element: <Stub name="Follow-ups" /> },
    { path: '/segments', label: 'Segments', access: 'customers', element: <Stub name="Segments" /> },
  ],
  routes: [
    { path: '/campaigns/:id', label: 'Campaign', access: 'marketing', element: <Stub name="Campaign" /> },
    { path: '/leads/:id', label: 'Lead', access: 'customers', element: <Stub name="Lead" /> },
    { path: '/segments/:id', label: 'Segment', access: 'customers', element: <Stub name="Segment" /> },
  ],
}

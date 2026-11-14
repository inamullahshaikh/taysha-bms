import { Megaphone } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Overview = lazy(() => import('../pages/marketing/Overview'))
const Campaigns = lazy(() => import('../pages/marketing/Campaigns'))
const CampaignDetail = lazy(() => import('../pages/marketing/Campaigns').then((m) => ({ default: m.CampaignDetail })))
const Content = lazy(() => import('../pages/marketing/Content'))
const Influencers = lazy(() => import('../pages/marketing/Influencers'))
const Leads = lazy(() => import('../pages/marketing/Crm'))
const LeadDetail = lazy(() => import('../pages/marketing/Crm').then((m) => ({ default: m.LeadDetail })))
const FollowUps = lazy(() => import('../pages/marketing/Crm').then((m) => ({ default: m.FollowUps })))
const Segments = lazy(() => import('../pages/marketing/Crm').then((m) => ({ default: m.Segments })))
const SegmentDetail = lazy(() => import('../pages/marketing/Crm').then((m) => ({ default: m.SegmentDetail })))

export const marketing: Section = {
  key: 'marketing', label: 'Marketing', icon: Megaphone, group: 'growth',
  pages: [
    { path: '/marketing', label: 'Overview', access: 'marketing', element: <Overview /> },
    { path: '/campaigns', label: 'Campaigns', access: 'marketing', element: <Campaigns /> },
    { path: '/content', label: 'Content', access: 'marketing', element: <Content /> },
    { path: '/influencers', label: 'Influencers', access: 'marketing', element: <Influencers /> },
    { path: '/leads', label: 'Leads', access: 'customers', element: <Leads /> },
    { path: '/follow-ups', label: 'Follow-ups', access: 'customers', element: <FollowUps /> },
    { path: '/segments', label: 'Segments', access: 'customers', element: <Segments /> },
  ],
  routes: [
    { path: '/campaigns/:id', label: 'Campaign', access: 'marketing', element: <CampaignDetail /> },
    { path: '/leads/:id', label: 'Lead', access: 'customers', element: <LeadDetail /> },
    { path: '/segments/:id', label: 'Segment', access: 'customers', element: <SegmentDetail /> },
  ],
}

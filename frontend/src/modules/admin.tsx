import { Settings } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const admin: Section = {
  key: 'admin', label: 'Admin', icon: Settings, group: 'admin',
  pages: [
    { path: '/users', label: 'Users & access', access: 'access_management', element: <Stub name="Users" /> },
    { path: '/settings', label: 'Settings', access: 'settings', element: <Stub name="Settings" /> },
    { path: '/integrations', label: 'Shopify', access: 'settings', element: <Stub name="Shopify" /> },
    { path: '/automation', label: 'Automation', access: 'automation', element: <Stub name="Automation" /> },
    { path: '/audit', label: 'Audit log', access: 'audit', element: <Stub name="Audit log" /> },
  ],
  routes: [
    { path: '/users/:id', label: 'User', access: 'access_management', element: <Stub name="User" /> },
    { path: '/account', label: 'Account', access: '*', element: <Stub name="Account" /> },
    { path: '/notifications', label: 'Notifications', access: '*', element: <Stub name="Notifications" /> },
  ],
}

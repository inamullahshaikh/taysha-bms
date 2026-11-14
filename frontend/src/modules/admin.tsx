import { Settings as SettingsIcon } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Users = lazy(() => import('../pages/admin/Users'))
const UserPage = lazy(() => import('../pages/admin/UserPage'))
const Settings = lazy(() => import('../pages/admin/Settings'))
const Shopify = lazy(() => import('../pages/admin/Shopify'))
const Automation = lazy(() => import('../pages/admin/Automation'))
const Audit = lazy(() => import('../pages/admin/Audit'))
const Account = lazy(() => import('../pages/admin/Account'))
const Notifications = lazy(() => import('../pages/admin/Notifications'))

export const admin: Section = {
  key: 'admin', label: 'Admin', icon: SettingsIcon, group: 'admin',
  pages: [
    { path: '/users', label: 'Users & access', access: 'access_management', element: <Users /> },
    { path: '/settings', label: 'Settings', access: 'settings', element: <Settings /> },
    { path: '/integrations', label: 'Shopify', access: 'settings', element: <Shopify /> },
    { path: '/automation', label: 'Automation', access: 'automation', element: <Automation /> },
    { path: '/audit', label: 'Audit log', access: 'audit', element: <Audit /> },
  ],
  routes: [
    { path: '/users/:id', label: 'User', access: 'access_management', element: <UserPage /> },
    { path: '/account', label: 'Account', access: '*', element: <Account /> },
    { path: '/notifications', label: 'Notifications', access: '*', element: <Notifications /> },
  ],
}

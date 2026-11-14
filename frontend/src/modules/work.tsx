import { Inbox } from 'lucide-react'
import type { Section } from '../app/section'
import { Stub } from './_stub'

export const work: Section = {
  key: 'work', label: 'Work', icon: Inbox, group: 'main', subtitle: 'Approvals, tasks and shared documents',
  pages: [
    { path: '/approvals', label: 'Approvals', access: ['approvals', 'expenses.approve', 'purchasing.approve', 'accounting.approve', 'partners.approve'], element: <Stub name="Approvals inbox" /> },
    { path: '/tasks', label: 'Tasks', access: 'tasks', element: <Stub name="Tasks" /> },
    { path: '/projects', label: 'Projects', access: 'tasks', element: <Stub name="Projects" /> },
    { path: '/document-records', label: 'Documents', access: 'documents', element: <Stub name="Documents" /> },
  ],
  routes: [
    { path: '/tasks/:id', label: 'Task', access: 'tasks', element: <Stub name="Task" /> },
    { path: '/projects/:id', label: 'Project', access: 'tasks', element: <Stub name="Project" /> },
    { path: '/document-records/:id', label: 'Document', access: 'documents', element: <Stub name="Document" /> },
  ],
}

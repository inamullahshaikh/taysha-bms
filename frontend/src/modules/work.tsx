import { Inbox } from 'lucide-react'
import { lazy } from 'react'
import type { Section } from '../app/section'

const Approvals = lazy(() => import('../pages/work/Approvals'))
const Tasks = lazy(() => import('../pages/work/Tasks'))
const TaskPage = lazy(() => import('../pages/work/TaskPage'))
const Projects = lazy(() => import('../pages/work/Projects'))
const ProjectPage = lazy(() => import('../pages/work/Projects').then((m) => ({ default: m.ProjectPage })))
const Documents = lazy(() => import('../pages/work/Documents'))
const DocumentPage = lazy(() => import('../pages/work/Documents').then((m) => ({ default: m.DocumentPage })))

export const work: Section = {
  key: 'work', label: 'Work', icon: Inbox, group: 'main', subtitle: 'Approvals, tasks and shared documents',
  pages: [
    { path: '/approvals', label: 'Approvals', access: ['approvals.approve', 'expenses.approve', 'purchasing.approve', 'accounting.approve', 'partners.approve'], element: <Approvals /> },
    { path: '/tasks', label: 'Tasks', access: 'tasks', element: <Tasks /> },
    { path: '/projects', label: 'Projects', access: 'tasks', element: <Projects /> },
    { path: '/document-records', label: 'Documents', access: 'documents', element: <Documents /> },
  ],
  routes: [
    { path: '/tasks/:id', label: 'Task', access: 'tasks', element: <TaskPage /> },
    { path: '/projects/:id', label: 'Project', access: 'tasks', element: <ProjectPage /> },
    { path: '/document-records/:id', label: 'Document', access: 'documents', element: <DocumentPage /> },
  ],
}

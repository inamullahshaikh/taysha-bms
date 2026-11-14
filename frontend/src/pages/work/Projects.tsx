import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { date, label } from '../../lib/format'
import { useRefMap, useUrlState } from '../../lib/hooks'
import { ChartCard, SegmentBar } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { Button, ErrorNote, Facts, Card, Loading, Segmented, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { Board, TaskOverview } from './Tasks'
import { Due, Priority, projectFields, taskFields } from './shared'

export default function Projects() {
  const userName = useRefMap('/users')
  return (
    <ResourcePage
      path="/projects" feature="tasks" noun="project" fields={projectFields} rowTo={(r: any) => `/projects/${r.id}`}
      defaults={{ status: 'planned', kind: 'operations' }}
      filters={[
        { key: 'status', label: 'Status', options: ['planned', 'active', 'on_hold', 'done', 'cancelled'] },
        { key: 'kind', label: 'Kind', options: ['launch', 'campaign', 'event', 'product_development', 'operations', 'other'] },
      ]}
      columns={[
        { key: 'name', label: 'Project', render: (r: any) => <span className="font-medium">{r.name}</span> },
        { key: 'kind', label: 'Kind', render: (r: any) => label(r.kind) },
        { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
        { key: 'owner_id', label: 'Owner', render: (r: any) => (r.owner_id ? userName(r.owner_id) : '—') },
        { key: 'due_date', label: 'Due', render: (r: any) => <Due value={r.due_date} status={r.status} /> },
      ]}
    />
  )
}

const STATUS_COLOR: Record<string, string> = { todo: '#b9adaf', in_progress: '#3b6fb6', blocked: '#d9822b', done: '#1f8a70', cancelled: '#ddd0c4' }

export function ProjectPage() {
  const id = Number(useParams().id)
  const { can } = useAuth()
  const qc = useQueryClient()
  const userName = useRefMap('/users')
  const [view, setView] = useUrlState('view', 'list')
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const key = [`/projects/${id}`]
  const { data: p, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/projects/${id}`) })
  const { data: ov } = useQuery({ queryKey: ['/tasks/overview', id], queryFn: () => api.get('/tasks/overview', { project_id: id }) })
  if (isLoading) return <Loading />
  if (error || !p) return <ErrorNote error={error} />
  const counts: Record<string, number> = ov?.by_status ?? {}
  const total = Object.entries(counts).filter(([s]) => s !== 'cancelled').reduce((a, [, n]) => a + n, 0)
  const pct = total ? Math.round(((counts.done ?? 0) / total) * 100) : 0

  return (
    <>
      <RecordHeader back="/projects" backLabel="Projects" title={p.name} status={<Status value={p.status} />}
        meta={`${label(p.kind)}${p.due_date ? ` · due ${date(p.due_date)}` : ''}`}
        actions={<>
          {can('tasks', 'edit') && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>}
          {can('tasks', 'create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>New task</Button>}
        </>} />
      <RecordLayout
        main={<>
          <TaskOverview projectId={id} />
          <ChartCard title="Progress" sub={total ? `${pct}% of ${total} task${total === 1 ? '' : 's'} done` : 'No tasks yet'}>
            <SegmentBar fmt={(n) => String(n)} parts={['done', 'in_progress', 'blocked', 'todo'].map((s) => ({ label: label(s), value: counts[s] ?? 0, color: STATUS_COLOR[s] }))} />
          </ChartCard>
          <div className="flex justify-end">
            <Segmented value={view} onChange={setView} options={[{ value: 'list', label: 'List' }, { value: 'board', label: 'Board' }]} />
          </div>
          {view === 'board' ? <Board params={{ project_id: id }} /> : (
            <DataTable path="/tasks" params={{ project_id: id }} persist={false} search="Search tasks" rowTo={(r: any) => `/tasks/${r.id}`}
              empty={{ title: 'No tasks in this project yet' }}
              columns={[
                { key: 'title', label: 'Task', render: (r: any) => <span className="font-medium">{r.title}</span> },
                { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
                { key: 'priority', label: 'Priority', render: (r: any) => <Priority value={r.priority} /> },
                { key: 'assignee_id', label: 'Assignee', render: (r: any) => (r.assignee_id ? userName(r.assignee_id) : '—') },
                { key: 'due_date', label: 'Due', render: (r: any) => <Due value={r.due_date} status={r.status} /> },
              ]} />
          )}
        </>}
        side={<>
          <Card title="About">
            <Facts cols={1} items={[
              ['Owner', p.owner_id ? userName(p.owner_id) : '—'],
              ['Start', date(p.start_date)],
              ['Due', <Due value={p.due_date} status={p.status} />],
              ['Description', p.description ? <span className="whitespace-pre-wrap">{p.description}</span> : '—'],
            ]} />
          </Card>
          <Attachments entity="projects" id={id} canEdit={can('tasks', 'edit')} />
          <History entity="projects" id={id} />
        </>}
      />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit project" mode="edit" fields={projectFields} initial={p}
        submit={async (body) => { await api.patch(`/projects/${id}`, body); qc.invalidateQueries({ queryKey: key }) }} />
      <FormDrawer open={adding} onClose={() => setAdding(false)} title="New task" fields={taskFields.filter((f) => f.name !== 'project_id')}
        initial={{ priority: 'medium', status: 'todo' }}
        submit={async (body) => { await api.post('/tasks', { ...body, project_id: id }); qc.invalidateQueries({ queryKey: ['/tasks'] }); qc.invalidateQueries({ queryKey: ['/tasks/overview'] }) }} />
    </>
  )
}

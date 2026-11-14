import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, asPage } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { label } from '../../lib/format'
import { useAction, useRefMap, useUrlState } from '../../lib/hooks'
import { StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { Button, cx, IconButton, Loading, Menu, MenuItem, Segmented, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { Due, Priority, PRIORITIES, TASK_STATUSES, taskFields } from './shared'

const BOARD = ['todo', 'in_progress', 'blocked', 'done']

export function TaskOverview({ projectId }: { projectId?: number }) {
  const { data } = useQuery({
    queryKey: ['/tasks/overview', projectId],
    queryFn: () => api.get('/tasks/overview', { project_id: projectId }),
  })
  const s = data?.by_status ?? {}
  const open = (s.todo ?? 0) + (s.in_progress ?? 0) + (s.blocked ?? 0)
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Open" value={data ? open : '—'} sub={data ? `${s.in_progress ?? 0} in progress` : undefined} />
      <StatTile label="Overdue" value={data?.overdue ?? '—'} />
      <StatTile label="Due in 7 days" value={data?.due_next_7_days ?? '—'} />
      <StatTile label="Blocked" value={data?.blocked ?? '—'} />
    </div>
  )
}

export default function Tasks() {
  const { user, can } = useAuth()
  const [view, setView] = useUrlState('view', 'list')
  const [mine, setMine] = useUrlState('mine', '')
  const [creating, setCreating] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const userName = useRefMap('/users')
  const projectName = useRefMap('/projects')
  const params = mine ? { assignee_id: user.id } : {}

  const toolbar = (
    <>
      <Segmented value={view} onChange={setView} options={[{ value: 'list', label: 'List' }, { value: 'board', label: 'Board' }]} />
      <Button size="sm" variant={mine ? 'primary' : 'secondary'} aria-pressed={!!mine} onClick={() => setMine(mine ? '' : '1')}>Assigned to me</Button>
      {can('tasks', 'create') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New task</Button>}
    </>
  )

  return (
    <div className="flex flex-col gap-4">
      <TaskOverview />
      {view === 'board' ? (
        <>
          <div className="flex flex-wrap items-center justify-end gap-2">{toolbar}</div>
          <Board params={params} />
        </>
      ) : (
        <DataTable
          path="/tasks"
          params={params}
          search="Search tasks"
          rowTo={(r: any) => `/tasks/${r.id}`}
          exportFeature="tasks"
          filters={[
            { key: 'status', label: 'Status', options: TASK_STATUSES },
            { key: 'priority', label: 'Priority', options: PRIORITIES },
          ]}
          toolbar={toolbar}
          empty={{ title: 'No tasks yet', body: 'Create a task and assign it to someone on the team.' }}
          columns={[
            { key: 'title', label: 'Task', render: (r: any) => <span className="font-medium">{r.title}</span> },
            { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
            { key: 'priority', label: 'Priority', sort: 'priority', render: (r: any) => <Priority value={r.priority} /> },
            { key: 'assignee_id', label: 'Assignee', render: (r: any) => (r.assignee_id ? userName(r.assignee_id) : <span className="text-muted">Unassigned</span>) },
            { key: 'project_id', label: 'Project', render: (r: any) => (r.project_id ? projectName(r.project_id) : <span className="text-muted">—</span>) },
            { key: 'due_date', label: 'Due', sort: 'due_date', render: (r: any) => <Due value={r.due_date} status={r.status} /> },
          ]}
        />
      )}
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="New task" fields={taskFields}
        initial={{ priority: 'medium', status: 'todo', assignee_id: mine ? user.id : '' }}
        submit={async (body) => { await api.post('/tasks', body); toast('Task created'); qc.invalidateQueries({ queryKey: ['/tasks'] }); qc.invalidateQueries({ queryKey: ['/tasks/overview'] }) }} />
    </div>
  )
}

/** Kanban by status. Drag a card, or use its menu (keyboard friendly). */
export function Board({ params }: { params: Record<string, any> }) {
  const { can } = useAuth()
  const userName = useRefMap('/users')
  const [over, setOver] = useState<string | null>(null)
  const key = ['/tasks', 'board', params]
  const { data, isLoading } = useQuery({
    queryKey: key,
    // every open task, but only the latest finished ones: done tasks pile up forever and would push open
    // work off a single capped list
    queryFn: async () => {
      if (params.status) return asPage<any>(await api.get('/tasks', { ...params, page_size: 500 })).items
      const [open, done] = await Promise.all([
        api.get('/tasks', { ...params, status: 'todo,in_progress,blocked', page_size: 500 }),
        api.get('/tasks', { ...params, status: 'done', sort: '-due_date', page_size: 30 }),
      ])
      return [...asPage<any>(open).items, ...asPage<any>(done).items]
    },
  })
  const move = useAction(({ id, status }: { id: number; status: string }) => api.patch(`/tasks/${id}`, { status }), {
    invalidate: [['/tasks'], ['/tasks/overview']],
  })
  if (isLoading) return <Loading />
  const editable = can('tasks', 'edit')
  return (
    <div className="scroll-quiet -mx-4 flex gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:px-0">
      {BOARD.map((col) => {
        const cards = (data ?? []).filter((t) => t.status === col)
        return (
          <section key={col}
            onDragOver={(e) => { if (editable) { e.preventDefault(); setOver(col) } }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => { setOver(null); const id = Number(e.dataTransfer.getData('text/plain')); if (id) move.mutate({ id, status: col }) }}
            className={cx('flex w-72 shrink-0 flex-col rounded-card bg-sunken/70 p-2 transition lg:w-auto', over === col && 'bg-wine-50 ring-2 ring-wine-200')}>
            <header className="flex items-center justify-between px-1.5 pt-1 pb-2.5">
              <h3 className="text-[12.5px] font-semibold text-ink-2">{label(col)}</h3>
              <span className="tabular text-[12px] text-muted">{cards.length}{col === 'done' && !params.status && cards.length >= 30 ? '+' : ''}</span>
            </header>
            <div className="flex min-h-24 flex-col gap-2">
              {cards.map((t) => (
                <article key={t.id} draggable={editable} onDragStart={(e) => e.dataTransfer.setData('text/plain', String(t.id))}
                  className="group rounded-lg bg-surface p-3 shadow-card transition hover:-translate-y-px hover:shadow-[0_6px_16px_-8px_rgb(62_16_25/0.25)]">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/tasks/${t.id}`} className="text-[13px] leading-snug font-medium text-ink hover:text-wine-800">{t.title}</Link>
                    {editable && (
                      <Menu trigger={<IconButton label="Move task" className="-mt-1 -mr-1 size-7 opacity-60 group-hover:opacity-100"><MoreHorizontal className="size-4" /></IconButton>}>
                        {TASK_STATUSES.filter((s) => s !== t.status).map((s) => (
                          <MenuItem key={s} onClick={() => move.mutate({ id: t.id, status: s })}>Move to {label(s).toLowerCase()}</MenuItem>
                        ))}
                      </Menu>
                    )}
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-2">
                    <Priority value={t.priority} />
                    {t.due_date && <Due value={t.due_date} status={t.status} />}
                    {t.assignee_id && <span className="ml-auto text-muted">{userName(t.assignee_id)}</span>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

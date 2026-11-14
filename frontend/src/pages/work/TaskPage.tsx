import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Send } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { ago, date, label } from '../../lib/format'
import { useAction, useLookupName, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { Button, Card, Checkbox, ErrorNote, Facts, IconButton, Input, Loading, Select, Status, Textarea } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { Due, Priority, TASK_STATUSES, taskFields } from './shared'

export default function TaskPage() {
  const id = Number(useParams().id)
  const { can } = useAuth()
  const qc = useQueryClient()
  const userName = useRefMap('/users')
  const projectName = useRefMap('/projects')
  const deptName = useLookupName('departments')
  const [editing, setEditing] = useState(false)
  const [subtask, setSubtask] = useState(false)
  const key = [`/tasks/${id}`]
  const { data: t, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/tasks/${id}`) })
  const patch = useAction((body: any) => api.patch(`/tasks/${id}`, body), { invalidate: [key, ['/tasks'], ['/tasks/overview']] })
  if (isLoading) return <Loading />
  if (error || !t) return <ErrorNote error={error} />
  const edit = can('tasks', 'edit')

  return (
    <>
      <RecordHeader back="/tasks" backLabel="Tasks" title={t.title} status={<Status value={t.status} />}
        meta={<>{t.project_id && <>In <Link className="text-wine-700 hover:underline" to={`/projects/${t.project_id}`}>{projectName(t.project_id)}</Link> · </>}created {ago(t.created_at)}</>}
        actions={edit && <>
          <div className="w-40"><Select aria-label="Status" value={t.status} options={TASK_STATUSES} onChange={(e) => patch.mutate({ status: e.target.value })} /></div>
          <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
        </>} />
      <RecordLayout
        main={<>
          {(t.description || t.blocked_reason) && (
            <Card title="Details">
              {t.blocked_reason && <p className="mb-2 rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn">Blocked: {t.blocked_reason}</p>}
              {t.description && <p className="text-[13.5px] whitespace-pre-wrap text-ink">{t.description}</p>}
            </Card>
          )}
          <Checklist items={t.checklist ?? []} editable={edit} onSave={(checklist) => patch.mutate({ checklist })} />
          <Card title="Subtasks" pad={false} action={can('tasks', 'create') && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setSubtask(true)}>Add subtask</Button>}>
            <DataTable path="/tasks" params={{ parent_id: id }} persist={false} search={false} dense rowTo={(r: any) => `/tasks/${r.id}`}
              empty={{ title: 'No subtasks' }}
              columns={[
                { key: 'title', label: 'Subtask' },
                { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
                { key: 'assignee_id', label: 'Assignee', render: (r: any) => (r.assignee_id ? userName(r.assignee_id) : '—') },
                { key: 'due_date', label: 'Due', render: (r: any) => <Due value={r.due_date} status={r.status} /> },
              ]} />
          </Card>
          <Comments id={id} />
        </>}
        side={<>
          <Card title="About">
            <Facts cols={1} items={[
              ['Assignee', t.assignee_id ? userName(t.assignee_id) : 'Unassigned'],
              ['Priority', <Priority value={t.priority} />],
              ['Due', <Due value={t.due_date} status={t.status} />],
              ['Department', t.department_id ? deptName(t.department_id) : '—'],
              ['Created by', t.created_by_id ? userName(t.created_by_id) : '—'],
              ['Completed', t.completed_at ? date(t.completed_at) : '—'],
              ...(t.related_type ? [['Linked to', `${label(t.related_type)} #${t.related_id}`] as [string, string]] : []),
            ]} />
          </Card>
          <Attachments entity="tasks" id={id} canEdit={edit} />
          <History entity="tasks" id={id} />
        </>}
      />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit task" mode="edit" fields={taskFields} initial={t}
        submit={async (body) => { await patch.mutateAsync(body) }} />
      <FormDrawer open={subtask} onClose={() => setSubtask(false)} title="New subtask" fields={taskFields.filter((f) => f.name !== 'project_id')}
        initial={{ priority: 'medium', status: 'todo', assignee_id: t.assignee_id ?? '' }}
        submit={async (body) => { await api.post('/tasks', { ...body, parent_id: id }); qc.invalidateQueries({ queryKey: ['/tasks'] }) }} />
    </>
  )
}

function Checklist({ items, editable, onSave }: { items: { text: string; done?: boolean }[]; editable: boolean; onSave: (v: any[]) => void }) {
  const [text, setText] = useState('')
  const done = items.filter((i) => i.done).length
  if (!items.length && !editable) return null
  return (
    <Card title="Checklist" action={items.length > 0 && <span className="tabular text-[12.5px] text-muted">{done} of {items.length}</span>}>
      <ul className="flex flex-col gap-2">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-2">
            <Checkbox label={<span className={it.done ? 'text-muted line-through' : ''}>{it.text}</span>} checked={!!it.done} disabled={!editable}
              onChange={(e) => onSave(items.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} />
            {editable && <IconButton label="Remove item" className="ml-auto size-7 text-muted" onClick={() => onSave(items.filter((_, j) => j !== i))}>×</IconButton>}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onSave([...items, { text: text.trim(), done: false }]); setText('') } }}>
          <Input placeholder="Add an item" value={text} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" disabled={!text.trim()}>Add</Button>
        </form>
      )}
    </Card>
  )
}

function Comments({ id }: { id: number }) {
  const { can } = useAuth()
  const userName = useRefMap('/users')
  const [body, setBody] = useState('')
  const key = [`/tasks/${id}/comments`]
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<any[]>(`/tasks/${id}/comments`) })
  const add = useAction((b: string) => api.post(`/tasks/${id}/comments`, { body: b }), { invalidate: [key], onSuccess: () => setBody('') })
  return (
    <Card title="Comments">
      {!data?.length ? <p className="text-[13px] text-muted">No comments yet.</p> : (
        <ul className="flex flex-col gap-4">
          {data.map((c) => (
            <li key={c.id}>
              <p className="text-[12.5px]"><span className="font-medium text-ink">{c.created_by_id ? userName(c.created_by_id) : 'Someone'}</span> <span className="text-muted">· {ago(c.created_at)}</span></p>
              <p className="mt-0.5 text-[13.5px] whitespace-pre-wrap text-ink">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {can('tasks', 'create') && (
        <form className="mt-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(body.trim()) }}>
          <Textarea aria-label="Comment" placeholder="Write a comment" className="min-h-10" value={body} onChange={(e) => setBody(e.target.value)} />
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!body.trim()} icon={<Send className="size-4" />}>Post</Button>
        </form>
      )}
    </Card>
  )
}

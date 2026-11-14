import { USERS, type FieldDef, type RecordSource } from '../../ui/Form'
import { Badge, cx } from '../../ui/kit'
import { date, label } from '../../lib/format'
import { today } from '../../lib/format'

export const PROJECTS: RecordSource = { path: '/projects' }
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled']
export const PRIORITIES = ['low', 'medium', 'high', 'urgent']

export const taskFields: FieldDef[] = [
  { name: 'title', label: 'Title', required: true, full: true },
  { name: 'description', label: 'Description', type: 'textarea' },
  { name: 'project_id', label: 'Project', type: 'record', record: PROJECTS },
  { name: 'assignee_id', label: 'Assignee', type: 'record', record: USERS },
  { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
  { name: 'status', label: 'Status', type: 'select', options: TASK_STATUSES },
  { name: 'due_date', label: 'Due', type: 'date' },
  { name: 'department_id', label: 'Department', type: 'lookup', lookup: 'departments' },
  { name: 'blocked_reason', label: 'Why blocked', full: true, show: (v) => v.status === 'blocked' },
]

export const projectFields: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, full: true },
  { name: 'kind', label: 'Kind', type: 'select', options: ['launch', 'campaign', 'event', 'product_development', 'operations', 'other'] },
  { name: 'status', label: 'Status', type: 'select', options: ['planned', 'active', 'on_hold', 'done', 'cancelled'] },
  { name: 'owner_id', label: 'Owner', type: 'record', record: USERS },
  { name: 'start_date', label: 'Start', type: 'date' },
  { name: 'due_date', label: 'Due', type: 'date' },
  { name: 'description', label: 'Description', type: 'textarea' },
]

const PRIORITY_TONE = { low: 'neutral', medium: 'info', high: 'warn', urgent: 'bad' } as const

export function Priority({ value }: { value?: string }) {
  if (!value) return null
  return <Badge tone={PRIORITY_TONE[value as keyof typeof PRIORITY_TONE] ?? 'neutral'}>{label(value)}</Badge>
}

/** Due date, red when past and the task is still open. */
export function Due({ value, status }: { value?: string | null; status?: string }) {
  if (!value) return <span className="text-muted">—</span>
  const late = value < today() && status !== 'done' && status !== 'cancelled'
  return <span className={cx('tabular', late && 'font-medium text-bad')}>{date(value)}{late && ' · overdue'}</span>
}

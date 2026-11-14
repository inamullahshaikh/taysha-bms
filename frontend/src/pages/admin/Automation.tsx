import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Play, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, asPage } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { ago, label } from '../../lib/format'
import { useAction, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { PRODUCTS, USERS, type FieldDef, type FormValues } from '../../ui/Form'
import { Badge, Button, Checkbox, Field, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const TRIGGERS: Record<string, string> = {
  order_in_status: 'An order sits in a status too long',
  low_stock: 'Stock falls below a level',
  invoice_overdue: 'An invoice is overdue',
  expense_waiting: 'An expense waits for approval',
  daily: 'Every day',
}
const ACTIONS: Record<string, string> = {
  notify_users: 'Notify chosen people',
  notify_feature: 'Notify everyone with access to an area',
  email: 'Send an email',
  create_task: 'Create a task',
  mark_delivered: 'Mark the order delivered',
}
const FEATURES = ['orders', 'invoices', 'inventory', 'purchasing', 'production', 'quality', 'expenses', 'accounting', 'marketing', 'customers', 'tasks']
const ORDER_STATUSES = ['draft', 'confirmed', 'processing', 'packed', 'dispatched']

const t = (v: FormValues, ...k: string[]) => k.includes(v.trigger)
const a = (v: FormValues, ...k: string[]) => k.includes(v.action)

const fields: FieldDef[] = [
  { name: 'name', label: 'Rule name', required: true, full: true, placeholder: 'Chase orders packed for over a day' },
  { name: 'trigger', label: 'When', type: 'select', required: true, full: true, createOnly: true, options: Object.entries(TRIGGERS).map(([value, label]) => ({ value, label })) },
  { name: 'p_status', label: 'Order status', type: 'select', required: true, options: ORDER_STATUSES, show: (v) => t(v, 'order_in_status') },
  { name: 'p_older_than_hours', label: 'For longer than (hours)', type: 'number', show: (v) => t(v, 'order_in_status') },
  { name: 'p_below', label: 'Available below', type: 'number', show: (v) => t(v, 'low_stock') },
  { name: 'p_warehouse_id', label: 'Warehouse', type: 'lookup', lookup: 'warehouses', hint: 'Default warehouse if empty', show: (v) => t(v, 'low_stock') },
  { name: 'p_product_id', label: 'Only this product', type: 'record', record: PRODUCTS, full: true, show: (v) => t(v, 'low_stock') },
  { name: 'p_days', label: 'Overdue by at least (days)', type: 'number', show: (v) => t(v, 'invoice_overdue') },
  { name: 'p_hours', label: 'Waiting longer than (hours)', type: 'number', show: (v) => t(v, 'expense_waiting') },
  { name: 'action', label: 'Then', type: 'select', required: true, full: true, createOnly: true, options: Object.entries(ACTIONS).map(([value, label]) => ({ value, label })) },
  { name: 'a_user_id', label: 'Notify', type: 'record', record: USERS, required: true, createOnly: true, hint: 'You can add more people after creating the rule', show: (v) => a(v, 'notify_users') },
  { name: 'a_feature', label: 'Area', type: 'select', required: true, options: FEATURES, show: (v) => a(v, 'notify_feature') },
  { name: 'a_to', label: 'Email to', type: 'tags', required: true, full: true, show: (v) => a(v, 'email') },
  { name: 'a_title', label: 'Message title', full: true, hint: 'Defaults to the rule name and the match', show: (v) => a(v, 'notify_users', 'notify_feature', 'email') },
  { name: 'a_task_title', label: 'Task title', full: true, show: (v) => a(v, 'create_task') },
  { name: 'a_assignee_id', label: 'Assign to', type: 'record', record: USERS, show: (v) => a(v, 'create_task') },
  { name: 'a_due_in_days', label: 'Due in (days)', type: 'number', show: (v) => a(v, 'create_task') },
  { name: 'a_priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high', 'urgent'], show: (v) => a(v, 'create_task') },
  { name: 'active', label: 'Active', type: 'bool', full: true },
]

/** Rule → flat form values (params as p_*, action params as a_*). */
const flatten = (r: any): FormValues => ({
  ...r,
  ...Object.fromEntries(Object.entries(r.params ?? {}).map(([k, v]) => [`p_${k}`, v])),
  ...Object.fromEntries(Object.entries(r.action_params ?? {}).map(([k, v]) => [`a_${k}`, v])),
})

function nest(body: FormValues, userIds: number[], action: string) {
  const params: FormValues = {}, action_params: FormValues = {}
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length && k !== 'a_to')) continue
    if (k.startsWith('p_')) params[k.slice(2)] = v
    if (k.startsWith('a_')) action_params[k.slice(2)] = v
  }
  if (action === 'notify_users') {
    action_params.user_ids = action_params.user_id ? [action_params.user_id] : userIds
    delete action_params.user_id
  }
  return { name: body.name, ...(body.trigger ? { trigger: body.trigger, action: body.action } : {}), active: body.active, params, action_params }
}

export default function Automation() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<any>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['/automation/rules'] })
  return (
    <>
      <DataTable path="/automation/rules" search="Search rules"
        onRowClick={setEditing}
        toolbar={can('automation', 'edit') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing({ active: true, trigger: 'order_in_status', action: 'notify_feature', params: { older_than_hours: 24 }, action_params: { feature: 'orders' } })}>New rule</Button>}
        empty={{ title: 'No automation rules yet', body: 'Rules watch for things like stuck orders or low stock, then notify people or create tasks. Each match acts once.' }}
        columns={[
          { key: 'name', label: 'Rule', render: (r: any) => <span className="font-medium">{r.name}</span> },
          { key: 'trigger', label: 'When', render: (r: any) => <span className="text-ink-2">{TRIGGERS[r.trigger] ?? label(r.trigger)}</span> },
          { key: 'action', label: 'Then', render: (r: any) => <span className="text-ink-2">{ACTIONS[r.action] ?? label(r.action)}</span> },
          { key: 'active', label: 'Status', render: (r: any) => <Status value={r.active ? 'active' : 'paused'} /> },
          { key: 'run_count', label: 'Actions taken', align: 'right' },
          { key: 'last_run_at', label: 'Last run', render: (r: any) => (r.last_run_at ? ago(r.last_run_at) : <span className="text-muted">Never</span>) },
        ]} />
      {editing && <RuleDrawer rule={editing} onClose={() => { setEditing(null); refresh() }} />}
    </>
  )
}

function RuleDrawer({ rule, onClose }: { rule: any; onClose: () => void }) {
  const { can } = useAuth()
  const toast = useToast()
  const isNew = !rule.id
  const editable = can('automation', 'edit')
  const [userIds, setUserIds] = useState<number[]>(rule.action_params?.user_ids ?? [])
  const users = useQuery({ queryKey: ['refmap-users-list'], queryFn: async () => asPage<any>(await api.get('/users', { page_size: 500, active: true })).items, retry: false })
  const [test, setTest] = useState<any[] | null>(null)
  const runTest = useAction(() => api.post<any[]>(`/automation/rules/${rule.id}/test`), { onSuccess: (r) => setTest(r) })
  const run = useAction(() => api.post<{ actions: number }>(`/automation/rules/${rule.id}/run`), {
    invalidate: [[`/automation/rules/${rule.id}/hits`], ['/automation/rules']],
    onSuccess: (r) => toast(r.actions ? `${r.actions} actions taken` : 'Nothing new to act on'),
  })
  const hits = useQuery({ queryKey: [`/automation/rules/${rule.id}/hits`], queryFn: () => api.get<any[]>(`/automation/rules/${rule.id}/hits`), enabled: !isNew })
  const userName = useRefMap('/users')

  return (
    <FormDrawer open onClose={onClose} wide title={isNew ? 'New automation rule' : rule.name} mode={isNew ? 'create' : 'edit'}
      fields={fields} initial={flatten(rule)} submitLabel={isNew ? 'Create rule' : 'Save rule'}
      submit={async (body) => {
        const payload = nest(body, userIds, body.action ?? rule.action)
        if (isNew) await api.post('/automation/rules', payload)
        else await api.patch(`/automation/rules/${rule.id}`, payload)
        toast(isNew ? 'Rule created' : 'Rule saved')
      }}
      footerExtra={!isNew && editable && <>
        <Button icon={<FlaskConical className="size-4" />} loading={runTest.isPending} onClick={() => runTest.mutate(undefined)}>Test</Button>
        <Button icon={<Play className="size-4" />} loading={run.isPending} onClick={() => run.mutate(undefined)}>Run now</Button>
      </>}>
      {!isNew && rule.action === 'notify_users' && <NotifyPicker users={users.data ?? []} value={userIds} onChange={setUserIds} />}
      {test && (
        <div className="rounded-lg border border-line">
          <p className="border-b border-line bg-page px-3 py-2 text-[12.5px] font-medium">Dry run: {test.length ? `${test.length} matches right now` : 'nothing matches right now'}</p>
          <ul className="max-h-48 divide-y divide-line overflow-y-auto">
            {test.map((m) => (
              <li key={m.key} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                {m.link ? <Link to={m.link} className="text-wine-700 hover:underline">{m.label}</Link> : m.label}
                {m.already_handled ? <Badge>Already handled</Badge> : <Badge tone="info">Would act</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!isNew && (
        <div>
          <p className="mb-2 text-[12.5px] font-medium text-ink-2">Recent actions</p>
          {!hits.data?.length ? <p className="text-[13px] text-muted">This rule hasn't acted yet.</p> : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {hits.data.slice(0, 20).map((h) => (
                <li key={h.key} className="flex justify-between gap-3 px-3 py-2 text-[13px]"><span>{h.label}</span><span className="shrink-0 text-muted">{ago(h.at)}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {rule.action === 'notify_users' && !isNew && userIds.length > 0 && !users.data?.length && (
        <p className="text-[12px] text-muted">Notifies: {userIds.map((id) => userName(id)).join(', ')}</p>
      )}
    </FormDrawer>
  )
}

function NotifyPicker({ users, value, onChange }: { users: any[]; value: number[]; onChange: (v: number[]) => void }) {
  if (!users.length) return null
  return (
    <Field label="People to notify">
      <div className="grid gap-1.5 rounded-lg border border-line p-3 sm:grid-cols-2">
        {users.map((u) => (
          <Checkbox key={u.id} label={u.name} checked={value.includes(u.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, u.id] : value.filter((x) => x !== u.id))} />
        ))}
      </div>
    </Field>
  )
}

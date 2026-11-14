import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Pencil, Plus, UserCheck, Users } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, url } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { date, label, money, today } from '../../lib/format'
import { useAction, useRefMap, useUrlState } from '../../lib/hooks'
import { DataTable, type Column } from '../../ui/DataTable'
import { CUSTOMERS, FormFields, fromForm, toForm, USERS, type FieldDef, type FormValues } from '../../ui/Form'
import { Badge, Button, Card, Confirm, Drawer, Empty, ErrorNote, Facts, Loading, Segmented, Status } from '../../ui/kit'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const CUSTOMER_TYPES = ['retail', 'wholesale', 'cafe', 'corporate', 'distributor', 'retailer', 'other']

/* ---------- Leads ---------- */

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost']
const LEAD: FieldDef[] = [
  { name: 'name', label: 'Name', required: true },
  { name: 'company', label: 'Company' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'status', label: 'Status', type: 'select', options: LEAD_STATUSES },
  { name: 'source', label: 'Source', placeholder: 'instagram, referral, event…' },
  { name: 'campaign_id', label: 'Campaign', type: 'record', record: { path: '/campaigns' } },
  { name: 'owner_id', label: 'Owner', type: 'record', record: USERS },
  { name: 'lost_reason', label: 'Why lost', show: (v) => v.status === 'lost' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Leads() {
  return (
    <ResourcePage path="/leads" feature="customers" noun="lead" fields={LEAD} rowTo={(r: any) => `/leads/${r.id}`} defaults={{ status: 'new' }}
      filters={[{ key: 'status', label: 'Status', options: LEAD_STATUSES }]}
      columns={[
        { key: 'name', label: 'Lead', render: (r: any) => <><span className="font-medium">{r.name}</span>{r.company && <span className="ml-2 text-muted">{r.company}</span>}</> },
        { key: 'phone', label: 'Phone' },
        { key: 'source', label: 'Source', render: (r: any) => label(r.source) },
        { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
        { key: 'created_at', label: 'Added', render: (r: any) => date(r.created_at) },
      ]} />
  )
}

export function LeadDetail() {
  const id = Number(useParams().id)
  const key = `/leads/${id}`
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [following, setFollowing] = useState(false)
  const [converting, setConverting] = useState(false)
  const userName = useRefMap('/users')
  const { data: l, error } = useQuery({ queryKey: [key], queryFn: () => api.get(key) })
  const convert = useAction(() => api.post(`${key}/convert`), {
    success: 'Lead is now a customer', invalidate: [[key], ['/leads']], onSuccess: (c: any) => navigate(`/customers/${c.id}`),
  })
  if (error) return <ErrorNote error={error} />
  if (!l) return <Loading />
  return (
    <>
      <RecordHeader back="/leads" backLabel="Leads" title={l.name} status={<Status value={l.status} />}
        meta={[l.company, l.phone, l.email].filter(Boolean).join(' · ')}
        actions={can('customers', 'edit') && <>
          <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
          <Button icon={<Plus className="size-4" />} onClick={() => setFollowing(true)}>Follow-up</Button>
          {l.customer_id ? <Link to={`/customers/${l.customer_id}`}><Button>Open customer</Button></Link>
            : <Button variant="primary" icon={<UserCheck className="size-4" />} onClick={() => setConverting(true)}>Make customer</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card title="Details">
            <Facts items={[['Source', label(l.source)], ['Owner', l.owner_id ? userName(l.owner_id) : null], ['Added', date(l.created_at)], ['Why lost', l.lost_reason], ['Notes', l.notes]]} />
          </Card>
          <FollowUpList params={{ lead_id: id }} />
        </>}
        side={<History entity="leads" id={id} />}
      />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit lead" mode="edit" fields={LEAD} initial={l}
        submit={async (body) => { await api.patch(key, body); toast('Saved'); qc.invalidateQueries({ queryKey: [key] }) }} />
      <NewFollowUp open={following} onClose={() => setFollowing(false)} initial={{ lead_id: id, due_date: today() }} />
      <Confirm open={converting} onClose={() => setConverting(false)} title={`Make ${l.name} a customer?`} confirmLabel="Make customer"
        body="A customer record is created from this lead, and its follow-ups move across." loading={convert.isPending} onConfirm={() => convert.mutate(undefined)} />
    </>
  )
}

/* ---------- Follow-ups ---------- */

const FOLLOW_UP: FieldDef[] = [
  { name: 'note', label: 'What to do', required: true, full: true, placeholder: 'Call about the bulk order for Eid' },
  { name: 'due_date', label: 'Due', type: 'date', required: true },
  { name: 'assigned_to_id', label: 'Assigned to', type: 'record', record: USERS },
  { name: 'customer_id', label: 'Customer', type: 'record', record: CUSTOMERS },
  { name: 'lead_id', label: 'Lead', type: 'record', record: { path: '/leads' } },
]

function NewFollowUp({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: FormValues }) {
  const qc = useQueryClient()
  const toast = useToast()
  return (
    <FormDrawer open={open} onClose={onClose} title="New follow-up" fields={FOLLOW_UP} initial={initial ?? { due_date: today() }}
      submit={async (body) => { await api.post('/follow-ups', body); toast('Follow-up added'); qc.invalidateQueries({ queryKey: ['/follow-ups'] }) }} />
  )
}

/** Shared list; `mine` reads the personal endpoint (no paging). */
function FollowUpList({ params, mine }: { params?: Record<string, any>; mine?: boolean }) {
  const [done, setDone] = useState<any>(null)
  const customer = useRefMap('/customers')
  const lead = useRefMap('/leads')
  const userName = useRefMap('/users')
  const finish = useAction((v: { id: number; outcome: string }) => api.post(`/follow-ups/${v.id}/done`, { outcome: v.outcome || null }), {
    success: 'Marked done', invalidate: [['/follow-ups'], ['/follow-ups/mine']], onSuccess: () => setDone(null),
  })
  const overdue = (r: any) => !r.done_at && r.due_date < today()
  const columns: Column<any>[] = [
    { key: 'due_date', label: 'Due', render: (r) => <span className={overdue(r) ? 'font-medium text-bad' : ''}>{date(r.due_date)}{overdue(r) && ' · overdue'}</span> },
    { key: 'note', label: 'What to do', className: 'max-w-96' },
    { key: 'who', label: 'With', render: (r) => (r.customer_id ? <Link className="hover:text-wine-800" to={`/customers/${r.customer_id}`} onClick={(e) => e.stopPropagation()}>{customer(r.customer_id)}</Link> : r.lead_id ? <Link className="hover:text-wine-800" to={`/leads/${r.lead_id}`} onClick={(e) => e.stopPropagation()}>{lead(r.lead_id)}</Link> : '—') },
    ...(mine ? [] : [{ key: 'assigned_to_id', label: 'Assigned to', render: (r: any) => (r.assigned_to_id ? userName(r.assigned_to_id) : '—') }]),
    { key: 'done', label: '', align: 'right', render: (r) => (r.done_at
      ? <Badge tone="good">Done{r.outcome ? `: ${r.outcome}` : ''}</Badge>
      : <Button size="sm" icon={<Check className="size-4" />} onClick={(e) => { e.stopPropagation(); setDone(r) }}>Done</Button>) },
  ]
  return (
    <>
      <DataTable path={mine ? '/follow-ups/mine' : '/follow-ups'} params={params} persist={!params} columns={columns} search={false}
        empty={{ title: mine ? 'Nothing to follow up' : 'No follow-ups yet' }} dense={!!params} />
      <Confirm open={!!done} onClose={() => setDone(null)} title="Mark this follow-up done?" confirmLabel="Done"
        note={{ label: 'What happened (optional)' }} loading={finish.isPending} onConfirm={(outcome) => finish.mutate({ id: done.id, outcome })} />
    </>
  )
}

export function FollowUps() {
  const [view, setView] = useUrlState('view', 'mine')
  const [creating, setCreating] = useState(false)
  const { can } = useAuth()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented value={view as 'mine' | 'all' | 'done'} onChange={setView}
          options={[{ value: 'mine', label: 'Mine' }, { value: 'done', label: 'Mine, done' }, { value: 'all', label: 'Everyone' }]} />
        {can('customers', 'edit') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New follow-up</Button>}
      </div>
      {view === 'all' ? <FollowUpList /> : <FollowUpList mine params={view === 'done' ? { include_done: true } : {}} />}
      <NewFollowUp open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

/* ---------- Segments ---------- */

const RULES: FieldDef[] = [
  { name: 'type', label: 'Customer type', type: 'select', options: CUSTOMER_TYPES },
  { name: 'city', label: 'City' },
  { name: 'tags_any', label: 'Has any tag', type: 'tags' },
  { name: 'min_orders', label: 'At least this many orders', type: 'number' },
  { name: 'min_spend', label: 'Spent at least', type: 'money' },
  { name: 'active_within_days', label: 'Ordered in the last (days)', type: 'number' },
  { name: 'inactive_days', label: 'No order for (days)', type: 'number' },
  { name: 'territory_id', label: 'Territory', type: 'record', record: { path: '/territories' } },
  { name: 'marketing_opt_in', label: 'Agreed to marketing only', type: 'bool' },
]

const customerColumns: Column<any>[] = [
  { key: 'name', label: 'Customer', render: (r) => <span className="font-medium">{r.name}</span> },
  { key: 'phone', label: 'Phone' },
  { key: 'type', label: 'Type', render: (r) => label(r.type) },
  { key: 'tags', label: 'Tags', render: (r) => r.tags?.map((t: string) => <Badge key={t} className="mr-1">{t}</Badge>) },
]

export function Segments() {
  const [view, setView] = useUrlState('view', 'segments')
  const [editing, setEditing] = useState<any>(null)
  const { can } = useAuth()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented value={view as any} onChange={setView} options={[
          { value: 'segments', label: 'Saved segments' }, { value: 'due', label: 'Due to reorder' }, { value: 'inactive', label: 'Gone quiet' },
        ]} />
        {view === 'segments' && can('customers', 'edit') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>New segment</Button>}
      </div>
      {view === 'due' ? <DueRepeat /> : view === 'inactive' ? <Inactive /> : (
        <DataTable path="/segments" rowTo={(r: any) => `/segments/${r.id}`} search="Search segments" exportFeature="customers"
          empty={{ title: 'No segments yet', body: 'Group customers by type, city, tags or how recently they ordered.', icon: <Users /> }}
          columns={[
            { key: 'name', label: 'Segment', render: (r: any) => <span className="font-medium">{r.name}</span> },
            { key: 'rules', label: 'Rules', render: (r: any) => <span className="text-ink-2">{describe(r.rules)}</span> },
          ]} />
      )}
      {editing && <SegmentEditor segment={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function describe(r: any) {
  const p: string[] = []
  if (r.type) p.push(label(r.type))
  if (r.city) p.push(`in ${r.city}`)
  if (r.tags_any?.length) p.push(`tagged ${r.tags_any.join(' or ')}`)
  if (r.min_orders) p.push(`${r.min_orders}+ orders`)
  if (r.min_spend) p.push(`spent ${money(r.min_spend)}+`)
  if (r.active_within_days) p.push(`ordered in last ${r.active_within_days} days`)
  if (r.inactive_days) p.push(`quiet for ${r.inactive_days}+ days`)
  if (r.marketing_opt_in) p.push('opted in')
  return p.join(' · ') || 'All customers'
}

/** Name + rules, with a live count of matching customers. */
function SegmentEditor({ segment, onClose }: { segment: any; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [name, setName] = useState(segment.name ?? '')
  const [values, setValues] = useState<FormValues>(toForm(RULES, segment.rules ?? {}))
  const [error, setError] = useState<unknown>(null)
  const rules = fromForm(RULES, values, 'create')
  if (rules.marketing_opt_in === false) delete rules.marketing_opt_in
  const preview = useQuery({ queryKey: ['/segments/preview', rules], queryFn: () => api.post('/segments/preview', rules, { page_size: 5 }) })
  const save = useAction(() => (segment.id ? api.patch(`/segments/${segment.id}`, { name, rules }) : api.post('/segments', { name, rules })), {
    onSuccess: (s: any) => { toast('Segment saved'); qc.invalidateQueries({ queryKey: ['/segments'] }); qc.invalidateQueries({ queryKey: [`/segments/${s.id}`] }); onClose(); if (!segment.id) navigate(`/segments/${s.id}`) },
  })
  return (
    <Drawer open onClose={onClose} title={segment.id ? 'Edit segment' : 'New segment'} wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} loading={save.isPending} onClick={() => { setError(null); save.mutate(undefined, { onError: setError }) }}>Save segment</Button></>}>
      <div className="flex flex-col gap-5">
        {error != null && <ErrorNote error={error} />}
        <FormFields fields={[{ name: 'name', label: 'Segment name', required: true, full: true }]} values={{ name }} onChange={(_, v) => setName(v)} />
        <FormFields fields={RULES} values={values} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} />
        <div className="rounded-lg bg-page px-4 py-3">
          <p className="text-[13px]"><span className="font-semibold tabular">{preview.data?.total ?? '…'}</span> customers match</p>
          {!!preview.data?.items?.length && <p className="mt-1 truncate text-[12.5px] text-muted">{preview.data.items.map((c: any) => c.name).join(', ')}{preview.data.total > 5 && '…'}</p>}
        </div>
      </div>
    </Drawer>
  )
}

export function SegmentDetail() {
  const id = Number(useParams().id)
  const key = `/segments/${id}`
  const { can } = useAuth()
  const [editing, setEditing] = useState(false)
  const { data: s, error } = useQuery({ queryKey: [key], queryFn: () => api.get(key) })
  if (error) return <ErrorNote error={error} />
  if (!s) return <Loading />
  return (
    <>
      <RecordHeader back="/segments" backLabel="Segments" title={s.name} meta={describe(s.rules)}
        actions={<>
          {can('customers', 'export') && <a href={url(`${key}/export`, { format: 'xlsx' })}><Button icon={<Download className="size-4" />}>Export</Button></a>}
          {can('customers', 'edit') && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit rules</Button>}
        </>} />
      <DataTable path={`${key}/customers`} search={false} rowTo={(r: any) => `/customers/${r.id}`} columns={customerColumns} empty={{ title: 'No customers match right now' }} />
      {editing && <SegmentEditor segment={s} onClose={() => setEditing(false)} />}
    </>
  )
}

function DueRepeat() {
  const { data } = useQuery({ queryKey: ['/customers/insights/due-repeat'], queryFn: () => api.get<any[]>('/customers/insights/due-repeat') })
  if (!data) return <Loading />
  if (!data.length) return <Card><Empty title="Nobody is overdue for a reorder" /></Card>
  return (
    <Card pad={false}>
      <p className="border-b border-line px-4 py-3 text-[13px] text-ink-2">Repeat customers whose usual gap between orders has passed.</p>
      <table className="w-full text-[13px]">
        <thead><tr className="border-b border-line text-left text-[12px] text-muted">
          <th className="h-9 px-4 font-medium">Customer</th><th className="px-3 font-medium">Phone</th><th className="px-3 text-right font-medium">Orders</th>
          <th className="px-3 text-right font-medium">Usually every</th><th className="px-3 text-right font-medium">Last order</th><th className="px-4 text-right font-medium">Days since</th>
        </tr></thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.customer_id} className="border-b border-line last:border-0">
              <td className="h-11 px-4"><Link to={`/customers/${r.customer_id}`} className="font-medium hover:text-wine-800">{r.name}</Link></td>
              <td className="px-3 tabular">{r.phone}</td>
              <td className="px-3 text-right tabular">{r.orders}</td>
              <td className="px-3 text-right tabular">{r.usual_gap_days} days</td>
              <td className="px-3 text-right">{date(r.last_order)}</td>
              <td className="px-4 text-right font-medium tabular">{r.days_since_last}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function Inactive() {
  const [days, setDays] = useUrlState('days', '90')
  return (
    <DataTable path="/customers/insights/inactive" params={{ days }} search={false} rowTo={(r: any) => `/customers/${r.id}`}
      toolbar={<Segmented value={days as '60' | '90' | '180'} onChange={setDays} options={[{ value: '60', label: '60 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }]} />}
      columns={customerColumns} empty={{ title: 'Everyone has ordered recently' }} />
  )
}

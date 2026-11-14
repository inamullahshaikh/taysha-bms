import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { ago, label } from '../../lib/format'
import { useRefMap } from '../../lib/hooks'
import { BarList, ChartCard, StatTile } from '../../ui/charts'
import { CUSTOMERS, PRODUCTS, USERS, type FieldDef } from '../../ui/Form'
import { Segmented, Status } from '../../ui/kit'
import { ResourcePage } from '../../ui/Resource'

const CATEGORIES = ['quality', 'taste', 'packaging', 'delivery', 'service', 'billing', 'other']
const SEVERITY = ['low', 'medium', 'high']

const FIELDS: FieldDef[] = [
  { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, required: true },
  { name: 'severity', label: 'Severity', type: 'select', options: SEVERITY },
  { name: 'description', label: 'What happened', type: 'textarea', required: true },
  { name: 'customer_id', label: 'Customer', type: 'record', record: CUSTOMERS },
  { name: 'order_id', label: 'Order', type: 'record', record: { path: '/orders', label: (r) => `${r.number} · ${r.customer_name ?? 'Walk-in'}` } },
  { name: 'product_id', label: 'Product', type: 'record', record: PRODUCTS },
  { name: 'channel', label: 'Reported via', placeholder: 'WhatsApp, Instagram, call…' },
  { name: 'owner_id', label: 'Owner', type: 'record', record: USERS },
]
const EDIT_FIELDS: FieldDef[] = [
  { name: 'status', label: 'Status', type: 'select', options: ['open', 'in_progress', 'resolved', 'closed'] },
  { name: 'severity', label: 'Severity', type: 'select', options: SEVERITY },
  { name: 'owner_id', label: 'Owner', type: 'record', record: USERS, full: true },
  { name: 'resolution', label: 'Resolution', type: 'textarea', hint: 'Needed to resolve or close' },
]

export default function Complaints() {
  const [range, setRange] = useState<'month' | 'year'>('month')
  const user = useRefMap('/users')
  const { data: s } = useQuery({ queryKey: ['/complaints/stats', range], queryFn: () => api.get('/complaints/stats', { range }) })
  const hours = (v?: string | null) => (v == null ? '—' : `${Number(v).toFixed(1)} h`)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Segmented value={range} onChange={setRange} options={[{ value: 'month', label: 'This month' }, { value: 'year', label: 'This year' }]} />
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Complaints" value={s?.total ?? '—'} />
          <StatTile label="Still open" value={s?.open ?? '—'} to="/complaints?open_only=true" />
          <StatTile label="First response" value={hours(s?.avg_response_hours)} sub="average" />
          <StatTile label="Time to resolve" value={hours(s?.avg_resolution_hours)} sub="average" />
        </div>
        <ChartCard title="By category">
          <BarList items={Object.entries(s?.by_category ?? {}).map(([k, v]) => ({ label: label(k), value: v as number }))
            .sort((a, b) => b.value - a.value)} fmt={(v) => String(v)} empty="No complaints in this period" />
        </ChartCard>
      </div>
      <ResourcePage
        path="/complaints"
        feature="complaints"
        noun="complaint"
        search="Search complaints"
        fields={FIELDS}
        editFields={EDIT_FIELDS}
        archive={false}
        exportable={false}
        defaults={{ category: 'quality', severity: 'medium' }}
        filters={[
          { key: 'status', label: 'Status', options: ['open', 'in_progress', 'resolved', 'closed'] },
          { key: 'category', label: 'Category', options: CATEGORIES },
          { key: 'open_only', label: 'Open only', type: 'bool' },
        ]}
        columns={[
          { key: 'number', label: 'Complaint', render: (r: any) => (
            <span className="block max-w-md"><span className="font-medium">{r.number}</span>
              <span className="block truncate text-[12px] text-muted">{r.description}</span></span>
          ) },
          { key: 'category', label: 'Category', render: (r: any) => label(r.category) },
          { key: 'severity', label: 'Severity', render: (r: any) => <Status value={r.severity} tone={r.severity === 'low' ? 'neutral' : r.severity === 'medium' ? 'warn' : 'bad'} /> },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'owner_id', label: 'Owner', render: (r: any) => (r.owner_id ? user(r.owner_id) : <span className="text-muted">Unassigned</span>) },
          { key: 'created_at', label: 'Logged', render: (r: any) => ago(r.created_at) },
        ]}
      />
    </div>
  )
}

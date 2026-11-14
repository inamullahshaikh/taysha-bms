import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { compactMoney, date, label, money, today } from '../../lib/format'
import { useLookupName, useRefMap } from '../../lib/hooks'
import { Meter, StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { SUPPLIERS, type FieldDef } from '../../ui/Form'
import { Button, Card, Empty, ErrorNote, Facts, Loading, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const CATEGORIES = ['equipment', 'furniture', 'computer', 'appliance', 'vehicle', 'building', 'other']
const STATUSES = ['in_use', 'under_repair', 'idle', 'retired']

const CREATE: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, placeholder: 'Planetary mixer 20L' },
  { name: 'asset_code', label: 'Asset code', required: true },
  { name: 'category', label: 'Category', type: 'select', required: true, options: CATEGORIES },
  { name: 'status', label: 'Status', type: 'select', options: STATUSES },
  { name: 'cost', label: 'Cost', type: 'money' },
  { name: 'purchase_date', label: 'Bought on', type: 'date' },
  { name: 'supplier_id', label: 'Supplier', type: 'record', record: SUPPLIERS },
  { name: 'record_purchase', label: 'Record the purchase', type: 'select', options: [{ value: 'no', label: 'Already recorded' }, { value: 'cash', label: 'Paid cash' }, { value: 'bank_transfer', label: 'Paid by bank' }, { value: 'payable', label: 'Owed to supplier' }] },
  { name: 'useful_life_months', label: 'Useful life (months)', type: 'number' },
  { name: 'salvage_value', label: 'Salvage value', type: 'money' },
  { name: 'depreciation_start', label: 'Depreciation starts', type: 'date' },
  { name: 'warranty_until', label: 'Warranty until', type: 'date' },
  { name: 'serial_number', label: 'Serial number' },
  { name: 'location', label: 'Location' },
  { name: 'branch_id', label: 'Branch', type: 'lookup', lookup: 'branches' },
  { name: 'assigned_to_name', label: 'Assigned to' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]
const EDIT: FieldDef[] = CREATE.filter((f) => ['name', 'status', 'serial_number', 'location', 'branch_id', 'assigned_to_name', 'warranty_until', 'notes'].includes(f.name))

export default function Assets() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const totals = useQuery({ queryKey: ['/assets', 'totals'], queryFn: () => api.get('/assets') })
  const active = (totals.data?.items ?? []).filter((a: any) => a.status !== 'retired' && !a.disposed_on).length
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile label="Bought for" value={totals.data ? compactMoney(totals.data.total_cost) : '—'} />
        <StatTile label="Book value today" value={totals.data ? compactMoney(totals.data.total_book_value) : '—'} sub="after depreciation" />
        <StatTile label="In service" value={totals.data ? active : '—'} sub="assets not retired" />
      </div>
      <DataTable path="/assets" search={false} rowTo={(r: any) => `/assets/${r.id}`}
        filters={[{ key: 'status', label: 'Status', options: STATUSES }, { key: 'category', label: 'Category', options: CATEGORIES }]}
        toolbar={can('assets', 'create') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New asset</Button>}
        empty={{ title: 'No assets registered', body: 'Add equipment, furniture and vehicles to track their value and upkeep.', icon: <Wrench /> }}
        columns={[
          { key: 'name', label: 'Asset', render: (r: any) => <><span className="font-medium">{r.name}</span><span className="ml-2 text-muted">{r.asset_code}</span></> },
          { key: 'category', label: 'Category', render: (r: any) => label(r.category) },
          { key: 'location', label: 'Location' },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.disposed_on ? 'disposed' : r.status} /> },
          { key: 'cost', label: 'Cost', align: 'right', render: (r: any) => money(r.cost) },
          { key: 'book_value', label: 'Book value', align: 'right', render: (r: any) => money(r.book_value) },
        ]} />
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="New asset" fields={CREATE} initial={{ record_purchase: 'no', status: 'in_use', category: 'equipment' }}
        submit={async (body) => { await api.post('/assets', body); toast('Asset added'); qc.invalidateQueries({ queryKey: ['/assets'] }) }} />
    </div>
  )
}

const MAINT: FieldDef[] = [
  { name: 'kind', label: 'Type', type: 'select', required: true, options: ['scheduled', 'repair', 'inspection', 'replacement'] },
  { name: 'record_date', label: 'Date', type: 'date', required: true },
  { name: 'description', label: 'What was done', required: true, full: true },
  { name: 'cost', label: 'Cost', type: 'money' },
  { name: 'vendor', label: 'Done by' },
  { name: 'downtime_hours', label: 'Downtime (hours)', type: 'number' },
  { name: 'next_due_date', label: 'Next due', type: 'date' },
]
const DISPOSE: FieldDef[] = [
  { name: 'disposed_on', label: 'Date', type: 'date' },
  { name: 'proceeds', label: 'Sold for', type: 'money', hint: 'Leave empty if scrapped' },
  { name: 'method', label: 'Received by', type: 'select', options: ['cash', 'bank_transfer'] },
  { name: 'note', label: 'Note', type: 'textarea' },
]

export function AssetDetail() {
  const id = Number(useParams().id)
  const key = `/assets/${id}`
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [drawer, setDrawer] = useState<'edit' | 'maint' | 'dispose' | null>(null)
  const { data: a, error } = useQuery({ queryKey: [key], queryFn: () => api.get(key) })
  const maint = useQuery({ queryKey: [`${key}/maintenance`], queryFn: () => api.get<any[]>(`${key}/maintenance`) })
  const branch = useLookupName('branches')
  const supplier = useRefMap('/suppliers')
  const refresh = () => { qc.invalidateQueries({ queryKey: [key] }); qc.invalidateQueries({ queryKey: [`${key}/maintenance`] }); qc.invalidateQueries({ queryKey: ['/assets'] }) }
  if (error) return <ErrorNote error={error} />
  if (!a) return <Loading />
  const live = !a.disposed_on
  const depreciated = Number(a.accumulated_depreciation ?? 0)
  return (
    <>
      <RecordHeader back="/assets" backLabel="Assets" title={a.name} status={<Status value={a.disposed_on ? 'disposed' : a.status} />}
        meta={`${a.asset_code} · ${label(a.category)}${a.location ? ` · ${a.location}` : ''}`}
        actions={live && <>
          {can('assets', 'edit') && <Button icon={<Pencil className="size-4" />} onClick={() => setDrawer('edit')}>Edit</Button>}
          {can('assets', 'edit') && <Button icon={<Wrench className="size-4" />} onClick={() => setDrawer('maint')}>Log maintenance</Button>}
          {can('assets', 'archive') && <Button variant="ghost" className="text-bad" onClick={() => setDrawer('dispose')}>Dispose</Button>}
        </>} />
      <RecordLayout
        main={<>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatTile label="Cost" value={money(a.cost)} />
            <StatTile label="Book value" value={money(a.book_value)} sub={a.monthly_depreciation && `${money(a.monthly_depreciation)} a month`} />
            <StatTile label="Depreciated so far" value={money(a.accumulated_depreciation)} sub={a.useful_life_months && `over ${a.useful_life_months} months`} />
          </div>
          {Number(a.cost) > 0 && (
            <Card>
              <p className="mb-2 text-[12.5px] text-ink-2">Value used up</p>
              <Meter value={depreciated} max={Number(a.cost)} />
            </Card>
          )}
          <Card title="Details">
            <Facts items={[
              ['Bought on', date(a.purchase_date)], ['Supplier', a.supplier_id ? supplier(a.supplier_id) : null],
              ['Serial number', a.serial_number], ['Warranty until', a.warranty_until ? date(a.warranty_until) : null],
              ['Branch', a.branch_id ? branch(a.branch_id) : null], ['Assigned to', a.assigned_to_name],
              ['Salvage value', money(a.salvage_value)], ['Depreciation starts', date(a.depreciation_start)],
              ['Disposed', a.disposed_on ? `${date(a.disposed_on)} for ${money(a.disposal_proceeds)}` : undefined],
              ['Notes', a.notes],
            ]} />
          </Card>
          <Card pad={false} title="Maintenance and repairs">
            {!maint.data?.length ? <Empty title="Nothing logged yet" /> : (
              <ul className="divide-y divide-line">
                {maint.data.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-[13px]">
                    <div className="min-w-0">
                      <p className="font-medium">{m.description}</p>
                      <p className="text-[12px] text-muted">{label(m.kind)} · {date(m.record_date)}{m.vendor ? ` · ${m.vendor}` : ''}{m.downtime_hours ? ` · ${m.downtime_hours} h down` : ''}{m.next_due_date ? ` · next ${date(m.next_due_date)}` : ''}</p>
                    </div>
                    <span className="tabular font-medium">{money(m.cost)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>}
        side={<><Attachments entity="assets" id={id} canEdit={can('assets', 'edit')} /><History entity="assets" id={id} /></>}
      />
      <FormDrawer open={drawer === 'edit'} onClose={() => setDrawer(null)} title="Edit asset" mode="edit" fields={EDIT} initial={a}
        submit={async (body) => { await api.patch(key, body); toast('Saved'); refresh() }} />
      <FormDrawer open={drawer === 'maint'} onClose={() => setDrawer(null)} title="Log maintenance" fields={MAINT} initial={{ kind: 'repair', record_date: today() }}
        submit={async (body) => { await api.post('/asset-maintenance', { ...body, asset_id: id }); toast('Logged'); refresh() }} />
      <FormDrawer open={drawer === 'dispose'} onClose={() => setDrawer(null)} title={`Dispose of ${a.name}`} fields={DISPOSE} initial={{ disposed_on: today(), method: 'cash' }}
        submitLabel="Dispose" submit={async (body) => { await api.post(`${key}/dispose`, body); toast('Asset disposed'); refresh() }} />
    </>
  )
}

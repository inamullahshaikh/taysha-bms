import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, pct, qty } from '../../lib/format'
import { StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { PRODUCTS, type FieldDef } from '../../ui/Form'
import { Button, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'

export const STATUSES = ['draft', 'released', 'in_progress', 'completed', 'cancelled']

export const newOrderFields: FieldDef[] = [
  { name: 'product_id', label: 'Product', type: 'record', record: { ...PRODUCTS, params: { type: 'finished' } }, required: true, full: true },
  { name: 'quantity', label: 'Quantity to make', type: 'number', required: true },
  { name: 'warehouse_id', label: 'Warehouse', type: 'lookup', lookup: 'warehouses', hint: 'Default warehouse if empty' },
  { name: 'planned_start', label: 'Planned start', type: 'date' },
  { name: 'due_date', label: 'Due', type: 'date' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

function useCount(status: string) {
  return useQuery({
    queryKey: ['/production-orders', { status, count: true }],
    queryFn: () => api.get('/production-orders', { status, page_size: 1 }).then((p) => p.total as number),
  }).data
}

export default function ProductionOrders() {
  const can = useCan()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const running = useCount('in_progress')
  const released = useCount('released')
  const drafts = useCount('draft')
  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatTile label="In production" value={running ?? '—'} to="/production-orders?status=in_progress" />
        <StatTile label="Ready to start" value={released ?? '—'} sub="Materials reserved" to="/production-orders?status=released" />
        <StatTile label="Drafts" value={drafts ?? '—'} sub="Not yet released" to="/production-orders?status=draft" />
      </div>
      <DataTable
        path="/production-orders"
        rowTo={(r: any) => `/production-orders/${r.id}`}
        exportFeature={undefined}
        search="Search by number"
        filters={[
          { key: 'status', label: 'Status', options: STATUSES },
          { key: 'open_only', label: 'Open only', type: 'bool' },
        ]}
        empty={{ title: 'No production orders yet', body: 'Plan a run from a product and quantity, or from the production plan.' }}
        toolbar={can('production', 'create') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New production order</Button>}
        columns={[
          { key: 'number', label: 'Number', className: 'font-medium' },
          { key: 'product_name', label: 'Product' },
          { key: 'planned_quantity', label: 'Planned', align: 'right', render: (r: any) => qty(r.planned_quantity) },
          { key: 'output_quantity', label: 'Made', align: 'right', render: (r: any) => qty(r.output_quantity) },
          { key: 'yield_pct', label: 'Yield', align: 'right', render: (r: any) => pct(r.yield_pct) },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'planned_start', label: 'Start', render: (r: any) => date(r.planned_start) },
          { key: 'due_date', label: 'Due', render: (r: any) => date(r.due_date) },
        ]}
      />
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="New production order" submitLabel="Create and check materials"
        fields={newOrderFields}
        submit={async (body) => {
          const po = await api.post('/production-orders', body)
          navigate(`/production-orders/${po.id}`)
        }} />
    </>
  )
}

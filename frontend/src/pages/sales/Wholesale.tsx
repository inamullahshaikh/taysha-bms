import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, label, pct, qty } from '../../lib/format'
import { productLabel, useRefMap, useUrlState } from '../../lib/hooks'
import { BarList, ChartCard } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { CUSTOMERS, LineItems, PRODUCTS, cleanLines, type FieldDef, type FormValues } from '../../ui/Form'
import { Badge, Button, Card, Segmented } from '../../ui/kit'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const FREQ = ['weekly', 'fortnightly', 'monthly']
const REC_FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, placeholder: 'Weekly cafe restock', full: true },
  { name: 'customer_id', label: 'Customer', type: 'record', record: CUSTOMERS, required: true, createOnly: true, full: true },
  { name: 'frequency', label: 'Every', type: 'select', options: FREQ, required: true },
  { name: 'next_date', label: 'Next order on', type: 'date', required: true },
  { name: 'end_date', label: 'Stop after', type: 'date' },
  { name: 'auto_confirm', label: 'Confirm orders automatically', type: 'bool' },
  { name: 'active', label: 'Active', type: 'bool', editOnly: true },
]

export default function Wholesale() {
  const [view, setView] = useUrlState('view', 'recurring')
  return (
    <div className="flex flex-col gap-4">
      <div><Segmented value={view as 'recurring' | 'sell'} onChange={setView}
        options={[{ value: 'recurring', label: 'Recurring orders' }, { value: 'sell', label: 'Sell-through' }]} /></div>
      {view === 'sell' ? <SellThrough /> : <Recurring />}
    </div>
  )
}

function Recurring() {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const customer = useRefMap('/customers')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [lines, setLines] = useState<FormValues[]>([{ product_id: '', quantity: '' }])
  const refresh = () => qc.invalidateQueries({ queryKey: ['/recurring-orders'] })
  return (
    <>
      <DataTable
        path="/recurring-orders"
        search="Search"
        exportFeature="orders"
        onRowClick={can('orders', 'edit') ? setEditing : undefined}
        empty={{ title: 'No recurring orders', body: 'Set up standing orders for cafes and shops that reorder on a schedule.' }}
        toolbar={can('orders', 'create') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => { setLines([{ product_id: '', quantity: '' }]); setCreating(true) }}>New recurring order</Button>}
        columns={[
          { key: 'name', label: 'Name', render: (r: any) => <span className="font-medium">{r.name}</span> },
          { key: 'customer_id', label: 'Customer', render: (r: any) => customer(r.customer_id) },
          { key: 'frequency', label: 'Every', render: (r: any) => label(r.frequency) },
          { key: 'next_date', label: 'Next order', render: (r: any) => date(r.next_date) },
          { key: 'items', label: 'Items', render: (r: any) => `${r.template?.lines?.length ?? 0} products` },
          { key: 'active', label: 'Status', render: (r: any) => (r.active ? <Badge tone="good">Active</Badge> : <Badge>Paused</Badge>) },
        ]}
      />
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="New recurring order" fields={REC_FIELDS} wide
        initial={{ frequency: 'weekly', auto_confirm: false }}
        submit={async (b) => {
          await api.post('/recurring-orders', { ...b, template: { customer_id: b.customer_id, order_type: 'wholesale', lines: cleanLines(lines) } })
          toast('Recurring order created'); refresh()
        }}>
        <div>
          <p className="mb-1.5 text-[12.5px] font-medium text-ink-2">Products each time</p>
          <LineItems value={lines} onChange={setLines} addLabel="Add product" columns={[
            { name: 'product_id', label: 'Product', type: 'product', record: PRODUCTS },
            { name: 'quantity', label: 'Qty', type: 'number', width: '100px' },
          ]} />
        </div>
      </FormDrawer>
      {editing && (
        <FormDrawer open onClose={() => setEditing(null)} title={editing.name} mode="edit" fields={REC_FIELDS} initial={editing}
          submit={async (b) => { await api.patch(`/recurring-orders/${editing.id}`, b); toast('Saved'); refresh() }}
          footerExtra={can('orders', 'create') && (
            <Button variant="ghost" onClick={async () => {
              const o = await api.post(`/recurring-orders/${editing.id}/run-now`)
              navigate(`/orders/${o.id}`)
            }}>Create order now</Button>
          )} />
      )}
    </>
  )
}

const SELL_FIELDS: FieldDef[] = [
  { name: 'customer_id', label: 'Customer', type: 'record', record: CUSTOMERS, required: true, full: true },
  { name: 'product_id', label: 'Product', type: 'record', record: PRODUCTS, required: true, full: true },
  { name: 'period_start', label: 'From', type: 'date', required: true },
  { name: 'period_end', label: 'To', type: 'date', required: true },
  { name: 'opening', label: 'Opening stock', type: 'number' },
  { name: 'sold', label: 'Sold', type: 'number', required: true },
  { name: 'returned', label: 'Returned', type: 'number' },
  { name: 'closing', label: 'Closing stock', type: 'number' },
  { name: 'note', label: 'Note', type: 'textarea' },
]

function SellThrough() {
  const customer = useRefMap('/customers')
  const product = useRefMap('/products', productLabel)
  const [range, setRange] = useState<'month' | 'year'>('month')
  const { data } = useQuery({ queryKey: ['/reports/sell-through', range], queryFn: () => api.get('/reports/sell-through', { range }) })
  const rows = (data?.rows ?? []).filter((r: any) => Number(r.sell_in) > 0)
  const byCustomer = Object.values<{ label: string; value: number }>(rows.reduce((acc: Record<number, { label: string; value: number }>, r: any) => {
    // ponytail: summing a display chart in the browser; the report has no per-customer total
    acc[r.customer_id] ??= { label: customer(r.customer_id), value: 0 }
    acc[r.customer_id].value += Number(r.sell_in)
    return acc
  }, {})).sort((a, b) => b.value - a.value)
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <ChartCard title="Units delivered to stockists" sub={data ? `${date(data.from)} – ${date(data.to)}` : undefined}
          action={<Segmented value={range} onChange={setRange} options={[{ value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }]} />}>
          <BarList items={byCustomer} limit={8} fmt={(v) => qty(v)} empty="Nothing delivered in this period" />
        </ChartCard>
        <Card title="Sell-in vs sell-through" pad={false}>
          <div className="scroll-quiet max-h-80 overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface"><tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2 font-medium">Stockist</th><th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 text-right font-medium">Delivered</th><th className="px-3 py-2 text-right font-medium">Sold</th>
                <th className="px-4 py-2 text-right font-medium">Sell-through</th>
              </tr></thead>
              <tbody>
                {rows.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">{customer(r.customer_id)}</td>
                    <td className="max-w-56 truncate px-3 py-2">{product(r.product_id)}</td>
                    <td className="tabular px-3 py-2 text-right">{qty(r.sell_in)}</td>
                    <td className="tabular px-3 py-2 text-right">{r.sold == null ? <span className="text-muted">Not reported</span> : qty(r.sold)}</td>
                    <td className="tabular px-4 py-2 text-right">{r.sell_through_pct == null ? '—' : pct(r.sell_through_pct)}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">No deliveries in this period</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <h2 className="mt-2 text-[13.5px] font-semibold">Reported sales from stockists</h2>
      <ResourcePage path="/sell-through" feature="orders" noun="sell-through report" search={false} fields={SELL_FIELDS} editMethod="patch"
        columns={[
          { key: 'customer_id', label: 'Stockist', render: (r: any) => customer(r.customer_id) },
          { key: 'product_id', label: 'Product', render: (r: any) => product(r.product_id) },
          { key: 'period', label: 'Period', render: (r: any) => `${date(r.period_start)} – ${date(r.period_end)}` },
          { key: 'sold', label: 'Sold', align: 'right', render: (r: any) => qty(r.sold) },
          { key: 'closing', label: 'Closing stock', align: 'right', render: (r: any) => (r.closing == null ? '—' : qty(r.closing)) },
        ]} />
    </>
  )
}

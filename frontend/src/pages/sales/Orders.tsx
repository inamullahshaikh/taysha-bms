import { useQueries } from '@tanstack/react-query'
import { Plus, Printer } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, openFile } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, label, money } from '../../lib/format'
import { StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { Button, Status } from '../../ui/kit'
import { ORDER_STATUSES, ORDER_TYPES, PAYMENT_STATUSES, useChannels } from './common'

const TILES = [
  { label: 'Open orders', params: { open_only: true }, to: '/orders?open_only=true' },
  { label: 'Drafts', params: { status: 'draft' }, to: '/orders?status=draft' },
  { label: 'Unpaid', params: { payment_status: 'unpaid' }, to: '/orders?payment_status=unpaid' },
  { label: 'Cash on delivery due', params: { payment_status: 'cod_pending' }, to: '/orders?payment_status=cod_pending' },
]

export default function Orders() {
  const can = useCan()
  const navigate = useNavigate()
  const channels = useChannels()
  const [picked, setPicked] = useState<number[]>([])
  const counts = useQueries({
    queries: TILES.map((t) => ({ queryKey: ['/orders', 'count', t.params], queryFn: () => api.get('/orders', { ...t.params, page_size: 1 }) })),
  })
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map((t, i) => <StatTile key={t.label} label={t.label} value={counts[i].data?.total?.toLocaleString() ?? '—'} to={t.to} />)}
      </div>
      <DataTable
        path="/orders"
        search="Search number, customer, phone or tracking"
        exportFeature="orders"
        rowTo={(r: any) => `/orders/${r.id}`}
        empty={{ title: 'No orders yet', action: can('orders', 'create') ? <Button variant="primary" onClick={() => navigate('/orders/new')}>New order</Button> : undefined }}
        toolbar={<>
          {picked.length > 0 && (
            <Button size="sm" icon={<Printer className="size-3.5" />} onClick={() => openFile('/orders/dispatch-list', { ids: picked.join(',') })}>
              Dispatch list ({picked.length})
            </Button>
          )}
          {can('orders', 'create') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('/orders/new')}>New order</Button>}
        </>}
        filters={[
          { key: 'status', label: 'Status', options: ORDER_STATUSES },
          { key: 'payment_status', label: 'Payment', options: PAYMENT_STATUSES },
          { key: 'order_type', label: 'Type', options: ORDER_TYPES },
          { key: 'channel', label: 'Channel', options: channels.options },
          { key: 'date_from', label: 'From', type: 'date' },
          { key: 'date_to', label: 'To', type: 'date' },
          { key: 'open_only', label: 'Open only', type: 'bool' },
        ]}
        columns={[
          { key: 'pick', label: <span className="sr-only">Select</span>, render: (r: any) => (
            <input type="checkbox" aria-label={`Select ${r.number}`} className="size-4 accent-wine-800" checked={picked.includes(r.id)}
              onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} />
          ) },
          { key: 'number', label: 'Order', sort: 'number', render: (r: any) => <span className="font-medium">{r.number}</span> },
          { key: 'order_date', label: 'Date', sort: 'order_date', render: (r: any) => date(r.order_date) },
          { key: 'customer_name', label: 'Customer', render: (r: any) => (
            <span className="block">{r.customer_name ?? <span className="text-muted">Walk-in</span>}
              <span className="block text-[12px] text-muted">{[label(r.order_type), channels.name(r.channel)].join(' · ')}</span></span>
          ) },
          { key: 'status', label: 'Status', sort: 'status', render: (r: any) => <Status value={r.status} /> },
          { key: 'payment_status', label: 'Payment', render: (r: any) => <Status value={r.payment_status} /> },
          { key: 'grand_total', label: 'Total', sort: 'grand_total', align: 'right', render: (r: any) => (
            <span className="block">{money(r.grand_total)}
              {Number(r.balance_due) > 0 && r.status !== 'cancelled' && <span className="block text-[12px] text-muted">{money(r.balance_due)} due</span>}</span>
          ) },
        ]}
      />
    </div>
  )
}

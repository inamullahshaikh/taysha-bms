import { useQuery } from '@tanstack/react-query'
import { Layers } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, qty } from '../../lib/format'
import { productLabel, useAction, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { Badge, Button, Card, Facts, Loading, Status } from '../../ui/kit'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { MovementTable } from './Movements'

const DAY = 86_400_000
function Expiry({ value }: { value?: string | null }) {
  if (!value) return <span className="text-muted">—</span>
  const days = Math.ceil((new Date(`${value}T00:00:00`).getTime() - Date.now()) / DAY)
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {date(value)}
      {days < 0 ? <Badge tone="bad">Expired</Badge> : days <= 30 ? <Badge tone="warn">{days}d left</Badge> : null}
    </span>
  )
}

export default function Batches() {
  const product = useRefMap('/products', productLabel)
  return (
    <DataTable
      path="/stock/batches"
      search="Search batch number"
      filters={[
        { key: 'status', label: 'Any status', options: ['available', 'hold', 'rejected'] },
        { key: 'expiring_within_days', label: 'Any expiry', options: [{ value: 7, label: 'Expiring in 7 days' }, { value: 30, label: 'Expiring in 30 days' }, { value: 90, label: 'Expiring in 90 days' }] },
        { key: 'expired', label: 'Expired', type: 'bool' },
        { key: 'in_stock', label: 'In stock only', type: 'bool' },
      ]}
      rowTo={(b: any) => `/stock/batches/${b.id}`}
      empty={{ title: 'No batches yet', body: 'Batches are created when you receive or produce batch-tracked items.', icon: <Layers /> }}
      columns={[
        { key: 'number', label: 'Batch', render: (b: any) => <span className="font-medium">{b.number}</span> },
        { key: 'product_id', label: 'Item', render: (b: any) => product(b.product_id) },
        { key: 'mfg_date', label: 'Made', render: (b: any) => date(b.mfg_date) },
        { key: 'expiry_date', label: 'Expiry', render: (b: any) => <Expiry value={b.expiry_date} /> },
        { key: 'on_hand', label: 'On hand', align: 'right', render: (b: any) => qty(b.on_hand) },
        { key: 'status', label: 'Status', render: (b: any) => <Status value={b.status} /> },
      ]}
    />
  )
}

export function BatchPage() {
  const id = Number(useParams().id)
  const can = useCan()
  const product = useRefMap('/products', productLabel)
  const supplier = useRefMap('/suppliers')
  const { data: b, isLoading } = useQuery({
    queryKey: ['/stock/batches', 'one', id],
    queryFn: () => api.get<any>(`/stock/batches/${id}`).catch(() => null),
  })
  const set = useAction((status: string) => api.patch(`/stock/batches/${id}`, { status }), { success: 'Batch updated' })
  if (isLoading) return <Loading />
  if (!b) return <p className="text-ink-2">Batch not found.</p>
  return (
    <>
      <RecordHeader back="/stock/batches" backLabel="Batches" title={b.number} status={<Status value={b.status} />}
        meta={product(b.product_id)}
        actions={can('inventory', 'edit') && <>
          {b.status !== 'hold' && <Button onClick={() => set.mutate('hold')} loading={set.isPending}>Put on hold</Button>}
          {b.status !== 'available' && <Button variant="primary" onClick={() => set.mutate('available')} loading={set.isPending}>Release</Button>}
          {b.status !== 'rejected' && <Button variant="ghost" className="text-bad" onClick={() => set.mutate('rejected')}>Reject</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card><Facts cols={4} items={[
            ['On hand', qty(b.on_hand)], ['Made', date(b.mfg_date)], ['Expiry', <Expiry value={b.expiry_date} />],
            ['Supplier', b.supplier_id ? supplier(b.supplier_id) : '—'], ['Supplier batch', b.supplier_batch_no], ['Notes', b.notes],
          ]} /></Card>
          <MovementTable params={{ batch_id: id }} persist={false} hideProduct />
        </>}
        side={<History entity="batches" id={id} />} />
    </>
  )
}

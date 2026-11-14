import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { dateTime, qty } from '../../lib/format'
import { productLabel, useAction, useLookupName, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { Button, Card, Confirm, Facts, Loading, Status } from '../../ui/kit'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { StockActions } from './StockOps'

export default function Transfers() {
  const wh = useLookupName('warehouses')
  return (
    <DataTable
      path="/stock/transfers"
      search={false}
      filters={[{ key: 'status', label: 'Any status', options: ['draft', 'in_transit', 'received', 'cancelled'] }]}
      rowTo={(t: any) => `/stock/transfers/${t.id}`}
      toolbar={<StockActions />}
      empty={{ title: 'No transfers yet', body: 'Move stock between warehouses, stalls and hubs.', icon: <ArrowLeftRight /> }}
      columns={[
        { key: 'number', label: 'Transfer', render: (t: any) => <span className="font-medium">{t.number}</span> },
        { key: 'route', label: 'Route', render: (t: any) => <span>{wh(t.from_warehouse_id)} <span className="text-muted">→</span> {wh(t.to_warehouse_id)}</span> },
        { key: 'lines', label: 'Items', align: 'right', render: (t: any) => t.lines?.length ?? '—' },
        { key: 'shipped_at', label: 'Shipped', render: (t: any) => dateTime(t.shipped_at) },
        { key: 'status', label: 'Status', render: (t: any) => <Status value={t.status} /> },
      ]}
    />
  )
}

export function TransferPage() {
  const id = Number(useParams().id)
  const can = useCan()
  const wh = useLookupName('warehouses')
  const product = useRefMap('/products', productLabel)
  const [cancel, setCancel] = useState(false)
  const { data: t, isLoading } = useQuery({ queryKey: [`/stock/transfers/${id}`], queryFn: () => api.get(`/stock/transfers/${id}`) })
  const act = useAction((a: string) => api.post(`/stock/transfers/${id}/${a}`), { success: 'Transfer updated' })
  if (isLoading || !t) return <Loading />
  const edit = can('inventory', 'create')
  return (
    <>
      <RecordHeader back="/stock/transfers" backLabel="Transfers" title={t.number} status={<Status value={t.status} />}
        meta={<>{wh(t.from_warehouse_id)} → {wh(t.to_warehouse_id)}</>}
        actions={edit && <>
          {t.status === 'draft' && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('ship')}>Mark shipped</Button>}
          {t.status === 'in_transit' && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('receive')}>Receive all</Button>}
          {['draft', 'in_transit'].includes(t.status) && <Button variant="ghost" onClick={() => setCancel(true)}>Cancel</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card><Facts cols={4} items={[['Shipped', dateTime(t.shipped_at)], ['Received', dateTime(t.received_at)], ['Note', t.note]]} /></Card>
          <Card title="Items" pad={false}>
            <table className="w-full text-[13.5px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted"><th className="px-4 py-2 font-medium">Item</th><th className="px-4 py-2 text-right font-medium">Sent</th><th className="px-4 py-2 text-right font-medium">Received</th></tr></thead>
              <tbody>{t.lines?.map((l: any) => (
                <tr key={l.id} className="border-b border-line last:border-0"><td className="px-4 py-2.5">{product(l.product_id)}</td>
                  <td className="tabular px-4 text-right">{qty(l.quantity)}</td><td className="tabular px-4 text-right">{l.received_quantity == null ? '—' : qty(l.received_quantity)}</td></tr>
              ))}</tbody>
            </table>
          </Card>
        </>}
        side={<History entity="stock_transfers" id={id} />} />
      <Confirm open={cancel} onClose={() => setCancel(false)} danger title="Cancel this transfer?" confirmLabel="Cancel transfer"
        body="Stock that left the sending warehouse goes back to it." onConfirm={() => { act.mutate('cancel'); setCancel(false) }} />
    </>
  )
}

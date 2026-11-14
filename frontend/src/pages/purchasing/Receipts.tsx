import { useQuery } from '@tanstack/react-query'
import { PackageCheck } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { date, qty } from '../../lib/format'
import { productLabel, useLookupName, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { Card, Facts, Loading, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { LinesTable } from './common'

export default function Receipts() {
  const wh = useLookupName('warehouses')
  const supplier = useRefMap('/suppliers')
  return (
    <DataTable
      path="/goods-receipts"
      search="Search receipt number"
      rowTo={(r: any) => `/goods-receipts/${r.id}`}
      empty={{ title: 'No goods received yet', body: 'Receive deliveries from their purchase order.', icon: <PackageCheck /> }}
      columns={[
        { key: 'number', label: 'Receipt', render: (r: any) => <span className="font-medium">{r.number}</span> },
        { key: 'received_date', label: 'Received', render: (r: any) => date(r.received_date) },
        { key: 'supplier_id', label: 'Supplier', render: (r: any) => supplier(r.supplier_id) },
        { key: 'warehouse_id', label: 'Warehouse', render: (r: any) => wh(r.warehouse_id) },
        { key: 'lines', label: 'Items', align: 'right', render: (r: any) => r.lines?.length ?? '—' },
        { key: 'supplier_delivery_note', label: 'Delivery note', render: (r: any) => <span className="text-ink-2">{r.supplier_delivery_note ?? '—'}</span> },
      ]}
    />
  )
}

export function ReceiptPage() {
  const id = Number(useParams().id)
  const wh = useLookupName('warehouses')
  const supplier = useRefMap('/suppliers')
  const product = useRefMap('/products', productLabel)
  const { data: r, isLoading } = useQuery({ queryKey: [`/goods-receipts/${id}`], queryFn: () => api.get(`/goods-receipts/${id}`) })
  if (isLoading || !r) return <Loading />
  return (
    <>
      <RecordHeader back="/goods-receipts" backLabel="Goods receipts" title={r.number}
        meta={<><Link to={`/suppliers/${r.supplier_id}`} className="hover:text-wine-800">{supplier(r.supplier_id)}</Link> · {date(r.received_date)}</>} />
      <RecordLayout
        main={<>
          <Card><Facts cols={4} items={[
            ['Purchase order', r.purchase_order_id ? <Link className="text-wine-700 hover:underline" to={`/purchase-orders/${r.purchase_order_id}`}>Open order</Link> : '—'],
            ['Warehouse', wh(r.warehouse_id)], ['Delivery note', r.supplier_delivery_note], ['Note', r.note],
          ]} /></Card>
          <Card title="Items" pad={false}>
            <LinesTable rows={r.lines} cols={[
              { label: 'Item', render: (l: any) => product(l.product_id) },
              { label: 'Qty', align: 'right', render: (l: any) => <>{qty(l.quantity)}{l.unit && <span className="text-muted"> {l.unit}</span>}</> },
              { label: 'Batch', render: (l: any) => (l.batch_id ? <Link className="text-wine-700 hover:underline" to={`/stock/batches/${l.batch_id}`}>View batch</Link> : '—') },
              { label: 'Expiry', render: (l: any) => date(l.expiry_date) },
              { label: 'Quality', render: (l: any) => <Status value={l.qc_result} /> },
            ]} />
          </Card>
        </>}
        side={<><Attachments entity="goods_receipts" id={id} /><History entity="goods_receipts" id={id} /></>} />
    </>
  )
}

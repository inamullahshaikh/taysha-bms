import { useQuery } from '@tanstack/react-query'
import { ClipboardPen, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, dateTime, money, qty } from '../../lib/format'
import { productLabel, useAction, useLookupName, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { SUPPLIERS } from '../../ui/Form'
import { Button, Card, Confirm, Facts, Loading, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { LinesDrawer } from '../inventory/LinesDrawer'
import { LinesTable } from './common'

export default function Requests() {
  const can = useCan()
  const user = useRefMap('/users')
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  return (
    <>
      <DataTable
        path="/purchase-requests"
        search={false}
        filters={[{ key: 'status', label: 'Any status', options: ['requested', 'approved', 'rejected', 'converted', 'cancelled'] }]}
        rowTo={(r: any) => `/purchase-requests/${r.id}`}
        toolbar={can('purchasing', 'create') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Request items</Button>}
        empty={{ title: 'No purchase requests', body: 'Anyone running low can ask for items; a manager approves and turns them into purchase orders.', icon: <ClipboardPen /> }}
        columns={[
          { key: 'number', label: 'Request', render: (r: any) => <span className="font-medium">{r.number}</span> },
          { key: 'created_by_id', label: 'Asked by', render: (r: any) => user(r.created_by_id) },
          { key: 'needed_by', label: 'Needed by', render: (r: any) => date(r.needed_by) },
          { key: 'lines', label: 'Items', align: 'right', render: (r: any) => r.lines?.length ?? '—' },
          { key: 'estimated_total', label: 'Estimate', align: 'right', render: (r: any) => money(r.estimated_total) },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
        ]}
      />
      <LinesDrawer open={open} onClose={() => setOpen(false)} title="Request items" scan submitLabel="Send request"
        fields={[
          { name: 'needed_by', label: 'Needed by', type: 'date' },
          { name: 'warehouse_id', label: 'For warehouse', type: 'lookup', lookup: 'warehouses' },
          { name: 'note', label: 'Why', full: true },
        ]}
        columns={[
          { name: 'product_id', label: 'Item', type: 'product' },
          { name: 'quantity', label: 'Qty', type: 'number', width: '90px' },
          { name: 'estimated_unit_cost', label: 'Est. unit cost', type: 'money', width: '130px' },
          { name: 'suggested_supplier_id', label: 'Supplier (optional)', type: 'record', record: SUPPLIERS },
        ]}
        submit={async (b) => { const r = await api.post('/purchase-requests', b); nav(`/purchase-requests/${r.id}`) }} />
    </>
  )
}

export function RequestPage() {
  const id = Number(useParams().id)
  const can = useCan()
  const nav = useNavigate()
  const user = useRefMap('/users')
  const product = useRefMap('/products', productLabel)
  const supplier = useRefMap('/suppliers')
  const wh = useLookupName('warehouses')
  const key = [`/purchase-requests/${id}`]
  const { data: r, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get(`/purchase-requests/${id}`) })
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'cancel' | 'convert' | null>(null)
  const act = useAction(({ a, note }: { a: string; note?: string }) => api.post(`/purchase-requests/${id}/${a}`, a === 'cancel' ? {} : { note }),
    { success: 'Request updated', invalidate: [key, ['/purchase-requests']] })
  if (isLoading || !r) return <Loading />
  const close = () => setDialog(null)
  return (
    <>
      <RecordHeader back="/purchase-requests" backLabel="Purchase requests" title={r.number} status={<Status value={r.status} />}
        meta={<>Asked by {user(r.created_by_id)} · {dateTime(r.created_at)}</>}
        actions={<>
          {['requested', 'approved'].includes(r.status) && can('purchasing', 'create') && <Button variant="ghost" onClick={() => setDialog('cancel')}>Withdraw</Button>}
          {r.status === 'requested' && can('purchasing', 'approve') && <>
            <Button onClick={() => setDialog('reject')}>Reject</Button>
            <Button variant="primary" onClick={() => setDialog('approve')}>Approve</Button>
          </>}
          {r.status === 'approved' && can('purchasing', 'create') && <Button variant="primary" onClick={() => setDialog('convert')}>Create purchase order</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card><Facts cols={4} items={[
            ['Needed by', date(r.needed_by)], ['For', r.warehouse_id ? wh(r.warehouse_id) : '—'], ['Estimate', money(r.estimated_total)],
            ['Decision', r.decided_at ? `${user(r.decided_by_id)}, ${dateTime(r.decided_at)}` : '—'],
            ...(r.note ? [['Why', r.note] as [string, string]] : []), ...(r.decision_note ? [['Decision note', r.decision_note] as [string, string]] : []),
          ]} /></Card>
          <Card title="Items" pad={false}>
            <LinesTable rows={r.lines} cols={[
              { label: 'Item', render: (l: any) => <Link to={`/products/${l.product_id}`} className="hover:text-wine-800">{product(l.product_id)}</Link> },
              { label: 'Qty', align: 'right', render: (l: any) => <>{qty(l.quantity)}{l.unit && <span className="text-muted"> {l.unit}</span>}</> },
              { label: 'Est. unit cost', align: 'right', render: (l: any) => money(l.estimated_unit_cost, { paisa: true }) },
              { label: 'Supplier', render: (l: any) => (l.suggested_supplier_id ? supplier(l.suggested_supplier_id) : <span className="text-muted">Not chosen</span>) },
            ]} />
          </Card>
        </>}
        side={<History entity="purchase_requests" id={id} />} />
      <Confirm open={dialog === 'approve'} onClose={close} title="Approve this request?" confirmLabel="Approve" note={{ label: 'Note (optional)' }}
        onConfirm={(n) => { act.mutate({ a: 'approve', note: n }); close() }} />
      <Confirm open={dialog === 'reject'} onClose={close} danger title="Reject this request?" confirmLabel="Reject" note={{ label: 'Reason', required: true }}
        onConfirm={(n) => { act.mutate({ a: 'reject', note: n }); close() }} />
      <Confirm open={dialog === 'cancel'} onClose={close} title="Withdraw this request?" confirmLabel="Withdraw"
        onConfirm={() => { act.mutate({ a: 'cancel' }); close() }} />
      <FormDrawer open={dialog === 'convert'} onClose={close} title="Create purchase order" submitLabel="Create"
        fields={[{ name: 'supplier_id', label: 'Supplier', type: 'record', record: SUPPLIERS, full: true, hint: 'Leave empty to split by each item’s suggested or preferred supplier' }]}
        submit={async (b) => { const pos = await api.post<any[]>(`/purchase-requests/${id}/convert`, b); nav(pos.length === 1 ? `/purchase-orders/${pos[0].id}` : '/purchase-orders?status=draft') }} />
    </>
  )
}

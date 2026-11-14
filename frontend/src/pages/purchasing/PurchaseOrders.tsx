import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, PackageCheck, Plus, Receipt, Truck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, openFile } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { compactMoney, date, dateTime, money, qty } from '../../lib/format'
import { productLabel, useAction, useLookupName, useLookups, useRefMap } from '../../lib/hooks'
import { StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { Button, Card, Confirm, Drawer, ErrorNote, Facts, Field, Input, Loading, Select, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { useToast } from '../../ui/toast'
import { LinesDrawer } from '../inventory/LinesDrawer'
import { useOpsMetrics } from '../inventory/shared'
import { LinesTable, moneyFoot, poCols, poFields } from './common'

const STATUSES = ['draft', 'requested', 'approved', 'ordered', 'partially_received', 'received', 'cancelled']

export default function PurchaseOrders() {
  const can = useCan()
  const nav = useNavigate()
  const m = useOpsMetrics().data?.purchasing
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      {m && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Bought this month" value={compactMoney(m.purchases)} sub={`${m.active_suppliers} active suppliers`} />
          <StatTile label="Waiting for approval" value={m.pending_approval} to="/purchase-orders?status=requested" sub="Orders and requests" />
          <StatTile label="Awaiting delivery" value={m.awaiting_delivery} to="/purchase-orders?open_only=true" sub="Sent, not fully received" />
          {can('supplier_bills')
            ? <StatTile label="We owe suppliers" value={compactMoney(m.outstanding_payables)} to="/supplier-bills?unpaid=true" sub={Number(m.overdue_payables) ? `${compactMoney(m.overdue_payables)} overdue` : 'Nothing overdue'} />
            : <StatTile label="Price changes, 30 days" value={m.price_changes_30d} to="/purchasing/price-changes" />}
        </div>
      )}
      <DataTable
        path="/purchase-orders"
        search="Search PO number"
        filters={[
          { key: 'status', label: 'Any status', options: STATUSES },
          { key: 'open_only', label: 'Open only', type: 'bool' },
          { key: 'date_from', label: 'From', type: 'date' },
          { key: 'date_to', label: 'To', type: 'date' },
        ]}
        rowTo={(p: any) => `/purchase-orders/${p.id}`}
        exportFeature="purchasing"
        toolbar={can('purchasing', 'create') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New purchase order</Button>}
        empty={{ title: 'No purchase orders yet', icon: <Truck /> }}
        columns={[
          { key: 'number', label: 'PO', sort: 'number', render: (p: any) => <span className="font-medium">{p.number}</span> },
          { key: 'supplier_name', label: 'Supplier' },
          { key: 'order_date', label: 'Ordered', sort: 'order_date', render: (p: any) => date(p.order_date) },
          { key: 'expected_date', label: 'Expected', render: (p: any) => date(p.expected_date) },
          { key: 'grand_total', label: 'Total', align: 'right', render: (p: any) => money(p.grand_total) },
          { key: 'status', label: 'Status', render: (p: any) => <Status value={p.status} /> },
        ]}
      />
      <LinesDrawer open={open} onClose={() => setOpen(false)} title="New purchase order" scan fields={poFields} columns={poCols} submitLabel="Save draft"
        submit={async (b) => { const po = await api.post('/purchase-orders', b); nav(`/purchase-orders/${po.id}`) }} />
    </div>
  )
}

export function PurchaseOrderPage() {
  const id = Number(useParams().id)
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const wh = useLookupName('warehouses')
  const user = useRefMap('/users')
  const key = [`/purchase-orders/${id}`]
  const { data: po, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get(`/purchase-orders/${id}`) })
  const [dialog, setDialog] = useState<'edit' | 'receive' | 'bill' | 'approve' | 'reject' | 'cancel' | null>(null)
  const act = useAction(({ a, note }: { a: string; note?: string }) => api.post(`/purchase-orders/${id}/${a}`, note === undefined ? {} : { note }),
    { success: 'Purchase order updated', invalidate: [key, ['/purchase-orders']] })
  if (isLoading || !po) return <Loading />

  const s = po.status
  const close = () => setDialog(null)
  const run = (a: string, note?: string) => { act.mutate({ a, note }); close() }

  return (
    <>
      <RecordHeader back="/purchase-orders" backLabel="Purchase orders" title={po.number} status={<Status value={s} />}
        meta={<><Link to={`/suppliers/${po.supplier_id}`} className="hover:text-wine-800">{po.supplier_name}</Link> · ordered {date(po.order_date)}</>}
        actions={<>
          <Button icon={<FileText className="size-4" />} onClick={() => openFile(`/purchase-orders/${id}/pdf`)}>PDF</Button>
          {s === 'draft' && can('purchasing', 'edit') && <Button onClick={() => setDialog('edit')}>Edit</Button>}
          {['draft', 'requested', 'approved', 'ordered'].includes(s) && can('purchasing', 'edit') && <Button variant="ghost" onClick={() => setDialog('cancel')}>Cancel</Button>}
          {s === 'draft' && can('purchasing', 'create') && <Button variant="primary" loading={act.isPending} onClick={() => run('submit')}>Submit for approval</Button>}
          {s === 'requested' && can('purchasing', 'approve') && <>
            <Button onClick={() => setDialog('reject')}>Send back</Button>
            <Button variant="primary" onClick={() => setDialog('approve')}>Approve</Button>
          </>}
          {s === 'approved' && can('purchasing', 'edit') && <Button variant="primary" loading={act.isPending} onClick={() => run('send')}>Mark as sent</Button>}
          {['approved', 'ordered', 'partially_received'].includes(s) && can('inventory', 'create') && <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setDialog('receive')}>Receive goods</Button>}
          {['partially_received', 'received'].includes(s) && can('supplier_bills', 'create') && po.lines.some((l: any) => Number(l.billed_quantity) < Number(l.quantity)) &&
            <Button icon={<Receipt className="size-4" />} onClick={() => setDialog('bill')}>Enter bill</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card>
            <Facts cols={4} items={[
              ['Expected', date(po.expected_date)], ['Deliver to', po.warehouse_id ? wh(po.warehouse_id) : '—'],
              ['Approved', po.approved_at ? `${user(po.approved_by_id)}, ${dateTime(po.approved_at)}` : '—'], ['Sent', dateTime(po.ordered_at)],
              ...(po.terms ? [['Terms', po.terms] as [string, string]] : []), ...(po.notes ? [['Notes', po.notes] as [string, string]] : []),
              ...(po.cancelled_reason ? [['Cancelled because', po.cancelled_reason] as [string, string]] : []),
            ]} />
            {po.purchase_request_id && <p className="mt-3 text-[12.5px] text-ink-2">From <Link className="text-wine-700 hover:underline" to={`/purchase-requests/${po.purchase_request_id}`}>purchase request</Link></p>}
          </Card>
          <Card title="Items" pad={false}>
            <LinesTable rows={po.lines}
              foot={moneyFoot(po, [['Subtotal', 'subtotal'], ['Tax', 'tax_total'], ['Total', 'grand_total']])}
              cols={[
                { label: 'Item', render: (l: any) => <Link to={`/products/${l.product_id}`} className="hover:text-wine-800">{l.description}</Link> },
                { label: 'Ordered', align: 'right', render: (l: any) => <>{qty(l.quantity)}{l.unit && <span className="text-muted"> {l.unit}</span>}</> },
                { label: 'Received', align: 'right', render: (l: any) => qty(l.received_base_qty) },
                { label: 'Billed', align: 'right', render: (l: any) => qty(l.billed_quantity) },
                { label: 'Unit cost', align: 'right', render: (l: any) => money(l.unit_cost, { paisa: true }) },
                { label: 'Total', align: 'right', render: (l: any) => money(l.line_total, { paisa: true }) },
              ]} />
          </Card>
          {['partially_received', 'received'].includes(s) && <DataTable path="/goods-receipts" params={{ purchase_order_id: id }} persist={false} search={false} dense
            rowTo={(r: any) => `/goods-receipts/${r.id}`}
            empty={{ title: 'Nothing received yet' }}
            columns={[
              { key: 'number', label: 'Receipt', render: (r: any) => <span className="font-medium">{r.number}</span> },
              { key: 'received_date', label: 'Received', render: (r: any) => date(r.received_date) },
              { key: 'warehouse_id', label: 'Warehouse', render: (r: any) => wh(r.warehouse_id) },
              { key: 'supplier_delivery_note', label: 'Delivery note', render: (r: any) => r.supplier_delivery_note ?? '—' },
            ]} />}
        </>}
        side={<>
          <Attachments entity="purchase_orders" id={id} canEdit={can('purchasing', 'edit')} />
          <History entity="purchase_orders" id={id} />
        </>} />

      <LinesDrawer open={dialog === 'edit'} onClose={close} title={`Edit ${po.number}`} scan fields={poFields} columns={poCols}
        initial={po} initialLines={po.lines.map((l: any) => ({ product_id: String(l.product_id), quantity: l.quantity, unit: l.unit ?? '', unit_cost: l.unit_cost, tax_rate: l.tax_rate }))}
        submit={async (b) => { await api.put(`/purchase-orders/${id}`, b); toast('Saved'); qc.invalidateQueries({ queryKey: key }) }} />
      {dialog === 'receive' && <ReceiveDrawer po={po} onClose={close} onDone={() => { toast('Goods received'); qc.invalidateQueries() }} />}
      <FormDrawer open={dialog === 'bill'} onClose={close} title="Enter supplier bill" submitLabel="Create bill"
        fields={[
          { name: 'supplier_invoice_number', label: 'Their invoice number' },
          { name: 'bill_date', label: 'Bill date', type: 'date' },
          { name: 'due_date', label: 'Due', type: 'date', hint: 'Empty uses the supplier’s payment terms' },
          { name: 'withholding_tax', label: 'Withholding tax', type: 'money' },
          { name: 'notes', label: 'Notes', type: 'textarea' },
        ]}
        submit={async (b) => { await api.post(`/purchase-orders/${id}/bill`, b); toast('Bill created for everything received and not yet billed'); qc.invalidateQueries() }}>
        <p className="text-[12.5px] text-ink-2">Bills everything received on this order that hasn’t been billed yet, at the order prices.</p>
      </FormDrawer>
      <Confirm open={dialog === 'approve'} onClose={close} title={`Approve ${po.number}?`} confirmLabel="Approve" note={{ label: 'Note (optional)' }}
        body={<>Total {money(po.grand_total)} to {po.supplier_name}.</>} onConfirm={(n) => run('approve', n)} />
      <Confirm open={dialog === 'reject'} onClose={close} title="Send back to draft?" confirmLabel="Send back" note={{ label: 'What needs to change', required: true }}
        onConfirm={(n) => run('reject', n)} />
      <Confirm open={dialog === 'cancel'} onClose={close} danger title={`Cancel ${po.number}?`} confirmLabel="Cancel order" note={{ label: 'Reason', required: true }}
        onConfirm={(n) => run('cancel', n)} />
    </>
  )
}

/** Receive against the PO: quantity, batch, expiry and QC per line. */
function ReceiveDrawer({ po, onClose, onDone }: { po: any; onClose: () => void; onDone: () => void }) {
  const product = useRefMap('/products', productLabel)
  const { data: lk } = useLookups()
  const [head, setHead] = useState({ warehouse_id: String(po.warehouse_id ?? ''), received_date: '', supplier_delivery_note: '', note: '' })
  const [lines, setLines] = useState<Record<number, any>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    // prefill what's still due; the server checks over-receipts
    setLines(Object.fromEntries(po.lines.map((l: any) => {
      const due = Math.max(Number(l.base_quantity) - Number(l.received_base_qty), 0)
      return [l.id, { quantity: due ? String(due) : '', batch_number: '', expiry_date: '', qc_result: 'pass' }]
    })))
  }, [po])
  const set = (id: number, k: string, v: string) => setLines((s) => ({ ...s, [id]: { ...s[id], [k]: v } }))
  const save = async () => {
    setBusy(true); setError(null)
    try {
      await api.post(`/purchase-orders/${po.id}/receive`, {
        warehouse_id: head.warehouse_id ? Number(head.warehouse_id) : null, received_date: head.received_date || null,
        supplier_delivery_note: head.supplier_delivery_note || null, note: head.note || null,
        lines: Object.entries(lines).filter(([, l]) => Number(l.quantity) > 0).map(([id, l]) => ({
          po_line_id: Number(id), quantity: l.quantity, batch_number: l.batch_number || null, expiry_date: l.expiry_date || null, qc_result: l.qc_result,
        })),
      })
      onDone(); onClose()
    } catch (e) { setError(e instanceof ApiError ? e : e) } finally { setBusy(false) }
  }
  return (
    <Drawer open onClose={onClose} title={`Receive goods · ${po.number}`} wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Receive</Button></>}>
      <div className="flex flex-col gap-5">
        {error != null && <ErrorNote error={error} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Into warehouse"><Select value={head.warehouse_id} onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })} placeholder="Choose…" options={(lk?.warehouses ?? []).map((w) => ({ value: w.id, label: w.name! }))} /></Field>
          <Field label="Received on"><Input type="date" value={head.received_date} onChange={(e) => setHead({ ...head, received_date: e.target.value })} /></Field>
          <Field label="Their delivery note"><Input value={head.supplier_delivery_note} onChange={(e) => setHead({ ...head, supplier_delivery_note: e.target.value })} /></Field>
        </div>
        <ul className="flex flex-col gap-3">
          {po.lines.map((l: any) => (
            <li key={l.id} className="rounded-lg border border-line p-3">
              <p className="mb-2 text-[13.5px] font-medium">{product(l.product_id)}<span className="ml-2 font-normal text-muted">ordered {qty(l.base_quantity)}, received {qty(l.received_base_qty)}</span></p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Quantity now"><Input type="number" inputMode="decimal" step="any" value={lines[l.id]?.quantity ?? ''} onChange={(e) => set(l.id, 'quantity', e.target.value)} /></Field>
                <Field label="Batch"><Input value={lines[l.id]?.batch_number ?? ''} onChange={(e) => set(l.id, 'batch_number', e.target.value)} placeholder="Auto if empty" /></Field>
                <Field label="Expiry"><Input type="date" value={lines[l.id]?.expiry_date ?? ''} onChange={(e) => set(l.id, 'expiry_date', e.target.value)} /></Field>
                <Field label="Quality check"><Select value={lines[l.id]?.qc_result ?? 'pass'} onChange={(e) => set(l.id, 'qc_result', e.target.value)} options={['pass', 'fail', 'pending']} /></Field>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-[12.5px] text-ink-2">Failed or pending items arrive on hold and can’t be used until released.</p>
      </div>
    </Drawer>
  )
}

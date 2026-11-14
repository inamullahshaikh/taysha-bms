import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Banknote, Plus, Receipt } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, label, money, qty } from '../../lib/format'
import { useAction, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { PRODUCTS, SUPPLIERS } from '../../ui/Form'
import { Button, Card, Confirm, Empty, Facts, Loading, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { useToast } from '../../ui/toast'
import { LinesDrawer } from '../inventory/LinesDrawer'
import { LinesTable, moneyFoot } from './common'

export default function Bills() {
  const can = useCan()
  const nav = useNavigate()
  const supplier = useRefMap('/suppliers')
  const [open, setOpen] = useState(false)
  return (
    <>
      <DataTable
        path="/supplier-bills"
        search="Search bill or invoice number"
        filters={[
          { key: 'status', label: 'Any status', options: ['unpaid', 'partially_paid', 'overdue', 'paid', 'cancelled'] },
          { key: 'unpaid', label: 'Unpaid only', type: 'bool' },
          { key: 'date_from', label: 'From', type: 'date' },
          { key: 'date_to', label: 'To', type: 'date' },
        ]}
        rowTo={(b: any) => `/supplier-bills/${b.id}`}
        exportFeature="supplier_bills"
        toolbar={can('supplier_bills', 'create') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New bill</Button>}
        empty={{ title: 'No supplier bills', body: 'Bills for goods come from their purchase order; enter services and one-off bills here.', icon: <Receipt /> }}
        columns={[
          { key: 'number', label: 'Bill', render: (b: any) => <div><p className="font-medium">{b.number}</p>{b.supplier_invoice_number && <p className="text-[12px] text-muted">{b.supplier_invoice_number}</p>}</div> },
          { key: 'supplier_id', label: 'Supplier', render: (b: any) => supplier(b.supplier_id) },
          { key: 'bill_date', label: 'Date', render: (b: any) => date(b.bill_date) },
          { key: 'due_date', label: 'Due', render: (b: any) => date(b.due_date) },
          { key: 'grand_total', label: 'Total', align: 'right', render: (b: any) => money(b.grand_total) },
          { key: 'balance_due', label: 'Balance', align: 'right', render: (b: any) => <span className={Number(b.balance_due) ? 'font-medium' : 'text-muted'}>{money(b.balance_due)}</span> },
          { key: 'status', label: 'Status', render: (b: any) => <Status value={b.status} /> },
        ]}
      />
      <LinesDrawer open={open} onClose={() => setOpen(false)} title="New supplier bill" submitLabel="Create bill"
        fields={[
          { name: 'supplier_id', label: 'Supplier', type: 'record', record: SUPPLIERS, required: true, full: true },
          { name: 'supplier_invoice_number', label: 'Their invoice number' },
          { name: 'bill_date', label: 'Bill date', type: 'date' },
          { name: 'due_date', label: 'Due', type: 'date' },
          { name: 'withholding_tax', label: 'Withholding tax', type: 'money' },
          { name: 'notes', label: 'Notes', type: 'textarea' },
        ]}
        columns={[
          { name: 'description', label: 'Description', type: 'text' },
          { name: 'product_id', label: 'Item (optional)', type: 'record', record: PRODUCTS },
          { name: 'quantity', label: 'Qty', type: 'number', width: '80px' },
          { name: 'unit_cost', label: 'Unit cost', type: 'money', width: '120px' },
          { name: 'tax_rate', label: 'Tax %', type: 'number', width: '80px' },
        ]}
        submit={async (b) => { const bill = await api.post('/supplier-bills', b); nav(`/supplier-bills/${bill.id}`) }} />
    </>
  )
}

export function BillPage() {
  const id = Number(useParams().id)
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const supplier = useRefMap('/suppliers')
  const key = [`/supplier-bills/${id}`]
  const { data: b, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get(`/supplier-bills/${id}`) })
  const pays = useQuery({ queryKey: [`/supplier-bills/${id}/payments`], queryFn: () => api.get<any[]>(`/supplier-bills/${id}/payments`) })
  const [pay, setPay] = useState(false)
  const [cancel, setCancel] = useState(false)
  const cancelBill = useAction((note: string) => api.post(`/supplier-bills/${id}/cancel`, { note }), { success: 'Bill cancelled', invalidate: [key] })
  if (isLoading || !b) return <Loading />
  const open = !['paid', 'cancelled'].includes(b.status)
  return (
    <>
      <RecordHeader back="/supplier-bills" backLabel="Supplier bills" title={b.number} status={<Status value={b.status} />}
        meta={<><Link to={`/suppliers/${b.supplier_id}`} className="hover:text-wine-800">{supplier(b.supplier_id)}</Link>{b.supplier_invoice_number && ` · their invoice ${b.supplier_invoice_number}`}</>}
        actions={<>
          {b.status !== 'cancelled' && Number(b.paid_total) === 0 && can('supplier_bills', 'edit') && <Button variant="ghost" onClick={() => setCancel(true)}>Cancel bill</Button>}
          {open && can('supplier_bills', 'create') && <Button variant="primary" icon={<Banknote className="size-4" />} onClick={() => setPay(true)}>Record payment</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card><Facts cols={4} items={[
            ['Bill date', date(b.bill_date)], ['Due', date(b.due_date)], ['Paid', money(b.paid_total, { paisa: true })],
            ['Balance', <span className="font-semibold">{money(b.balance_due, { paisa: true })}</span>],
            ...(b.purchase_order_id ? [['Purchase order', <Link className="text-wine-700 hover:underline" to={`/purchase-orders/${b.purchase_order_id}`}>Open order</Link>] as [string, any]] : []),
            ...(b.notes ? [['Notes', b.notes] as [string, string]] : []),
          ]} /></Card>
          <Card title="Lines" pad={false}>
            <LinesTable rows={b.lines ?? []}
              foot={moneyFoot(b, [['Subtotal', 'subtotal'], ['Tax', 'tax_total'], ...(Number(b.withholding_tax) ? [['Withholding tax', 'withholding_tax'] as [string, string]] : []), ['Total', 'grand_total']])}
              cols={[
                { label: 'Description', render: (l: any) => l.description },
                { label: 'Qty', align: 'right', render: (l: any) => qty(l.quantity) },
                { label: 'Unit cost', align: 'right', render: (l: any) => money(l.unit_cost, { paisa: true }) },
                { label: 'Tax', align: 'right', render: (l: any) => money(l.tax_amount, { paisa: true }) },
                { label: 'Total', align: 'right', render: (l: any) => money(l.line_total, { paisa: true }) },
              ]} />
          </Card>
          <Card title="Payments" pad={false}>
            {!pays.data?.length ? <Empty title="No payments yet" /> : (
              <LinesTable rows={pays.data} cols={[
                { label: 'Payment', render: (p: any) => p.number },
                { label: 'Date', render: (p: any) => date(p.payment_date) },
                { label: 'Method', render: (p: any) => label(p.method) },
                { label: 'Reference', render: (p: any) => p.reference ?? '—' },
                { label: 'Amount', align: 'right', render: (p: any) => money(p.amount, { paisa: true }) },
              ]} />
            )}
          </Card>
        </>}
        side={<><Attachments entity="supplier_bills" id={id} canEdit={can('supplier_bills', 'edit')} /><History entity="supplier_bills" id={id} /></>} />
      <FormDrawer open={pay} onClose={() => setPay(false)} title="Record payment" submitLabel="Record payment" initial={{ method: 'bank_transfer', amount: b.balance_due }}
        fields={[
          { name: 'amount', label: 'Amount', type: 'money', required: true },
          { name: 'method', label: 'Method', type: 'select', options: ['bank_transfer', 'cash', 'cheque', 'card', 'online', 'other'], required: true },
          { name: 'payment_date', label: 'Paid on', type: 'date' },
          { name: 'reference', label: 'Reference', placeholder: 'Cheque or transfer number' },
          { name: 'note', label: 'Note', full: true },
        ]}
        submit={async (body) => { await api.post(`/supplier-bills/${id}/payments`, body); toast('Payment recorded'); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: [`/supplier-bills/${id}/payments`] }) }} />
      <Confirm open={cancel} onClose={() => setCancel(false)} danger title="Cancel this bill?" confirmLabel="Cancel bill" note={{ label: 'Reason', required: true }}
        onConfirm={(n) => { cancelBill.mutate(n); setCancel(false) }} />
    </>
  )
}

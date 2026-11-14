import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Download, Mail, Pencil, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, openFile } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, label, money, qty } from '../../lib/format'
import { useAction } from '../../lib/hooks'
import type { FieldDef } from '../../ui/Form'
import { Button, Card, Confirm, Empty, ErrorNote, Facts, Loading, Menu, MenuItem, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { Address, DOC_LABEL, PAY_METHODS, Totals } from './common'

const EMAIL_FIELDS: FieldDef[] = [
  { name: 'to', label: 'To', type: 'email', hint: "Leave empty to use the customer's email", full: true },
  { name: 'subject', label: 'Subject', full: true },
  { name: 'message', label: 'Message', type: 'textarea' },
]
const PAYMENT_FIELDS: FieldDef[] = [
  { name: 'amount', label: 'Amount', type: 'money', required: true },
  { name: 'method', label: 'Method', type: 'select', options: PAY_METHODS, required: true },
  { name: 'payment_date', label: 'Date', type: 'date' },
  { name: 'reference', label: 'Reference' },
]

export default function DocumentDetail() {
  const id = Number(useParams().id)
  const can = useCan()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const key = [`/documents/${id}`]
  const { data: d, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/documents/${id}`) })
  const [drawer, setDrawer] = useState<'email' | 'payment' | 'credit' | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const opts = { invalidate: [key, ['/documents']] }
  const issue = useAction(() => api.post(`/documents/${id}/issue`), { ...opts, success: 'Issued' })
  const cancel = useAction((reason: string) => api.post(`/documents/${id}/cancel`, { reason }), { ...opts, success: 'Cancelled', onSuccess: () => setCancelling(false) })
  const quote = useAction((status: string) => api.post(`/documents/${id}/quote-status`, { status }), { ...opts, success: 'Quotation updated' })
  const convert = useAction(() => api.post(`/documents/${id}/convert-to-order`), { onSuccess: (o: any) => navigate(`/orders/${o.id ?? o.order_id}`) })

  if (isLoading) return <Loading />
  if (error) return <ErrorNote error={error} />

  const name = DOC_LABEL[d.doc_type] ?? 'Document'
  const editable = can('invoices', 'edit')
  const isInvoice = d.doc_type === 'invoice'
  const payable = isInvoice && ['issued', 'partially_paid', 'overdue'].includes(d.status)
  const cancellable = editable && d.status !== 'cancelled' && d.doc_type !== 'quotation' && !(d.doc_type === 'credit_note' && d.status === 'issued')

  return (
    <>
      <RecordHeader back="/documents" backLabel="Invoices & quotes" title={d.number ?? `Draft ${name.toLowerCase()}`}
        status={<Status value={d.status} />}
        meta={[name, date(d.doc_date), d.due_date && `due ${date(d.due_date)}`, d.valid_until && `valid until ${date(d.valid_until)}`].filter(Boolean).join(' · ')}
        actions={<>
          <Button icon={<Download className="size-4" />} onClick={() => openFile(`/documents/${id}/pdf`)}>PDF</Button>
          {d.status !== 'draft' && d.status !== 'cancelled' && can('invoices', 'edit') && <Button icon={<Mail className="size-4" />} onClick={() => setDrawer('email')}>Email</Button>}
          {(cancellable || (isInvoice && d.status !== 'draft' && d.status !== 'cancelled' && can('invoices', 'create'))) && (
            <Menu trigger={<Button>More <ChevronDown className="size-3.5" /></Button>}>
              {isInvoice && d.status !== 'draft' && d.status !== 'cancelled' && can('invoices', 'create') && <MenuItem onClick={() => setDrawer('credit')}>Issue credit note</MenuItem>}
              {cancellable && <MenuItem danger onClick={() => setCancelling(true)}>Cancel {name.toLowerCase()}</MenuItem>}
            </Menu>
          )}
          {d.status === 'draft' && editable && <Button icon={<Pencil className="size-4" />} onClick={() => navigate(`/documents/${id}/edit`)}>Edit</Button>}
          {d.status === 'draft' && editable && <Button variant="primary" loading={issue.isPending} onClick={() => issue.mutate(undefined)}>Issue</Button>}
          {d.doc_type === 'quotation' && d.status === 'issued' && editable && <>
            <Menu trigger={<Button>Reply <ChevronDown className="size-3.5" /></Button>}>
              <MenuItem onClick={() => quote.mutate('accepted')}>Accepted</MenuItem>
              <MenuItem onClick={() => quote.mutate('rejected')}>Rejected</MenuItem>
              <MenuItem onClick={() => quote.mutate('expired')}>Expired</MenuItem>
            </Menu>
          </>}
          {d.doc_type === 'quotation' && ['issued', 'accepted'].includes(d.status) && can('orders', 'create') && (
            <Button variant="primary" loading={convert.isPending} onClick={() => convert.mutate(undefined)}>Convert to order</Button>
          )}
          {payable && can('order_payments', 'create') && <Button variant="primary" icon={<Wallet className="size-4" />} onClick={() => setDrawer('payment')}>Record payment</Button>}
        </>} />

      <RecordLayout
        main={<>
          <Card title="Items" pad={false}>
            <div className="scroll-quiet overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-muted">
                    <th className="px-4 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Price</th>
                    <th className="px-3 py-2 text-right font-medium">Tax</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.lines ?? []).map((l: any) => (
                    <tr key={l.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5">{l.description}{l.sku && <span className="block text-[12px] text-muted">{l.sku}</span>}</td>
                      <td className="tabular px-3 py-2.5 text-right">{qty(l.quantity)}</td>
                      <td className="tabular px-3 py-2.5 text-right">{money(l.unit_price, { paisa: true })}</td>
                      <td className="tabular px-3 py-2.5 text-right">{Number(l.tax_rate)}%</td>
                      <td className="tabular px-4 py-2.5 text-right">{money(l.line_total, { paisa: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line p-4">
              <Totals rows={[
                ['Subtotal', money(d.subtotal, { paisa: true })],
                ...(Number(d.discount_total) ? [['Discounts', `− ${money(d.discount_total, { paisa: true })}`] as [string, string]] : []),
                ['Tax included', money(d.tax_total, { paisa: true })],
                ...(Number(d.delivery_charge) ? [['Delivery', money(d.delivery_charge, { paisa: true })] as [string, string]] : []),
                ...(Number(d.charges_total) ? [['Other charges', money(d.charges_total, { paisa: true })] as [string, string]] : []),
                ...(Number(d.rounding) ? [['Rounding', money(d.rounding, { paisa: true })] as [string, string]] : []),
                ['Total', money(d.grand_total), true],
                ...(isInvoice ? [
                  ['Paid', money(d.paid_total)] as [string, string],
                  ...(Number(d.credited_total) ? [['Credited', money(d.credited_total)] as [string, string]] : []),
                  ['Balance due', money(d.balance_due)] as [string, string],
                ] : []),
              ]} />
            </div>
          </Card>
          {isInvoice && d.status !== 'draft' && can('order_payments') && <DocPayments id={id} />}
          {(d.notes || d.terms || d.cancelled_reason) && (
            <Card title="Notes & terms">
              <Facts cols={1} items={[
                ['Cancelled because', d.cancelled_reason ?? undefined],
                ['Notes', d.notes ? <span className="whitespace-pre-wrap">{d.notes}</span> : undefined],
                ['Terms', d.terms ? <span className="whitespace-pre-wrap">{d.terms}</span> : undefined],
              ]} />
            </Card>
          )}
        </>}
        side={<>
          <Card title="Bill to">
            {d.customer_id
              ? <Link to={`/customers/${d.customer_id}`} className="font-medium text-wine-800 hover:underline">{d.customer_name}</Link>
              : <p className="font-medium">{d.customer_name ?? '—'}</p>}
            <p className="text-[13px] text-ink-2">{[d.customer_phone, d.customer_email].filter(Boolean).join(' · ')}</p>
            {d.customer_ntn && <p className="text-[13px] text-ink-2">NTN {d.customer_ntn}</p>}
            {d.billing_address && <div className="mt-2 text-[13px]"><Address a={d.billing_address} /></div>}
          </Card>
          {(d.order_id || d.related_document_id) && (
            <Card title="Linked">
              <Facts cols={1} items={[
                ['Order', d.order_id ? <Link to={`/orders/${d.order_id}`} className="text-wine-700 hover:underline">View order</Link> : undefined],
                ['Related document', d.related_document_id ? <Link to={`/documents/${d.related_document_id}`} className="text-wine-700 hover:underline">View document</Link> : undefined],
              ]} />
            </Card>
          )}
          <Attachments entity="sales_documents" id={id} canEdit={editable} />
          <History entity="sales_documents" id={id} />
        </>}
      />

      <Confirm open={cancelling} onClose={() => setCancelling(false)} danger title={`Cancel this ${name.toLowerCase()}?`} confirmLabel="Cancel it"
        note={{ label: 'Reason', required: true }} loading={cancel.isPending} onConfirm={(r) => cancel.mutate(r)} />
      <FormDrawer open={drawer === 'email'} onClose={() => setDrawer(null)} title={`Email ${name.toLowerCase()}`} fields={EMAIL_FIELDS} submitLabel="Send"
        initial={{ to: d.customer_email ?? '' }}
        submit={async (b) => { await api.post(`/documents/${id}/email`, b); toast('Sent') }} />
      <FormDrawer open={drawer === 'payment'} onClose={() => setDrawer(null)} title="Record payment" fields={PAYMENT_FIELDS} submitLabel="Record payment"
        initial={{ amount: d.balance_due, method: 'bank_transfer' }}
        submit={async (b) => { await api.post(`/documents/${id}/payments`, b); toast('Payment recorded'); refresh(); qc.invalidateQueries({ queryKey: [`/documents/${id}`, 'payments'] }) }} />
      <FormDrawer open={drawer === 'credit'} onClose={() => setDrawer(null)} title="Issue credit note" submitLabel="Create credit note"
        fields={[
          { name: 'reason', label: 'Reason', required: true, full: true },
          ...(d.lines ?? []).map((l: any): FieldDef => ({ name: `l_${l.id}`, label: `${l.description} (invoiced ${qty(l.quantity)})`, type: 'number', full: true, placeholder: '0' })),
        ]}
        submit={async (b) => {
          const lines = (d.lines ?? []).filter((l: any) => Number(b[`l_${l.id}`]) > 0).map((l: any) => ({ line_id: l.id, quantity: b[`l_${l.id}`] }))
          const cn = await api.post(`/documents/${id}/credit-note`, { reason: b.reason, lines: lines.length ? lines : undefined })
          navigate(`/documents/${cn.id}`)
        }}>
        <p className="text-[12.5px] text-muted">Leave all quantities empty to credit the whole invoice.</p>
      </FormDrawer>
    </>
  )
}

function DocPayments({ id }: { id: number }) {
  const navigate = useNavigate()
  const can = useCan()
  const { data } = useQuery({ queryKey: [`/documents/${id}`, 'payments'], queryFn: () => api.get<any[]>(`/documents/${id}/payments`) })
  const receipt = useAction((pid: number) => api.post(`/payments/${pid}/receipt`), { onSuccess: (r: any) => navigate(`/documents/${r.id}`) })
  return (
    <Card title="Payments" pad={false}>
      {!data?.length ? <Empty title="No payments yet" /> : (
        <ul className="divide-y divide-line">
          {data.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
              <span><span className="font-medium">{p.kind === 'refund' ? 'Refund' : label(p.method)}</span>
                <span className="text-muted"> · {date(p.payment_date)}{p.reference ? ` · ${p.reference}` : ''}</span></span>
              <span className="flex items-center gap-3">
                <span className="tabular font-medium">{money(p.amount, { paisa: true })}</span>
                {can('invoices', 'create') && p.kind === 'payment' && p.status === 'completed' && (
                  <Button size="sm" variant="ghost" onClick={() => receipt.mutate(p.id)}>Receipt</Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

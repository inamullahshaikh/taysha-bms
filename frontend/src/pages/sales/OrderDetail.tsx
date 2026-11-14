import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, FilePlus2, Pencil, Printer, RotateCcw, Truck, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, openFile } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { ago, date, dateTime, label, money, qty } from '../../lib/format'
import { useAction } from '../../lib/hooks'
import type { FieldDef } from '../../ui/Form'
import { Badge, Button, Card, Confirm, Empty, ErrorNote, Facts, Loading, Menu, MenuItem, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { Address, PAY_METHODS, Totals, useChannels } from './common'

const TRANSITIONS: Record<string, string[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'packed', 'dispatched', 'delivered', 'draft', 'cancelled'],
  processing: ['packed', 'dispatched', 'cancelled'],
  packed: ['dispatched', 'processing', 'cancelled'],
  dispatched: ['delivered', 'returned'],
  delivered: ['returned', 'refunded'],
  returned: ['refunded'],
}
const NEXT: Record<string, string> = { draft: 'confirmed', confirmed: 'processing', processing: 'packed', packed: 'dispatched', dispatched: 'delivered' }
const VERB: Record<string, string> = {
  confirmed: 'Confirm', processing: 'Start processing', packed: 'Mark packed', dispatched: 'Dispatch', delivered: 'Mark delivered',
  cancelled: 'Cancel order', draft: 'Back to draft', returned: 'Mark returned', refunded: 'Mark refunded',
}

const DELIVERY_FIELDS: FieldDef[] = [
  { name: 'delivery_method', label: 'Method', type: 'select', options: [{ value: 'delivery', label: 'Delivery' }, { value: 'pickup', label: 'Pickup' }] },
  { name: 'courier', label: 'Courier', placeholder: 'TCS, Leopards, M&P, own rider…' },
  { name: 'tracking_number', label: 'Tracking number' },
  { name: 'delivery_status', label: 'Courier status', placeholder: 'In transit, attempted…' },
]
const NOTES_FIELDS: FieldDef[] = [
  { name: 'customer_instructions', label: 'Instructions from the customer', type: 'textarea' },
  { name: 'notes', label: 'Notes (printed on documents)', type: 'textarea' },
  { name: 'internal_notes', label: 'Internal notes', type: 'textarea' },
]
const PAYMENT_FIELDS: FieldDef[] = [
  { name: 'amount', label: 'Amount', type: 'money', required: true },
  { name: 'method', label: 'Method', type: 'select', options: PAY_METHODS, required: true },
  { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'payment', label: 'Payment received' }, { value: 'refund', label: 'Refund paid out' }] },
  { name: 'payment_date', label: 'Date', type: 'date' },
  { name: 'reference', label: 'Reference', placeholder: 'Bank ref, cheque no.' },
  { name: 'note', label: 'Note', type: 'textarea' },
]
const RETURN_REASONS = ['damaged', 'wrong_item', 'quality', 'expired', 'late_delivery', 'changed_mind', 'other']

export default function OrderDetail() {
  const id = Number(useParams().id)
  const can = useCan()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const channels = useChannels()
  const key = [`/orders/${id}`]
  const { data: o, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/orders/${id}`) })
  const [drawer, setDrawer] = useState<'delivery' | 'notes' | 'payment' | 'shipment' | 'return' | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: key })

  const move = useAction((v: { status: string; note?: string }) => api.post(`/orders/${id}/status`, v), {
    invalidate: [key, ['/orders']], onSuccess: (_, v) => { toast(`Order ${label(v.status).toLowerCase()}`); setMoving(null) },
  })
  const makeDoc = useAction((doc_type: string) => api.post(`/orders/${id}/documents`, { doc_type }), {
    onSuccess: (d: any) => navigate(`/documents/${d.id}`),
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorNote error={error} />

  const canEdit = can('orders', 'edit')
  const options = canEdit ? (TRANSITIONS[o.status] ?? []) : []
  const next = NEXT[o.status] && options.includes(NEXT[o.status]) ? NEXT[o.status] : undefined
  const others = options.filter((s) => s !== next)
  const go = (status: string) => {
    if (status === 'dispatched' && o.delivery_method === 'delivery' && !o.courier) { toast('Add the courier first', 'error'); setDrawer('delivery'); return }
    if (status === 'cancelled' || status === 'returned' || status === 'refunded' || status === 'draft') setMoving(status)
    else move.mutate({ status })
  }
  const shippable = (o.lines ?? []).filter((l: any) => Number(l.quantity) - Number(l.shipped_qty ?? 0) > 0)
  const isFree = ['sample', 'promotional', 'replacement'].includes(o.order_type)

  return (
    <>
      <RecordHeader back="/orders" backLabel="Orders" title={o.number}
        status={<><Status value={o.status} /><Status value={o.payment_status} />{o.fulfilment_status === 'partial' && <Badge tone="warn">Partly shipped</Badge>}</>}
        meta={`${date(o.order_date)} · ${label(o.order_type)} · ${channels.name(o.channel)}${o.source !== 'manual' ? ` · from ${label(o.source)}` : ''}`}
        actions={<>
          <Menu trigger={<Button icon={<Printer className="size-4" />}>Print <ChevronDown className="size-3.5" /></Button>}>
            <MenuItem onClick={() => openFile(`/orders/${id}/pdf`, { doc: 'summary' })}>Order summary</MenuItem>
            <MenuItem onClick={() => openFile(`/orders/${id}/pdf`, { doc: 'packing_slip' })}>Packing slip</MenuItem>
          </Menu>
          {can('invoices', 'create') && o.status !== 'draft' && o.status !== 'cancelled' && !isFree && (
            <Menu trigger={<Button icon={<FilePlus2 className="size-4" />} loading={makeDoc.isPending}>Create <ChevronDown className="size-3.5" /></Button>}>
              <MenuItem onClick={() => makeDoc.mutate('invoice')}>Invoice</MenuItem>
              <MenuItem onClick={() => makeDoc.mutate('proforma')}>Pro-forma invoice</MenuItem>
              <MenuItem onClick={() => makeDoc.mutate('delivery_challan')}>Delivery challan</MenuItem>
            </Menu>
          )}
          {o.status === 'draft' && canEdit && <Button icon={<Pencil className="size-4" />} onClick={() => navigate(`/orders/${id}/edit`)}>Edit</Button>}
          {others.length > 0 && (
            <Menu trigger={<Button>More <ChevronDown className="size-3.5" /></Button>}>
              {others.map((s) => <MenuItem key={s} danger={s === 'cancelled'} onClick={() => go(s)}>{VERB[s]}</MenuItem>)}
              {can('returns', 'create') && ['dispatched', 'delivered'].includes(o.status) && <MenuItem icon={<RotateCcw />} onClick={() => setDrawer('return')}>Start a return</MenuItem>}
            </Menu>
          )}
          {next && <Button variant="primary" loading={move.isPending} onClick={() => go(next)}>{VERB[next]}</Button>}
        </>} />

      <RecordLayout
        main={<>
          <Card title="Items" pad={false}>
            <div className="scroll-quiet overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-muted">
                    <th className="px-4 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Price</th>
                    <th className="px-3 py-2 text-right font-medium">Discount</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {o.lines.map((l: any) => (
                    <tr key={l.id} className="border-b border-line last:border-0 align-top">
                      <td className="px-4 py-2.5">
                        <span className="block">{l.description}</span>
                        <span className="text-[12px] text-muted">{l.sku}
                          {Number(l.backorder_qty) > 0 && <span className="text-warn"> · {qty(l.backorder_qty)} on backorder</span>}
                          {Number(l.shipped_qty) > 0 && <span> · {qty(l.shipped_qty)} shipped</span>}
                        </span>
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">{qty(l.quantity)}</td>
                      <td className="tabular px-3 py-2.5 text-right">{money(l.unit_price, { paisa: true })}{l.price_overridden && <span className="block text-[11.5px] text-muted">list {money(l.list_price)}</span>}</td>
                      <td className="tabular px-3 py-2.5 text-right">{Number(l.line_discount) + Number(l.order_discount_share) ? money(Number(l.line_discount) + Number(l.order_discount_share), { paisa: true }) : '—'}</td>
                      <td className="tabular px-4 py-2.5 text-right">{money(l.line_total, { paisa: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line p-4">
              <Totals rows={[
                ['Subtotal', money(o.subtotal, { paisa: true })],
                ...(Number(o.discount_total) ? [['Discounts', `− ${money(o.discount_total, { paisa: true })}`] as [string, string]] : []),
                ['Tax included', money(o.tax_total, { paisa: true })],
                ...(Number(o.delivery_charge) ? [['Delivery', money(o.delivery_charge, { paisa: true })] as [string, string]] : []),
                ...(Number(o.rounding) ? [['Rounding', money(o.rounding, { paisa: true })] as [string, string]] : []),
                ['Total', money(o.grand_total), true],
                ['Paid', money(o.paid_total)],
                ['Balance due', money(o.balance_due)],
              ]} />
            </div>
          </Card>

          {can('order_payments') && <Payments id={id} canAdd={can('order_payments', 'create') && o.status !== 'draft' && o.status !== 'cancelled'} onAdd={() => setDrawer('payment')} />}
          <Shipments id={id} canAdd={canEdit && shippable.length > 0 && !['draft', 'cancelled'].includes(o.status)} onAdd={() => setDrawer('shipment')} />
          <Documents id={id} />
        </>}
        side={<>
          <Card title="Customer">
            {o.customer_id
              ? <Link to={`/customers/${o.customer_id}`} className="font-medium text-wine-800 hover:underline">{o.customer_name}</Link>
              : <p className="font-medium">{o.customer_name ?? 'Walk-in'}</p>}
            {o.customer_phone && <p className="text-[13px] text-ink-2">{o.customer_phone}</p>}
            {o.delivery_method === 'delivery' && <div className="mt-3 text-[13px]"><p className="mb-0.5 text-[12px] text-muted">Deliver to</p><Address a={o.shipping_address} /></div>}
          </Card>
          <Card title="Delivery" action={canEdit && <Button size="sm" variant="ghost" icon={<Truck className="size-4" />} onClick={() => setDrawer('delivery')}>Edit</Button>}>
            <Facts cols={1} items={[
              ['Method', label(o.delivery_method)],
              ['Courier', o.courier],
              ['Tracking', o.tracking_number],
              ['Courier status', o.delivery_status ?? undefined],
              ['Dispatched', o.dispatched_at ? dateTime(o.dispatched_at) : undefined],
              ['Delivered', o.delivered_at ? dateTime(o.delivered_at) : undefined],
            ]} />
          </Card>
          <Card title="Notes" action={canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setDrawer('notes')}>Edit</Button>}>
            {o.customer_instructions || o.notes || o.internal_notes || o.cancelled_reason ? (
              <Facts cols={1} items={[
                ['Cancelled because', o.cancelled_reason ?? undefined],
                ['Customer instructions', o.customer_instructions ?? undefined],
                ['Notes', o.notes ?? undefined],
                ['Internal', o.internal_notes ?? undefined],
              ]} />
            ) : <p className="text-[13px] text-muted">No notes.</p>}
          </Card>
          {!!o.history?.length && (
            <Card title="Status timeline">
              <ol className="flex flex-col gap-2.5">
                {o.history.map((h: any, i: number) => (
                  <li key={i} className="flex items-start justify-between gap-3 text-[13px]">
                    <span><Status value={h.to_status} />{h.note && <span className="mt-0.5 block text-[12px] text-ink-2">{h.note}</span>}</span>
                    <span className="shrink-0 text-[12px] text-muted" title={dateTime(h.at)}>{ago(h.at)}</span>
                  </li>
                ))}
              </ol>
            </Card>
          )}
          <Attachments entity="orders" id={id} canEdit={canEdit} />
          <History entity="orders" id={id} />
        </>}
      />

      <Confirm open={!!moving} onClose={() => setMoving(null)} loading={move.isPending}
        title={moving ? `${VERB[moving]}?` : ''} danger={moving === 'cancelled'} confirmLabel={moving ? VERB[moving] : ''}
        note={{ label: moving === 'cancelled' ? 'Reason' : 'Note (optional)', required: moving === 'cancelled' }}
        body={moving === 'cancelled' ? 'Reserved stock is released. This cannot be undone.' : undefined}
        onConfirm={(note) => move.mutate({ status: moving!, note: note || undefined })} />

      <FormDrawer open={drawer === 'delivery'} onClose={() => setDrawer(null)} title="Delivery details" mode="edit" fields={DELIVERY_FIELDS} initial={o}
        submit={async (b) => { await api.patch(`/orders/${id}/delivery`, b); refresh() }} />
      <FormDrawer open={drawer === 'notes'} onClose={() => setDrawer(null)} title="Notes" mode="edit" fields={NOTES_FIELDS} initial={o}
        submit={async (b) => { await api.patch(`/orders/${id}/notes`, b); refresh() }} />
      <FormDrawer open={drawer === 'payment'} onClose={() => setDrawer(null)} title="Record payment" fields={PAYMENT_FIELDS} submitLabel="Record payment"
        initial={{ amount: Number(o.balance_due) > 0 ? o.balance_due : '', method: o.payment_method === 'cod' ? 'cash' : (o.payment_method ?? 'cash'), kind: 'payment' }}
        submit={async (b) => { await api.post(`/orders/${id}/payments`, b); toast('Payment recorded'); qc.invalidateQueries({ queryKey: [`/orders/${id}`] }) }} />
      <FormDrawer open={drawer === 'shipment'} onClose={() => setDrawer(null)} title="Ship items" submitLabel="Create shipment"
        fields={[
          ...shippable.map((l: any): FieldDef => ({ name: `l_${l.id}`, label: `${l.description} (${qty(Number(l.quantity) - Number(l.shipped_qty ?? 0))} left)`, type: 'number', full: true })),
          { name: 'courier', label: 'Courier' }, { name: 'tracking_number', label: 'Tracking number' },
        ]}
        initial={{ ...Object.fromEntries(shippable.map((l: any) => [`l_${l.id}`, String(Number(l.quantity) - Number(l.shipped_qty ?? 0))])), courier: o.courier ?? '', tracking_number: o.tracking_number ?? '' }}
        submit={async (b) => {
          const lines = shippable.filter((l: any) => Number(b[`l_${l.id}`]) > 0).map((l: any) => ({ order_line_id: l.id, quantity: b[`l_${l.id}`] }))
          await api.post(`/orders/${id}/shipments`, { lines, courier: b.courier, tracking_number: b.tracking_number })
          toast('Shipment created'); qc.invalidateQueries({ queryKey: [`/orders/${id}`] })
        }} />
      <FormDrawer open={drawer === 'return'} onClose={() => setDrawer(null)} title="Start a return" submitLabel="Create return"
        fields={[
          { name: 'reason', label: 'Reason', type: 'select', options: RETURN_REASONS, required: true },
          { name: 'reason_note', label: 'Details', type: 'textarea' },
          ...o.lines.map((l: any): FieldDef => ({ name: `l_${l.id}`, label: `${l.description} (bought ${qty(l.quantity)})`, type: 'number', full: true, placeholder: '0' })),
        ]}
        initial={{ reason: 'damaged' }}
        submit={async (b) => {
          const lines = o.lines.filter((l: any) => Number(b[`l_${l.id}`]) > 0).map((l: any) => ({ order_line_id: l.id, quantity: b[`l_${l.id}`] }))
          const r = await api.post(`/returns/from-order/${id}`, { reason: b.reason, reason_note: b.reason_note, lines })
          navigate(`/returns/${r.id}`)
        }} />
    </>
  )
}

function Payments({ id, canAdd, onAdd }: { id: number; canAdd: boolean; onAdd: () => void }) {
  const { data } = useQuery({ queryKey: [`/orders/${id}`, 'payments'], queryFn: () => api.get<any[]>(`/orders/${id}/payments`) })
  return (
    <Card title="Payments" pad={false} action={canAdd && <Button size="sm" variant="ghost" icon={<Wallet className="size-4" />} onClick={onAdd}>Record payment</Button>}>
      {!data?.length ? <Empty title="No payments yet" /> : (
        <ul className="divide-y divide-line">
          {data.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
              <span>
                <span className="font-medium">{p.kind === 'refund' ? 'Refund' : label(p.method)}</span>
                <span className="text-muted"> · {date(p.payment_date)}{p.reference ? ` · ${p.reference}` : ''}</span>
                {p.status === 'failed' && <Badge tone="bad" className="ml-2">Failed</Badge>}
              </span>
              <span className="tabular font-medium">{p.kind === 'refund' ? '− ' : ''}{money(p.amount, { paisa: true })}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Shipments({ id, canAdd, onAdd }: { id: number; canAdd: boolean; onAdd: () => void }) {
  const { data } = useQuery({ queryKey: [`/orders/${id}`, 'shipments'], queryFn: () => api.get<any[]>(`/orders/${id}/shipments`) })
  if (!data?.length && !canAdd) return null
  return (
    <Card title="Shipments" pad={false} action={canAdd && <Button size="sm" variant="ghost" icon={<Truck className="size-4" />} onClick={onAdd}>Ship items</Button>}>
      {!data?.length ? <Empty title="Nothing shipped yet">Ship part of the order when some items are short.</Empty> : (
        <ul className="divide-y divide-line">
          {data.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
              <span><span className="font-medium">{s.number}</span><span className="text-muted"> · {[s.courier, s.tracking_number].filter(Boolean).join(' ') || 'No courier'}</span></span>
              <Status value={s.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Documents({ id }: { id: number }) {
  const can = useCan()
  const { data } = useQuery({ queryKey: ['/documents', { order_id: id }], queryFn: () => api.get('/documents', { order_id: id }), enabled: can('invoices') })
  if (!data?.items?.length) return null
  return (
    <Card title="Documents" pad={false}>
      <ul className="divide-y divide-line">
        {data.items.map((d: any) => (
          <li key={d.id}>
            <Link to={`/documents/${d.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px] hover:bg-wine-50/60">
              <span><span className="font-medium">{d.number ?? 'Draft'}</span><span className="text-muted"> · {label(d.doc_type)}</span></span>
              <span className="flex items-center gap-3"><span className="tabular">{money(d.grand_total)}</span><Status value={d.status} /></span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

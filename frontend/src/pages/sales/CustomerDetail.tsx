import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Pencil, Plus, ShoppingBag } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, openFile } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { ago, date, label, money, qty } from '../../lib/format'
import { productLabel, useAction, useLookupName, useRefMap } from '../../lib/hooks'
import { StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { LineItems, PRODUCTS, cleanLines, type FieldDef, type FormValues } from '../../ui/Form'
import { Badge, Button, Card, Empty, ErrorNote, Facts, Input, Loading, Select, Status, Textarea } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { Address } from './common'
import { CUSTOMER_FIELDS } from './Customers'

const ADDRESS_FIELDS: FieldDef[] = [
  { name: 'label', label: 'Label', placeholder: 'Home, Office…' },
  { name: 'phone', label: 'Phone' },
  { name: 'line1', label: 'Address line 1', required: true, full: true },
  { name: 'line2', label: 'Address line 2', full: true },
  { name: 'area', label: 'Area' },
  { name: 'city', label: 'City', required: true },
  { name: 'is_default_shipping', label: 'Default for delivery', type: 'bool' },
  { name: 'is_default_billing', label: 'Default for billing', type: 'bool' },
]

export default function CustomerDetail() {
  const id = Number(useParams().id)
  const can = useCan()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [addr, setAddr] = useState<any>(null)
  const c = useQuery({ queryKey: [`/customers/${id}`], queryFn: () => api.get(`/customers/${id}`) })
  const stats = useQuery({ queryKey: [`/customers/${id}/stats`], queryFn: () => api.get(`/customers/${id}/stats`) })
  const priceList = useLookupName('price_lists')
  const territory = useRefMap('/territories')
  const refresh = () => qc.invalidateQueries({ queryKey: [`/customers/${id}`] })

  if (c.isLoading) return <Loading />
  if (c.error) return <ErrorNote error={c.error} />
  const r = c.data
  const s = stats.data

  return (
    <>
      <RecordHeader back="/customers" backLabel="Customers" title={r.name}
        status={<>{r.archived_at && <Badge>Archived</Badge>}{s?.returning && <Badge tone="brand">Returning</Badge>}</>}
        meta={[label(r.type), r.company_name, r.phone].filter(Boolean).join(' · ')}
        actions={<>
          {can('invoices') && <Button icon={<FileText className="size-4" />} onClick={() => openFile(`/customers/${id}/statement`, { format: 'pdf' })}>Statement</Button>}
          {can('customers', 'edit') && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>}
          {can('orders', 'create') && <Button variant="primary" icon={<ShoppingBag className="size-4" />} onClick={() => navigate(`/orders/new?customer=${id}`)}>New order</Button>}
        </>} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total spend" value={money(s?.total_spend)} sub={s ? `${s.order_count} orders` : undefined} />
        <StatTile label="Average order" value={money(s?.average_order_value)} />
        <StatTile label="Last order" value={s?.last_order_date ? ago(s.last_order_date) : '—'} sub={s?.first_order_date ? `First ${date(s.first_order_date)}` : undefined} />
        <StatTile label="Outstanding" value={money(s?.outstanding)} />
      </div>

      <RecordLayout
        main={<>
          <Card title="Orders" pad={false}>
            <DataTable path={`/customers/${id}/orders`} persist={false} search={false} dense rowTo={(o: any) => `/orders/${o.id}`}
              empty={{ title: 'No orders yet' }}
              columns={[
                { key: 'number', label: 'Order', render: (o: any) => <span className="font-medium">{o.number}</span> },
                { key: 'order_date', label: 'Date', render: (o: any) => date(o.order_date) },
                { key: 'status', label: 'Status', render: (o: any) => <Status value={o.status} /> },
                { key: 'payment_status', label: 'Payment', render: (o: any) => <Status value={o.payment_status} /> },
                { key: 'grand_total', label: 'Total', align: 'right', render: (o: any) => money(o.grand_total) },
              ]} />
          </Card>
          <Notes id={id} canAdd={can('customers', 'edit')} />
          {(r.type !== 'retail' || r.price_list_id) && <Terms id={id} canEdit={can('customers', 'edit')} />}
        </>}
        side={<>
          <Card title="Profile">
            <Facts cols={1} items={([
              ['Email', r.email],
              ['Price list', r.price_list_id ? priceList(r.price_list_id) : 'Standard'],
              ['Payment terms', r.payment_terms_days ? `${r.payment_terms_days} days` : 'On order'],
              ['Credit limit', r.credit_limit ? money(r.credit_limit) : undefined],
              ['Territory', r.territory_id ? territory(r.territory_id) : undefined],
              ['Source', r.source],
              ['Tags', r.tags?.length ? <span className="flex flex-wrap gap-1">{r.tags.map((t: string) => <Badge key={t}>{t}</Badge>)}</span> : undefined],
              ['Offers', r.marketing_opt_in ? 'Opted in' : 'Not opted in'],
              ['NTN / STRN', r.ntn || r.strn ? [r.ntn, r.strn].filter(Boolean).join(' / ') : undefined],
              ['Preferences', r.preferences],
            ] as [string, any][]).map(([k, v]) => [k, v ?? undefined])} />
          </Card>
          <Addresses id={id} canEdit={can('customers', 'edit')} onEdit={setAddr} />
          {can('customers') && <Loyalty id={id} canEdit={can('customers', 'edit')} />}
          <Attachments entity="customers" id={id} canEdit={can('customers', 'edit')} />
          <History entity="customers" id={id} />
        </>}
      />

      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit customer" mode="edit" fields={CUSTOMER_FIELDS} initial={r}
        submit={async (b) => { await api.patch(`/customers/${id}`, b); refresh() }} />
      <FormDrawer open={!!addr} onClose={() => setAddr(null)} title={addr?.id ? 'Edit address' : 'New address'} fields={ADDRESS_FIELDS} initial={addr ?? undefined}
        submit={async (b) => {
          const body = { ...b, label: b.label ?? 'Main' }
          if (addr?.id) await api.put(`/customers/${id}/addresses/${addr.id}`, body)
          else await api.post(`/customers/${id}/addresses`, body)
          qc.invalidateQueries({ queryKey: [`/customers/${id}/addresses`] })
        }} />
    </>
  )
}

function Addresses({ id, canEdit, onEdit }: { id: number; canEdit: boolean; onEdit: (a: any) => void }) {
  const { data } = useQuery({ queryKey: [`/customers/${id}/addresses`], queryFn: () => api.get<any[]>(`/customers/${id}/addresses`) })
  return (
    <Card title="Addresses" pad={false}
      action={canEdit && <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => onEdit({})}>Add</Button>}>
      {!data?.length ? <Empty title="No saved addresses" /> : (
        <ul className="divide-y divide-line">
          {data.map((a) => (
            <li key={a.id}>
              <button type="button" disabled={!canEdit} onClick={() => onEdit(a)} className="w-full px-4 py-3 text-left text-[13px] enabled:hover:bg-wine-50/60">
                <span className="mb-1 flex items-center gap-1.5 font-medium">
                  {a.label}
                  {a.is_default_shipping && <Badge tone="info">Delivery</Badge>}
                  {a.is_default_billing && <Badge>Billing</Badge>}
                </span>
                <Address a={a} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

const NOTE_KINDS = ['note', 'call', 'email', 'whatsapp', 'meeting', 'complaint', 'preference']

function Notes({ id, canAdd }: { id: number; canAdd: boolean }) {
  const key = [`/customers/${id}/notes`]
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<any[]>(`/customers/${id}/notes`) })
  const [kind, setKind] = useState('note')
  const [body, setBody] = useState('')
  const add = useAction(() => api.post(`/customers/${id}/notes`, { kind, body }), { invalidate: [key], onSuccess: () => setBody('') })
  return (
    <Card title="Notes & contact log">
      {canAdd && (
        <form className="mb-4 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(undefined) }}>
          <Textarea aria-label="Note" placeholder="Called about a bulk order for Eid…" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-16" />
          <div className="flex justify-end gap-2">
            <div className="w-36"><Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} options={NOTE_KINDS} /></div>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!body.trim()}>Add note</Button>
          </div>
        </form>
      )}
      {!data?.length ? <p className="text-[13px] text-muted">Nothing logged yet.</p> : (
        <ul className="flex flex-col gap-3">
          {data.map((n) => (
            <li key={n.id} className="text-[13px]">
              <p className="text-[11.5px] text-muted">{label(n.kind)} · {ago(n.created_at)}</p>
              <p className="whitespace-pre-wrap text-ink">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Loyalty({ id, canEdit }: { id: number; canEdit: boolean }) {
  const key = [`/customers/${id}/loyalty`]
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get(`/customers/${id}/loyalty`), retry: false })
  const [points, setPoints] = useState('')
  const [note, setNote] = useState('')
  const adjust = useAction(() => api.post(`/customers/${id}/loyalty/adjust`, { points: Number(points), note }),
    { success: 'Points updated', invalidate: [key], onSuccess: () => { setPoints(''); setNote('') } })
  const [code, setCode] = useState<string>()
  const referral = useAction(() => api.post(`/customers/${id}/referral-code`), { onSuccess: (r: any) => setCode(r.referral_code) })
  if (!data) return null
  return (
    <Card title="Loyalty">
      <div className="flex items-baseline justify-between">
        <p className="text-[22px] font-semibold">{data.points.toLocaleString()} <span className="text-[13px] font-normal text-muted">points</span></p>
        <p className="text-[12.5px] text-ink-2">worth {money(data.value)}</p>
      </div>
      {canEdit && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); adjust.mutate(undefined) }}>
          <Input aria-label="Points (+/-)" type="number" placeholder="±" className="w-20" value={points} onChange={(e) => setPoints(e.target.value)} />
          <Input aria-label="Reason" placeholder="Reason" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button type="submit" disabled={!points || !note} loading={adjust.isPending}>Apply</Button>
        </form>
      )}
      {code ? <p className="mt-3 text-[13px]">Referral code <span className="rounded bg-sunken px-1.5 py-0.5 font-mono">{code}</span></p> : canEdit && (
        <Button variant="ghost" size="sm" className="mt-2 -ml-2" loading={referral.isPending} onClick={() => referral.mutate(undefined)}>
          Get referral code
        </Button>
      )}
    </Card>
  )
}

/** Wholesale minimum order quantities and a customer-specific price list. */
function Terms({ id, canEdit }: { id: number; canEdit: boolean }) {
  const key = [`/customers/${id}/terms`]
  const product = useRefMap('/products', productLabel)
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<any[]>(`/customers/${id}/terms`) })
  const [rows, setRows] = useState<FormValues[] | null>(null)
  const save = useAction((r: FormValues[]) => api.put(`/customers/${id}/terms`, cleanLines(r)), { success: 'Terms saved', invalidate: [key], onSuccess: () => setRows(null) })
  const priceList = useAction(() => api.post(`/customers/${id}/price-list`), { success: 'Price list created for this customer', invalidate: [[`/customers/${id}`], ['lookups']] })
  return (
    <Card title="Wholesale terms" action={canEdit && !rows && <div className="flex gap-1">
      <Button size="sm" variant="ghost" loading={priceList.isPending} onClick={() => priceList.mutate(undefined)}>Own price list</Button>
      <Button size="sm" variant="ghost" onClick={() => setRows((data ?? []).map((t) => ({ product_id: String(t.product_id), min_order_qty: t.min_order_qty })))}>Edit MOQs</Button>
    </div>}>
      {rows ? (
        <div className="flex flex-col gap-3">
          <LineItems value={rows} onChange={setRows} addLabel="Add product"
            columns={[{ name: 'product_id', label: 'Product', type: 'product', record: PRODUCTS }, { name: 'min_order_qty', label: 'Minimum qty', type: 'number', width: '140px' }]} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRows(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(rows)}>Save terms</Button>
          </div>
        </div>
      ) : !data?.length ? <p className="text-[13px] text-muted">No minimum order quantities.</p> : (
        <ul className="divide-y divide-line text-[13px]">
          {data.map((t) => (
            <li key={t.product_id} className="flex justify-between py-2"><span>{product(t.product_id)}</span><span className="tabular">min {qty(t.min_order_qty)}</span></li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12px] text-muted"><Link to="/recurring-orders" className="text-wine-700 hover:underline">Recurring orders</Link> live under Wholesale.</p>
    </Card>
  )
}

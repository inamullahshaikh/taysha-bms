import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { compactMoney, date, label, money, pct } from '../../lib/format'
import { useAction } from '../../lib/hooks'
import { ChartCard, Meter, StatTile, TrendChart } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { LineItems, type FieldDef, type FormValues } from '../../ui/Form'
import { Button, Card, Empty, Facts, Loading, Select, Status, Tabs } from '../../ui/kit'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { useToast } from '../../ui/toast'
import { LinesTable } from './common'

const fields: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, full: true },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'city', label: 'City' },
  { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
  { name: 'address', label: 'Address', type: 'textarea' },
  { name: 'ntn', label: 'NTN' },
  { name: 'strn', label: 'STRN' },
  { name: 'bank_details', label: 'Bank details', type: 'textarea' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Suppliers() {
  return (
    <ResourcePage path="/suppliers" feature="suppliers" noun="supplier" fields={fields} defaults={{ payment_terms_days: 30 }}
      search="Search name, phone or email" rowTo={(s: any) => `/suppliers/${s.id}`}
      columns={[
        { key: 'name', label: 'Supplier', sort: 'name', render: (s: any) => <span className="font-medium">{s.name}</span> },
        { key: 'city', label: 'City', render: (s: any) => s.city ?? '—' },
        { key: 'phone', label: 'Phone', render: (s: any) => s.phone ?? '—' },
        { key: 'payment_terms_days', label: 'Terms', align: 'right', render: (s: any) => `${s.payment_terms_days} days` },
      ]} />
  )
}

type Tab = 'overview' | 'items' | 'contacts' | 'orders' | 'payments'

export function SupplierPage() {
  const id = Number(useParams().id)
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('overview')
  const [edit, setEdit] = useState(false)
  const key = [`/suppliers/${id}`]
  const { data: s, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get(`/suppliers/${id}`) })
  if (isLoading || !s) return <Loading />
  return (
    <>
      <RecordHeader back="/suppliers" backLabel="Suppliers" title={s.name}
        meta={[s.city, s.phone, s.email, `${s.payment_terms_days}-day terms`].filter(Boolean).join(' · ')}
        actions={can('suppliers', 'edit') && <Button variant="primary" onClick={() => setEdit(true)}>Edit</Button>} />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Overview' }, { value: 'items', label: 'Items supplied' }, { value: 'contacts', label: 'Contacts' },
        ...(can('purchasing') ? [{ value: 'orders' as Tab, label: 'Purchase orders' }] : []),
        ...(can('supplier_bills') ? [{ value: 'payments' as Tab, label: 'Payments' }] : []),
      ]} /></div>
      {tab === 'overview' && <Overview s={s} />}
      {tab === 'items' && <Items id={id} />}
      {tab === 'contacts' && <Contacts id={id} />}
      {tab === 'orders' && (
        <DataTable path="/purchase-orders" params={{ supplier_id: id }} persist={false} search={false} rowTo={(p: any) => `/purchase-orders/${p.id}`}
          empty={{ title: 'No orders with this supplier yet' }}
          columns={[
            { key: 'number', label: 'PO', render: (p: any) => <span className="font-medium">{p.number}</span> },
            { key: 'order_date', label: 'Ordered', render: (p: any) => date(p.order_date) },
            { key: 'grand_total', label: 'Total', align: 'right', render: (p: any) => money(p.grand_total) },
            { key: 'status', label: 'Status', render: (p: any) => <Status value={p.status} /> },
          ]} />
      )}
      {tab === 'payments' && <Payments id={id} />}
      <FormDrawer open={edit} onClose={() => setEdit(false)} title="Edit supplier" mode="edit" fields={fields} initial={s}
        submit={async (b) => { await api.patch(`/suppliers/${id}`, b); toast('Saved'); qc.invalidateQueries({ queryKey: key }) }} />
    </>
  )
}

const RATINGS = ['price', 'quality', 'delivery', 'reliability'] as const

function Overview({ s }: { s: any }) {
  const can = useCan()
  const qc = useQueryClient()
  const perf = useQuery({ queryKey: [`/suppliers/${s.id}/performance`], queryFn: () => api.get(`/suppliers/${s.id}/performance`), enabled: can('purchasing') })
  const hist = useQuery({ queryKey: [`/suppliers/${s.id}/price-history`], queryFn: () => api.get<any[]>(`/suppliers/${s.id}/price-history`), enabled: can('purchasing') })
  const [rate, setRate] = useState(false)
  const items = [...new Map((hist.data ?? []).map((h) => [h.product_id, h.description])).entries()]
  const [pick, setPick] = useState<string>('')
  useEffect(() => { if (!pick && items[0]) setPick(String(items[0][0])) }, [items, pick])
  const series = (hist.data ?? []).filter((h) => String(h.product_id) === pick).reverse()
  const p = perf.data

  return (
    <RecordLayout
      main={<>
        {p && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="On time" value={p.on_time_pct == null ? '—' : pct(p.on_time_pct, 0)} sub={`${p.orders_received} orders received`} />
            <StatTile label="Average lead time" value={p.average_lead_time_days == null ? '—' : `${Number(p.average_lead_time_days).toFixed(1)} days`} />
            <StatTile label="Passed quality check" value={p.qc_pass_pct == null ? '—' : pct(p.qc_pass_pct, 0)} />
            <StatTile label="Billed to date" value={compactMoney(p.total_billed)} />
          </div>
        )}
        {can('purchasing') && (
          <ChartCard title="What we pay" sub="Unit cost on each purchase order"
            action={items.length > 1 && <div className="w-56"><Select aria-label="Item" className="h-8 text-[13px]" value={pick} onChange={(e) => setPick(e.target.value)} options={items.map(([v, l]) => ({ value: String(v), label: l }))} /></div>}>
            {series.length > 1 ? <TrendChart kind="line" height={220} data={series} x="order_date" xFmt={(v) => date(v)} fmt={(v) => money(v, { paisa: true })} series={[{ key: 'unit_cost', label: 'Unit cost' }]} />
              : series.length === 1 ? <p className="py-6 text-center text-[13px] text-ink-2">One order so far at {money(series[0].unit_cost, { paisa: true })} on {date(series[0].order_date)}.</p>
              : <Empty title="No purchase prices yet" />}
          </ChartCard>
        )}
        <Card title="Details"><Facts items={[['Address', s.address], ['NTN', s.ntn], ['STRN', s.strn], ['Bank details', s.bank_details], ['Notes', s.notes]]} /></Card>
      </>}
      side={<>
        {p && (
          <Card title="Rating" action={can('purchasing', 'edit') && <Button size="sm" icon={<Star className="size-3.5" />} onClick={() => setRate(true)}>Rate</Button>}>
            <ul className="flex flex-col gap-3">
              {RATINGS.map((k) => {
                const v = p.ratings?.[k]
                return (
                  <li key={k}>
                    <div className="mb-1 flex justify-between text-[13px]"><span className="text-ink-2">{label(k)}</span><span className="font-medium">{v == null ? '—' : `${Number(v).toFixed(1)} / 5`}</span></div>
                    <Meter value={Number(v ?? 0)} max={5} tone={v == null ? 'brand' : Number(v) >= 4 ? 'good' : Number(v) >= 3 ? 'warn' : 'bad'} />
                  </li>
                )
              })}
            </ul>
          </Card>
        )}
        <Attachments entity="suppliers" id={s.id} canEdit={can('suppliers', 'edit')} />
        <History entity="suppliers" id={s.id} />
        <FormDrawer open={rate} onClose={() => setRate(false)} title={`Rate ${s.name}`} submitLabel="Save rating"
          fields={[...RATINGS.map((k) => ({ name: k, label: label(k), type: 'select' as const, required: true, options: ['5', '4', '3', '2', '1'].map((n) => ({ value: n, label: `${n} – ${['', 'Poor', 'Below par', 'OK', 'Good', 'Excellent'][Number(n)]}` })) })),
            { name: 'note', label: 'Note', full: true }]}
          submit={async (b) => { await api.post(`/suppliers/${s.id}/ratings`, Object.fromEntries(Object.entries(b).map(([k, v]) => [k, k === 'note' ? v : Number(v)]))); qc.invalidateQueries({ queryKey: [`/suppliers/${s.id}/performance`] }) }} />
      </>} />
  )
}

/** Small list editor saved as a whole with PUT. */
function useList(path: string, toRow: (r: any) => FormValues) {
  const { data, isLoading } = useQuery({ queryKey: [path], queryFn: () => api.get<any[]>(path) })
  const [rows, setRows] = useState<FormValues[]>([])
  useEffect(() => { if (data) setRows(data.map(toRow)) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction((body: any[]) => api.put(path, body), { success: 'Saved', invalidate: [[path]] })
  return { rows, setRows, isLoading, save, dirty: JSON.stringify(rows) !== JSON.stringify((data ?? []).map(toRow)) }
}

function Items({ id }: { id: number }) {
  const can = useCan()
  const ed = useList(`/suppliers/${id}/items`, (r) => ({ product_id: String(r.product_id), supplier_sku: r.supplier_sku ?? '', lead_time_days: r.lead_time_days ?? '', min_order_qty: r.min_order_qty ?? '', is_preferred: r.is_preferred ? 'yes' : 'no' }))
  if (ed.isLoading) return <Loading />
  return (
    <Card title="Items supplied" action={can('suppliers', 'edit') && <Button size="sm" variant="primary" disabled={!ed.dirty} loading={ed.save.isPending}
      onClick={() => ed.save.mutate(ed.rows.filter((r) => r.product_id).map((r) => ({
        product_id: Number(r.product_id), supplier_sku: r.supplier_sku || null, lead_time_days: r.lead_time_days === '' ? null : Number(r.lead_time_days),
        min_order_qty: r.min_order_qty || null, is_preferred: r.is_preferred === 'yes',
      })))}>Save</Button>}>
      <LineItems value={ed.rows} onChange={ed.setRows} addLabel="Add item" newRow={() => ({ product_id: '', supplier_sku: '', lead_time_days: '', min_order_qty: '', is_preferred: 'no' })}
        columns={[
          { name: 'product_id', label: 'Item', type: 'product' },
          { name: 'supplier_sku', label: 'Their code', type: 'text', width: '120px' },
          { name: 'lead_time_days', label: 'Lead days', type: 'number', width: '90px' },
          { name: 'min_order_qty', label: 'Min order', type: 'number', width: '100px' },
          { name: 'is_preferred', label: 'Preferred', type: 'select', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], width: '100px' },
        ]} />
    </Card>
  )
}

function Contacts({ id }: { id: number }) {
  const can = useCan()
  const ed = useList(`/suppliers/${id}/contacts`, (r) => ({ name: r.name, role: r.role ?? '', phone: r.phone ?? '', email: r.email ?? '' }))
  if (ed.isLoading) return <Loading />
  return (
    <Card title="Contacts" action={can('suppliers', 'edit') && <Button size="sm" variant="primary" disabled={!ed.dirty} loading={ed.save.isPending}
      onClick={() => ed.save.mutate(ed.rows.filter((r) => r.name).map((r) => ({ name: r.name, role: r.role || null, phone: r.phone || null, email: r.email || null })))}>Save</Button>}>
      <LineItems value={ed.rows} onChange={ed.setRows} addLabel="Add contact"
        columns={[{ name: 'name', label: 'Name', type: 'text' }, { name: 'role', label: 'Role', type: 'text' }, { name: 'phone', label: 'Phone', type: 'text' }, { name: 'email', label: 'Email', type: 'text' }]} />
    </Card>
  )
}

function Payments({ id }: { id: number }) {
  const { data, isLoading } = useQuery({ queryKey: [`/suppliers/${id}/payments`], queryFn: () => api.get<any[]>(`/suppliers/${id}/payments`) })
  if (isLoading) return <Loading />
  return (
    <Card title="Payments made" pad={false}>
      {!data?.length ? <Empty title="No payments yet" /> : (
        <LinesTable rows={data} cols={[
          { label: 'Payment', render: (p: any) => p.number },
          { label: 'Date', render: (p: any) => date(p.payment_date) },
          { label: 'Method', render: (p: any) => label(p.method) },
          { label: 'Reference', render: (p: any) => p.reference ?? '—' },
          { label: 'Amount', align: 'right', render: (p: any) => money(p.amount, { paisa: true }) },
        ]} />
      )}
    </Card>
  )
}

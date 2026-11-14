import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Printer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { compact, compactMoney, date, label, month, qty } from '../../lib/format'
import { useAction, useLookupName, useLookups, useRefMap } from '../../lib/hooks'
import { ChartCard, TrendChart } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { LineItems, type FormValues } from '../../ui/Form'
import { Badge, Button, Card, Confirm, Empty, Facts, Loading, Segmented, Status, Tabs } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { useToast } from '../../ui/toast'
import { MovementTable } from '../inventory/Movements'
import { StockActions } from '../inventory/StockOps'
import { moreFields, productDefaults, productFields } from './fields'
import { Costs, Pricing } from './ProductMoney'

type Tab = 'overview' | 'variants' | 'components' | 'units' | 'pricing' | 'costs' | 'stock' | 'suppliers'

export default function ProductDetail() {
  const id = Number(useParams().id)
  const can = useCan()
  const [sp, setSp] = useSearchParams()
  const tab = (sp.get('tab') ?? 'overview') as Tab
  const { data: p, isLoading } = useQuery({ queryKey: [`/products/${id}`], queryFn: () => api.get(`/products/${id}`) })
  const [edit, setEdit] = useState(false)
  const [archive, setArchive] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  if (isLoading || !p) return <Loading />

  const tabs: { value: Tab; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    ...(p.parent_id ? [] : [{ value: 'variants' as Tab, label: 'Variants' }]),
    ...(p.kind === 'bundle' ? [{ value: 'components' as Tab, label: 'Bundle items' }] : []),
    { value: 'units', label: 'Pack sizes' },
    { value: 'pricing', label: 'Pricing' },
    ...(can('product_costs') ? [{ value: 'costs' as Tab, label: 'Costs & margins' }] : []),
    ...(can('inventory') && p.track_stock ? [{ value: 'stock' as Tab, label: 'Stock' }] : []),
    ...(can('suppliers') ? [{ value: 'suppliers' as Tab, label: 'Suppliers' }] : []),
  ]
  const refresh = () => qc.invalidateQueries({ queryKey: [`/products/${id}`] })

  return (
    <>
      <RecordHeader back="/products" backLabel="Products" title={p.name}
        status={<>{<Status value={p.status} />}{p.archived_at && <Badge>Archived</Badge>}</>}
        meta={<>{p.sku}{p.barcode && ` · ${p.barcode}`} · {label(p.type)}{p.kind !== 'standard' && ` · ${label(p.kind)}`}
          {p.parent_id && <> · variant of <Link className="text-wine-700 hover:underline" to={`/products/${p.parent_id}`}>parent product</Link></>}</>}
        actions={<>
          <Link to={`/labels?product=${id}`}><Button icon={<Printer className="size-4" />}>Labels</Button></Link>
          {can('products', 'edit') && <Button variant="primary" onClick={() => setEdit(true)}>Edit</Button>}
        </>} />
      <div className="mb-4"><Tabs tabs={tabs} value={tab} onChange={(v) => setSp(v === 'overview' ? {} : { tab: v }, { replace: true })} /></div>

      {tab === 'overview' && <Overview p={p} />}
      {tab === 'variants' && <Variants p={p} />}
      {tab === 'components' && <Components id={id} />}
      {tab === 'units' && <PackUnits id={id} />}
      {tab === 'pricing' && <Pricing id={id} />}
      {tab === 'costs' && <Costs id={id} />}
      {tab === 'stock' && <StockTab id={id} />}
      {tab === 'suppliers' && <Suppliers id={id} />}

      <FormDrawer open={edit} onClose={() => setEdit(false)} title="Edit product" mode="edit" wide
        fields={[...productFields, ...moreFields]} initial={p}
        submit={async (b) => { await api.patch(`/products/${id}`, b); toast('Saved'); refresh() }}
        footerExtra={can('products', 'archive') && (p.archived_at
          ? <Button variant="ghost" onClick={async () => { await api.post(`/products/${id}/restore`); toast('Restored'); refresh(); setEdit(false) }}>Restore</Button>
          : <Button variant="ghost" className="text-bad" onClick={() => setArchive(true)}>Archive</Button>)} />
      <Confirm open={archive} onClose={() => setArchive(false)} danger confirmLabel="Archive" title="Archive this product?"
        body="It disappears from pickers and lists. Its history stays." onConfirm={async () => {
          await api.post(`/products/${id}/archive`); toast('Archived'); refresh(); setArchive(false); setEdit(false)
        }} />
    </>
  )
}

function Overview({ p }: { p: any }) {
  const can = useCan()
  const cat = useLookupName('product_categories')
  const unit = useLookupName('units')
  const tax = useLookupName('tax_rates')
  const { data: lk } = useLookups()
  const [metric, setMetric] = useState<'quantity' | 'revenue'>('quantity')
  const perf = useQuery({
    queryKey: [`/reports/products/${p.id}/performance`],
    queryFn: () => api.get<any[]>(`/reports/products/${p.id}/performance`, { months: 12 }),
    enabled: can('orders') && p.type === 'finished',
  })
  return (
    <RecordLayout
      main={<>
        {perf.data && (
          <ChartCard title="Sales, last 12 months" sub={metric === 'quantity' ? 'Units sold per month' : 'Revenue per month'}
            action={<Segmented value={metric} onChange={setMetric} options={[{ value: 'quantity', label: 'Units' }, { value: 'revenue', label: 'Revenue' }]} />}>
            {perf.data.length ? (
              <TrendChart kind="bar" data={perf.data} x="month" xFmt={month} height={220}
                fmt={metric === 'revenue' ? compactMoney : compact}
                series={[{ key: metric, label: metric === 'quantity' ? 'Units sold' : 'Revenue' }]} />
            ) : <Empty title="No sales yet" />}
          </ChartCard>
        )}
        <Card title="Details">
          <Facts items={[
            ['Category', p.category_id ? cat(p.category_id) : '—'], ['Stock unit', unit(p.unit_id)],
            ['Tax rate', p.tax_rate_id ? tax(p.tax_rate_id) : 'Default'], ['Tracking', p.track_stock ? (p.track_batches ? 'Stock and batches' : 'Stock') : 'Not tracked'],
            ['Shelf life', p.shelf_life_days ? `${p.shelf_life_days} days` : '—'], ['Launched', date(p.launch_date)],
            ['Sold on', p.channels?.length ? p.channels.map((c: string) => lk?.sales_channels.find((s) => s.code === c)?.name ?? label(c)).join(', ') : '—'], ['Added', date(p.created_at)],
          ]} />
          {p.description && <p className="mt-4 border-t border-line pt-4 text-[13.5px] text-ink-2">{p.description}</p>}
          {(p.packaging_spec || p.label_info) && (
            <details className="mt-4 border-t border-line pt-3">
              <summary className="cursor-pointer text-[13px] font-medium text-ink-2 hover:text-ink">Packaging and label</summary>
              <div className="mt-3"><Facts cols={1} items={[['Packaging spec', p.packaging_spec], ['Label information', p.label_info]]} /></div>
            </details>
          )}
        </Card>
      </>}
      side={<>
        <Attachments entity="products" id={p.id} canEdit={can('products', 'edit')} />
        <History entity="products" id={p.id} />
      </>} />
  )
}

function Variants({ p }: { p: any }) {
  const can = useCan()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  return (
    <>
      <DataTable path="/products" params={{ parent_id: p.id }} persist={false} search={false}
        rowTo={(v: any) => `/products/${v.id}`}
        toolbar={can('products', 'create') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Add variant</Button>}
        empty={{ title: 'No variants', body: 'Add sizes or flavours that share this product’s details but have their own SKU and stock.' }}
        columns={[
          { key: 'name', label: 'Variant', render: (v: any) => <span className="font-medium">{v.name}</span> },
          { key: 'sku', label: 'SKU' },
          { key: 'barcode', label: 'Barcode', render: (v: any) => v.barcode ?? '—' },
          { key: 'status', label: 'Status', render: (v: any) => <Status value={v.status} /> },
        ]} />
      <FormDrawer open={open} onClose={() => setOpen(false)} title="New variant" fields={productFields}
        initial={{ ...productDefaults, type: p.type, unit_id: p.unit_id, category_id: p.category_id, tax_rate_id: p.tax_rate_id, track_batches: p.track_batches, name: `${p.name} – ` }}
        submit={async (b) => { await api.post('/products', { ...b, parent_id: p.id }); qc.invalidateQueries({ queryKey: ['/products'] }) }} />
    </>
  )
}

/** Small list editor saved as a whole with PUT. */
function useListEditor(path: string, toRow: (r: any) => FormValues) {
  const { data, isLoading } = useQuery({ queryKey: [path], queryFn: () => api.get<any[]>(path) })
  const [rows, setRows] = useState<FormValues[]>([])
  useEffect(() => { if (data) setRows(data.map(toRow)) }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction((body: any[]) => api.put(path, body), { success: 'Saved', invalidate: [[path]] })
  return { rows, setRows, isLoading, save, dirty: JSON.stringify(rows) !== JSON.stringify((data ?? []).map(toRow)) }
}

function Components({ id }: { id: number }) {
  const can = useCan()
  const ed = useListEditor(`/products/${id}/components`, (r) => ({ component_id: String(r.component_id), quantity: r.quantity }))
  if (ed.isLoading) return <Loading />
  return (
    <Card title="Items in this bundle" action={can('products', 'edit') && <Button size="sm" variant="primary" disabled={!ed.dirty} loading={ed.save.isPending}
      onClick={() => ed.save.mutate(ed.rows.filter((r) => r.component_id).map((r) => ({ component_id: Number(r.component_id), quantity: r.quantity })))}>Save</Button>}>
      <LineItems value={ed.rows} onChange={ed.setRows} addLabel="Add item"
        columns={[{ name: 'component_id', label: 'Item', type: 'product' }, { name: 'quantity', label: 'Qty per bundle', type: 'number', width: '140px' }]} />
    </Card>
  )
}

function PackUnits({ id }: { id: number }) {
  const can = useCan()
  const ed = useListEditor(`/products/${id}/units`, (r) => ({ name: r.name, factor: r.factor, barcode: r.barcode ?? '' }))
  if (ed.isLoading) return <Loading />
  return (
    <Card title="Pack sizes" action={can('products', 'edit') && <Button size="sm" variant="primary" disabled={!ed.dirty} loading={ed.save.isPending}
      onClick={() => ed.save.mutate(ed.rows.filter((r) => r.name).map((r) => ({ name: r.name, factor: r.factor, barcode: r.barcode || null })))}>Save</Button>}>
      <p className="mb-3 text-[13px] text-ink-2">Cartons and cases you buy or sell in. The factor is how many stock units are in one pack; scanning a pack barcode picks the pack.</p>
      <LineItems value={ed.rows} onChange={ed.setRows} addLabel="Add pack size"
        columns={[{ name: 'name', label: 'Pack', type: 'text', placeholder: 'Carton of 24' }, { name: 'factor', label: 'Units per pack', type: 'number', width: '140px' }, { name: 'barcode', label: 'Barcode', type: 'text' }]} />
    </Card>
  )
}

function StockTab({ id }: { id: number }) {
  const can = useCan()
  const wh = useLookupName('warehouses')
  const { data: lk } = useLookups()
  const qc = useQueryClient()
  const [rule, setRule] = useState<any>(null)
  const bal = useQuery({ queryKey: [`/stock/balances/${id}`], queryFn: () => api.get<any[]>(`/stock/balances/${id}`) })
  const rules = useQuery({ queryKey: ['/stock/rules', id], queryFn: () => api.get<any[]>('/stock/rules', { product_id: id }) })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap justify-end gap-2"><StockActions defaults={{ product_id: id }} /></div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="On hand by warehouse and batch" pad={false}>
          {!bal.data?.length ? <Empty title="Nothing in stock" /> : (
            <table className="w-full text-[13.5px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted"><th className="px-4 py-2 font-medium">Warehouse</th><th className="px-4 py-2 font-medium">Batch</th><th className="px-4 py-2 font-medium">Expiry</th><th className="px-4 py-2 text-right font-medium">Qty</th></tr></thead>
              <tbody>{bal.data.map((b, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">{b.warehouse}{b.location && <span className="text-muted"> · {b.location}</span>}</td>
                  <td className="px-4">{b.batch_id ? <Link className="text-wine-700 hover:underline" to={`/stock/batches/${b.batch_id}`}>{b.batch}</Link> : '—'}{b.batch_status && b.batch_status !== 'available' && <Status value={b.batch_status} />}</td>
                  <td className="px-4 text-ink-2">{date(b.expiry_date)}</td>
                  <td className="tabular px-4 text-right font-medium">{qty(b.quantity)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="Reorder levels" pad={false} action={can('inventory', 'edit') && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setRule({})}>Set levels</Button>}>
          {!rules.data?.length ? <Empty title="No levels set">Set a reorder point so low stock shows up on the dashboard and in alerts.</Empty> : (
            <table className="w-full text-[13.5px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2 font-medium">Warehouse</th><th className="px-3 py-2 text-right font-medium">Min</th><th className="px-3 py-2 text-right font-medium">Reorder at</th><th className="px-3 py-2 text-right font-medium">Reorder qty</th><th className="px-4 py-2 text-right font-medium">Max</th>
              </tr></thead>
              <tbody>{rules.data.map((r) => (
                <tr key={r.warehouse_id} onClick={can('inventory', 'edit') ? () => setRule(r) : undefined} className="cursor-pointer border-b border-line last:border-0 hover:bg-wine-50/60">
                  <td className="px-4 py-2.5">{wh(r.warehouse_id)}</td>
                  {[r.min_qty, r.reorder_point, r.reorder_qty].map((v, i) => <td key={i} className="tabular px-3 text-right">{v == null ? '—' : qty(v)}</td>)}
                  <td className="tabular px-4 text-right">{r.max_qty == null ? '—' : qty(r.max_qty)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      </div>
      <MovementTable params={{ product_id: id }} persist={false} hideProduct />
      <FormDrawer open={!!rule} onClose={() => setRule(null)} title="Stock levels" initial={rule ? { ...rule, warehouse_id: rule.warehouse_id ?? lk?.warehouses?.[0]?.id } : undefined}
        fields={[
          { name: 'warehouse_id', label: 'Warehouse', type: 'lookup', lookup: 'warehouses', required: true, full: true },
          { name: 'reorder_point', label: 'Reorder when at or below', type: 'number' },
          { name: 'reorder_qty', label: 'Reorder quantity', type: 'number' },
          { name: 'min_qty', label: 'Minimum', type: 'number' },
          { name: 'safety_stock', label: 'Safety stock', type: 'number' },
          { name: 'max_qty', label: 'Maximum', type: 'number', hint: 'Above this shows as overstock' },
        ]}
        submit={async (b) => { await api.put('/stock/rules', { ...b, product_id: id }); qc.invalidateQueries({ queryKey: ['/stock/rules', id] }) }} />
    </div>
  )
}

function Suppliers({ id }: { id: number }) {
  const supplierName = useRefMap('/suppliers')
  const items = useQuery({ queryKey: [`/products/${id}/suppliers`], queryFn: () => api.get<any[]>(`/products/${id}/suppliers`) })
  const data = items.data?.map((i) => ({ ...i, supplier: { id: i.supplier_id, name: supplierName(i.supplier_id) } }))
  if (items.isLoading) return <Loading />
  return (
    <Card title="Who supplies this" pad={false}>
      {!data?.length ? <Empty title="No suppliers linked">Link this item from a supplier’s page.</Empty> : (
        <ul className="divide-y divide-line">
          {data.map((s: any) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[13.5px]">
              <div>
                <Link to={`/suppliers/${s.supplier.id}`} className="font-medium hover:text-wine-800">{s.supplier.name}</Link>
                {s.is_preferred && <Badge tone="brand" className="ml-2">Preferred</Badge>}
                <p className="text-[12px] text-muted">{s.supplier_sku ? `Their code ${s.supplier_sku} · ` : ''}Lead time {s.lead_time_days ?? '—'} days · MOQ {s.min_order_qty ? qty(s.min_order_qty) : '—'}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}


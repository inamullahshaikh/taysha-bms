import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MonitorSmartphone, PackageMinus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, asPage } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { compactMoney, date, dateTime, label, money, qty } from '../../lib/format'
import { useAction, useLookupName, useRefMap } from '../../lib/hooks'
import { BarList, ChartCard, SegmentBar, StatTile, TrendChart } from '../../ui/charts'
import { LineItems, cleanLines, type FieldDef, type FormValues } from '../../ui/Form'
import { Button, Card, Confirm, Empty, ErrorNote, Field, Input, Loading, Select, Status, Textarea } from '../../ui/kit'
import { History, RecordHeader } from '../../ui/Record'
import { FormDrawer, ResourcePage } from '../../ui/Resource'

const KINDS = ['stall', 'popup', 'event', 'branch', 'other']
const FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, full: true, placeholder: 'Clifton Food Carnival' },
  { name: 'kind', label: 'Type', type: 'select', options: KINDS, createOnly: true },
  { name: 'warehouse_id', label: 'Stock comes from', type: 'lookup', lookup: 'warehouses', required: true, createOnly: true },
  { name: 'location', label: 'Location', full: true },
  { name: 'start_date', label: 'Starts', type: 'date' },
  { name: 'end_date', label: 'Ends', type: 'date' },
  { name: 'branch_id', label: 'Branch', type: 'lookup', lookup: 'branches', createOnly: true },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Events() {
  const warehouse = useLookupName('warehouses')
  const recent = useQuery({
    queryKey: ['/pos/events', 'recent'],
    queryFn: async () => {
      const closed = asPage(await api.get('/pos/events', { status: 'closed', page_size: 8, sort: '-start_date' })).items
      if (!closed.length) return []
      return api.get<any[]>('/pos/events/compare', { ids: closed.map((e: any) => e.id).reverse().join(',') })
    },
    retry: false,
  })
  const rows = recent.data ?? []
  return (
    <div className="flex flex-col gap-4">
      {rows.length > 0 && (
        <ChartCard title="Recent events" sub="Revenue and profit after stock, samples and expenses">
          <TrendChart kind="bar" data={rows} x="name" height={220} fmt={(v) => compactMoney(v)}
            xFmt={(v) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)}
            series={[{ key: 'revenue', label: 'Revenue' }, { key: 'profit', label: 'Profit' }]} />
        </ChartCard>
      )}
      <ResourcePage
        path="/pos/events"
        feature="pos"
        noun="event"
        search="Search events or locations"
        fields={FIELDS}
        defaults={{ kind: 'stall' }}
        rowTo={(r: any) => `/pos/events/${r.id}`}
        filters={[{ key: 'status', label: 'Status', options: ['planned', 'open', 'closed'] }, { key: 'kind', label: 'Type', options: KINDS }]}
        columns={[
          { key: 'name', label: 'Event', render: (r: any) => <span className="block"><span className="font-medium">{r.name}</span>{r.location && <span className="block text-[12px] text-muted">{r.location}</span>}</span> },
          { key: 'kind', label: 'Type', render: (r: any) => label(r.kind) },
          { key: 'dates', label: 'Dates', render: (r: any) => (r.start_date ? `${date(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ` – ${date(r.end_date)}` : ''}` : '—') },
          { key: 'warehouse_id', label: 'Stock from', render: (r: any) => warehouse(r.warehouse_id) },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status === 'planned' ? 'scheduled' : r.status} /> },
        ]}
      />
    </div>
  )
}

export function EventDetail() {
  const id = Number(useParams().id)
  const can = useCan()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const key = [`/pos/events/${id}`]
  const ev = useQuery({ queryKey: key, queryFn: () => api.get(`/pos/events/${id}`) })
  const report = useQuery({ queryKey: [...key, 'report'], queryFn: () => api.get(`/pos/events/${id}/report`) })
  const sessions = useQuery({ queryKey: [...key, 'sessions'], queryFn: () => api.get<any[]>('/pos/sessions', { event_id: id }) })
  const sellable = useQuery({ queryKey: [`/pos/events/${id}/products`], queryFn: () => api.get<any[]>(`/pos/events/${id}/products`) })
  const user = useRefMap('/users')
  const [opening, setOpening] = useState(false)
  const [closing, setClosing] = useState<any>(null)
  const [closingEvent, setClosingEvent] = useState(false)
  const [editing, setEditing] = useState(false)
  const [using, setUsing] = useState(false)
  const opts = { invalidate: [key, ['/pos/events']] }
  const open = useAction(() => api.post(`/pos/events/${id}/open`), { ...opts, success: 'Event is open for sales' })
  const close = useAction(() => api.post(`/pos/events/${id}/close`), { ...opts, success: 'Event closed', onSuccess: () => setClosingEvent(false) })

  if (ev.isLoading) return <Loading />
  if (ev.error) return <ErrorNote error={ev.error} />
  const e = ev.data
  const r = report.data
  const create = can('pos', 'create')
  const openSessions = (sessions.data ?? []).filter((s) => s.status === 'open')

  return (
    <>
      <RecordHeader back="/pos" backLabel="Events" title={e.name} status={<Status value={e.status === 'planned' ? 'scheduled' : e.status} />}
        meta={[label(e.kind), e.location, e.start_date && date(e.start_date)].filter(Boolean).join(' · ')}
        actions={<>
          {can('pos', 'edit') && <Button onClick={() => setEditing(true)}>Edit</Button>}
          {create && e.status === 'planned' && <Button variant="primary" loading={open.isPending} onClick={() => open.mutate(undefined)}>Open for sales</Button>}
          {create && e.status === 'open' && <>
            <Button icon={<PackageMinus className="size-4" />} onClick={() => setUsing(true)}>Samples & wastage</Button>
            <Button onClick={() => setClosingEvent(true)} disabled={openSessions.length > 0} title={openSessions.length ? 'Close all tills first' : undefined}>Close event</Button>
            <Button variant="primary" icon={<MonitorSmartphone className="size-4" />} onClick={() => setOpening(true)}>Open a till</Button>
          </>}
        </>} />

      {r && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Revenue" value={money(r.revenue)} sub={`${r.sales} sales`} />
            <StatTile label="Average sale" value={money(r.average_sale)} />
            <StatTile label="Cost of stock sold" value={money(r.cogs)} sub={`${money(r.consumption_cost)} samples · ${money(r.expenses)} expenses`} />
            <StatTile label="Profit" value={money(r.profit)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="What sold">
              <BarList items={r.products.map((p: any) => ({ label: p.name, value: p.revenue, sub: `${qty(p.quantity)} sold` }))} fmt={(v) => money(v)} empty="No sales yet" />
            </ChartCard>
            <ChartCard title="How customers paid">
              <SegmentBar parts={Object.entries(r.payments_by_method).map(([k, v]) => ({ label: label(k), value: v as string }))} fmt={(v) => money(v)} />
              {r.by_cashier.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-[12.5px] font-medium text-ink-2">By cashier</p>
                  <BarList items={r.by_cashier.map((c: any) => ({ label: user(c.user_id), value: c.revenue, sub: `${c.sales} sales` }))} fmt={(v) => money(v)} />
                </div>
              )}
            </ChartCard>
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <StockCounts eventId={id} canEdit={create && e.status !== 'closed'}
              rows={r.stock_reconciliation.length ? r.stock_reconciliation : (sellable.data ?? []).map((p) => ({ product_id: p.product_id, name: p.name, opening: null, sold: 0, consumed: 0, expected_closing: null, counted_closing: null, variance: null }))} />
            <div className="flex flex-col gap-4">
              <Card title="Tills" pad={false}>
                {!sessions.data?.length ? <Empty title="No tills opened yet" /> : (
                  <ul className="divide-y divide-line">
                    {sessions.data.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
                        <span>
                          <span className="font-medium">{user(s.created_by_id)}</span>
                          <span className="block text-[12px] text-muted">
                            {dateTime(s.opened_at)} · float {money(s.opening_cash)}
                            {s.status === 'closed' && ` · counted ${money(s.counted_cash)}`}
                            {s.cash_variance != null && Number(s.cash_variance) !== 0 && <span className={Number(s.cash_variance) < 0 ? 'text-bad' : 'text-good'}> ({money(s.cash_variance)})</span>}
                          </span>
                        </span>
                        {s.status === 'open' && create ? (
                          <span className="flex gap-1.5">
                            <Button size="sm" onClick={() => setClosing(s)}>Close</Button>
                            <Button size="sm" variant="primary" onClick={() => navigate(`/pos/register/${s.id}`)}>Sell</Button>
                          </span>
                        ) : <Status value={s.status} />}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              {r.consumption.length > 0 && (
                <Card title="Samples & wastage">
                  <BarList items={r.consumption.map((c: any) => ({ label: `${r.stock_reconciliation.find((x: any) => x.product_id === c.product_id)?.name ?? `#${c.product_id}`} · ${label(c.reason)}`, value: c.quantity }))} fmt={(v) => qty(v)} />
                </Card>
              )}
              <History entity="pos_events" id={id} />
            </div>
          </div>
        </div>
      )}

      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit event" mode="edit" fields={FIELDS} initial={e}
        submit={async (b) => { await api.patch(`/pos/events/${id}`, b); qc.invalidateQueries({ queryKey: key }) }} />
      <FormDrawer open={opening} onClose={() => setOpening(false)} title="Open a till" submitLabel="Open till"
        fields={[{ name: 'opening_cash', label: 'Cash float in the drawer', type: 'money', full: true }]} initial={{ opening_cash: '5000' }}
        submit={async (b) => { const s = await api.post('/pos/sessions', { event_id: id, opening_cash: b.opening_cash ?? 0 }); navigate(`/pos/register/${s.id}`) }} />
      <FormDrawer open={!!closing} onClose={() => setClosing(null)} title="Close till" submitLabel="Close till"
        fields={[{ name: 'counted_cash', label: 'Cash counted in the drawer', type: 'money', required: true, full: true }, { name: 'note', label: 'Note', type: 'textarea' }]}
        submit={async (b) => { await api.post(`/pos/sessions/${closing.id}/close`, b); qc.invalidateQueries({ queryKey: key }) }} />
      <Confirm open={closingEvent} onClose={() => setClosingEvent(false)} title="Close this event?" confirmLabel="Close event" loading={close.isPending}
        body="No more sales can be made. Enter the closing stock count first so the report shows any variance." onConfirm={() => close.mutate(undefined)} />
      <Consumption open={using} onClose={() => setUsing(false)} eventId={id} />
    </>
  )
}

/** Opening and closing counts against what the system expects. */
function StockCounts({ eventId, rows, canEdit }: { eventId: number; rows: any[]; canEdit: boolean }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<'opening' | 'closing' | null>(null)
  const [values, setValues] = useState<Record<number, string>>({})
  const save = useAction(() => api.put(`/pos/events/${eventId}/counts/${kind}`, rows.filter((r) => values[r.product_id] !== undefined && values[r.product_id] !== '')
    .map((r) => ({ product_id: r.product_id, quantity: values[r.product_id] }))), {
    success: 'Count saved', onSuccess: () => { setKind(null); qc.invalidateQueries({ queryKey: [`/pos/events/${eventId}`] }) },
  })
  const begin = (k: 'opening' | 'closing') => {
    setValues(Object.fromEntries(rows.map((r) => [r.product_id, (k === 'opening' ? r.opening : r.counted_closing) ?? ''])))
    setKind(k)
  }
  return (
    <Card title="Stock at the stall" pad={false} action={canEdit && !kind && (
      <span className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => begin('opening')}>Opening count</Button>
        <Button size="sm" variant="ghost" onClick={() => begin('closing')}>Closing count</Button>
      </span>
    )}>
      {!rows.length ? <Empty title="No stock counted yet" /> : (
        <div className="scroll-quiet overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="px-4 py-2 font-medium">Product</th>
              <th className="px-2 py-2 text-right font-medium">Opening</th><th className="px-2 py-2 text-right font-medium">Sold</th>
              <th className="px-2 py-2 text-right font-medium">Used</th><th className="px-2 py-2 text-right font-medium">Expected</th>
              <th className="px-2 py-2 text-right font-medium">Counted</th><th className="px-4 py-2 text-right font-medium">Variance</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.product_id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">{r.name}</td>
                  <td className="tabular px-2 py-2 text-right">{kind === 'opening'
                    ? <Input aria-label={`Opening ${r.name}`} type="number" className="ml-auto h-8 w-20 text-right" value={values[r.product_id] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [r.product_id]: e.target.value }))} />
                    : qty(r.opening)}</td>
                  <td className="tabular px-2 py-2 text-right">{qty(r.sold)}</td>
                  <td className="tabular px-2 py-2 text-right">{qty(r.consumed)}</td>
                  <td className="tabular px-2 py-2 text-right">{qty(r.expected_closing)}</td>
                  <td className="tabular px-2 py-2 text-right">{kind === 'closing'
                    ? <Input aria-label={`Closing ${r.name}`} type="number" className="ml-auto h-8 w-20 text-right" value={values[r.product_id] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [r.product_id]: e.target.value }))} />
                    : r.counted_closing == null ? '—' : qty(r.counted_closing)}</td>
                  <td className={`tabular px-4 py-2 text-right ${r.variance != null && Number(r.variance) < 0 ? 'text-bad' : ''}`}>{r.variance == null ? '—' : qty(r.variance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {kind && (
        <div className="flex justify-end gap-2 border-t border-line p-3">
          <Button onClick={() => setKind(null)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save {kind} count</Button>
        </div>
      )}
    </Card>
  )
}

function Consumption({ open, onClose, eventId }: { open: boolean; onClose: () => void; eventId: number }) {
  const [reason, setReason] = useState('sample')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<FormValues[]>([{ product_id: '', quantity: '' }])
  const save = useAction(() => api.post('/pos/consumption', { event_id: eventId, reason, note: note || undefined, lines: cleanLines(lines) }), {
    success: 'Recorded', invalidate: [[`/pos/events/${eventId}`]], onSuccess: () => { onClose(); setLines([{ product_id: '', quantity: '' }]); setNote('') },
  })
  if (!open) return null
  return (
    <FormDrawer open onClose={onClose} title="Samples, giveaways & wastage" fields={[]} submitLabel="Record" submit={async () => { await save.mutateAsync(undefined) }}>
      <Field label="What happened"><Select value={reason} onChange={(e) => setReason(e.target.value)}
        options={[{ value: 'sample', label: 'Tasting samples' }, { value: 'complimentary', label: 'Given away free' }, { value: 'wastage', label: 'Wasted or damaged' }]} /></Field>
      <LineItems value={lines} onChange={setLines} addLabel="Add product" columns={[{ name: 'product_id', label: 'Product', type: 'product' }, { name: 'quantity', label: 'Qty', type: 'number', width: '100px' }]} />
      <Field label="Note"><Textarea className="min-h-14" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDrawer>
  )
}

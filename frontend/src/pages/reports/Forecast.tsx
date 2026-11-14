import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { month, qty } from '../../lib/format'
import { useUrlState } from '../../lib/hooks'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartCard, Legend, SERIES } from '../../ui/charts'
import { Button, ErrorNote, Loading, Segmented, Select } from '../../ui/kit'
import { SimpleTable, TableCard, Toolbar } from './shared'

export default function Forecast() {
  const can = useCan()
  const [months, setMonths] = useUrlState('months', '3')
  return (
    <>
      <Toolbar>
        <Segmented options={[{ value: '3', label: 'Next 3 months' }, { value: '6', label: 'Next 6 months' }]} value={months} onChange={setMonths} />
      </Toolbar>
      <div className="flex flex-col gap-4">
        {can('orders') && <Demand months={months} />}
        {can('production') && <Production />}
        {can('purchasing') && <Materials />}
      </div>
    </>
  )
}

function Demand({ months }: { months: string }) {
  const [pid, setPid] = useUrlState('product')
  const { data = [], isLoading, error } = useQuery({ queryKey: ['/forecast/demand', months], queryFn: () => api.get<any[]>('/forecast/demand', { months }) })
  if (error) return <ErrorNote error={error} />
  if (isLoading) return <Loading />
  const p = data.find((r) => String(r.product_id) === pid) ?? data[0]
  if (!p) return <ChartCard title="Demand forecast"><p className="py-8 text-center text-[13px] text-muted">Not enough sales history to forecast yet.</p></ChartCard>
  const last = p.history[p.history.length - 1]
  const rows = [
    ...p.history.map((h: any) => ({ month: h.month, actual: h.quantity })),
    ...p.forecast.map((f: any) => ({ month: f.month, forecast: f.quantity })),
  ]
  // the forecast line starts from the last actual month so the two lines join
  if (last) rows[p.history.length - 1].forecast = last.quantity
  return (
    <>
      <ChartCard title="Demand forecast" sub="Units sold per month, with the forecast from a weighted average and seasonality"
        action={
          <Select aria-label="Product" className="h-8 w-auto max-w-72 text-[13px]" value={String(p.product_id)} onChange={(e) => setPid(e.target.value)}
            options={data.map((r) => ({ value: r.product_id, label: r.name }))} />
        }>
        <DemandChart rows={rows} />
      </ChartCard>
      <TableCard title="Forecast by product">
        <SimpleTable rows={data} onRow={(r) => setPid(String(r.product_id))} cols={[
          { key: 'name', label: 'Product' },
          ...p.forecast.map((f: any, i: number) => ({ key: f.month, label: month(f.month), align: 'right' as const, render: (r: any) => units(r.forecast[i]?.quantity) })),
        ]} />
      </TableCard>
    </>
  )
}

/** Forecasts are estimates: show whole units. */
const units = (v: unknown) => (v == null ? '—' : qty(Math.round(Number(v))))

/** Sold vs forecast; gaps stay gaps (the kit's TrendChart plots missing values as zero). */
function DemandChart({ rows }: { rows: any[] }) {
  const data = rows.map((r) => ({ month: r.month, actual: r.actual == null ? null : Number(r.actual), forecast: r.forecast == null ? null : Number(r.forecast) }))
  return (
    <div>
      <div className="mb-3"><Legend items={[{ label: 'Sold', color: SERIES[0] }, { label: 'Forecast', color: SERIES[1] }]} /></div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#efe7e0" />
          <XAxis dataKey="month" tickFormatter={month} tickLine={false} axisLine={{ stroke: '#e1d6cc' }} tick={{ fill: '#8e8285', fontSize: 11.5 }} tickMargin={8} minTickGap={16} />
          <YAxis tickLine={false} axisLine={false} tick={{ fill: '#8e8285', fontSize: 11.5 }} width={44} allowDecimals={false} />
          <Tooltip cursor={{ stroke: '#d8c9cc' }} content={({ active, payload, label: l }: any) => active && payload?.length ? (
            <div className="rounded-lg bg-surface px-3 py-2 text-[12.5px] shadow-pop">
              <p className="mb-1 font-medium">{month(l)}</p>
              {payload.filter((x: any) => x.value != null).map((x: any) => (
                <p key={x.dataKey} className="flex items-center justify-between gap-4 text-ink-2">
                  <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: x.stroke }} />{x.name}</span>
                  <span className="tabular font-medium text-ink">{units(x.value)}</span>
                </p>
              ))}
            </div>
          ) : null} />
          <Line dataKey="actual" name="Sold" stroke={SERIES[0]} strokeWidth={2} dot={false} activeDot={{ r: 4.5, stroke: '#fff', strokeWidth: 2 }} type="monotone" />
          <Line dataKey="forecast" name="Forecast" stroke={SERIES[1]} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4.5, stroke: '#fff', strokeWidth: 2 }} type="monotone" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function Production() {
  const { data = [], isLoading, error } = useQuery({ queryKey: ['/forecast/production'], queryFn: () => api.get<any[]>('/forecast/production', { months: 1 }) })
  if (error) return <ErrorNote error={error} />
  return (
    <TableCard title="Suggested production for next month" action={<Link to="/production/plan"><Button size="sm">Open production plan</Button></Link>}>
      {isLoading ? <Loading /> : (
        <SimpleTable rows={data} empty="No products with an active recipe" cols={[
          { key: 'name', label: 'Product' },
          { key: 'forecast', label: 'Forecast', align: 'right', render: (r) => units(r.forecast) },
          { key: 'safety_stock', label: 'Safety stock', align: 'right', render: (r) => qty(r.safety_stock) },
          { key: 'available', label: 'Available', align: 'right', render: (r) => qty(r.available) },
          { key: 'in_production', label: 'In production', align: 'right', render: (r) => qty(r.in_production) },
          { key: 'suggested_quantity', label: 'Make', align: 'right', render: (r) => <span className="font-semibold">{qty(r.suggested_quantity)}</span> },
          { key: 'batches', label: 'Batches', align: 'right', render: (r) => qty(r.batches) },
        ]} />
      )}
    </TableCard>
  )
}

function Materials() {
  const [cover, setCover] = useUrlState('cover', '30')
  const { data = [], isLoading, error } = useQuery({ queryKey: ['/forecast/materials', cover], queryFn: () => api.get<any[]>('/forecast/materials', { cover_days: cover }) })
  if (error) return <ErrorNote error={error} />
  return (
    <TableCard title="Materials to reorder" action={
      <Select aria-label="Cover" className="h-8 w-auto max-w-56 text-[13px]" value={cover} onChange={(e) => setCover(e.target.value)}
        options={['14', '30', '60'].map((d) => ({ value: d, label: `Cover ${d} days after delivery` }))} />
    }>
      {isLoading ? <Loading /> : (
        <SimpleTable rows={data} empty="Stock and open purchase orders cover planned production" cols={[
          { key: 'name', label: 'Material' },
          { key: 'needed', label: 'Needed / month', align: 'right', render: (r) => qty(r.needed) },
          { key: 'available', label: 'Available', align: 'right', render: (r) => qty(r.available) },
          { key: 'on_order', label: 'On order', align: 'right', render: (r) => qty(r.on_order) },
          { key: 'lead_time_days', label: 'Lead time', align: 'right', render: (r) => `${r.lead_time_days}d` },
          { key: 'suggested_order', label: 'Order', align: 'right', render: (r) => <span className="font-semibold">{qty(r.suggested_order)}</span> },
          { key: 'supplier', label: 'Supplier', render: (r) => r.supplier_id ? <Link to={`/suppliers/${r.supplier_id}`} className="hover:text-wine-800">{r.supplier}</Link> : <span className="text-muted">No supplier</span> },
        ]} />
      )}
    </TableCard>
  )
}

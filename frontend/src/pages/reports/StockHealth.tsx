import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, label, money, pct, qty } from '../../lib/format'
import { useUrlState } from '../../lib/hooks'
import { BarList, ChartCard, SERIES } from '../../ui/charts'
import { cx, ErrorNote, Loading, Segmented, Select } from '../../ui/kit'
import { periodLabel, SimpleTable, TableCard, Toolbar, useRange } from './shared'

type View = 'slow' | 'wastage' | 'costs'

export default function StockHealth() {
  const can = useCan()
  const [view, setView] = useUrlState('view', 'slow')
  const views: { value: View; label: string }[] = [
    { value: 'slow', label: 'Slow-moving' },
    { value: 'wastage', label: 'Wastage' },
    ...(can('product_costs') ? [{ value: 'costs' as View, label: 'Cost changes' }] : []),
  ]
  return (
    <>
      <div className="mb-4"><Segmented options={views} value={view as View} onChange={setView} /></div>
      {view === 'slow' ? <SlowMoving /> : view === 'wastage' ? <Wastage /> : <CostChanges />}
    </>
  )
}

const productLink = (r: any) => <Link to={`/products/${r.product_id}`} className="hover:text-wine-800">{r.name}</Link>

function SlowMoving() {
  const [days, setDays] = useUrlState('days', '60')
  const { data = [], isLoading, error } = useQuery({ queryKey: ['/reports/slow-moving', days], queryFn: () => api.get<any[]>('/reports/slow-moving', { days }) })
  return (
    <>
      <Toolbar>
        <Select aria-label="Idle for" className="h-8 w-auto max-w-56 text-[13px]" value={days} onChange={(e) => setDays(e.target.value)}
          options={['30', '60', '90', '180'].map((d) => ({ value: d, label: `Not used for ${d}+ days` }))} />
      </Toolbar>
      {error ? <ErrorNote error={error} /> : isLoading ? <Loading /> : (
        <div className="flex flex-col gap-4">
          <ChartCard title="Stock value sitting idle" sub="Largest first">
            <BarList limit={10} fmt={(v) => money(v)} color={SERIES[1]}
              items={[...data].sort((a, b) => Number(b.value) - Number(a.value)).map((r) => ({ label: r.name, value: r.value, sub: r.days_idle != null ? `${r.days_idle}d` : 'never used', to: `/products/${r.product_id}` }))} />
          </ChartCard>
          <TableCard title={`${data.length} items`}>
            <SimpleTable rows={data} empty="Nothing has been idle that long" cols={[
              { key: 'name', label: 'Product', render: productLink },
              { key: 'type', label: 'Type', render: (r) => label(r.type) },
              { key: 'on_hand', label: 'On hand', align: 'right', render: (r) => qty(r.on_hand) },
              { key: 'value', label: 'Value', align: 'right', render: (r) => money(r.value) },
              { key: 'last_used', label: 'Last moved', align: 'right', render: (r) => date(r.last_used) },
              { key: 'days_idle', label: 'Days idle', align: 'right', render: (r) => r.days_idle ?? '—' },
            ]} />
          </TableCard>
        </div>
      )}
    </>
  )
}

function Wastage() {
  const { params, control } = useRange('month')
  const { data, isLoading, error } = useQuery({ queryKey: ['/reports/wastage', params], queryFn: () => api.get('/reports/wastage', params) })
  const rows: any[] = data?.rows ?? []
  return (
    <>
      <Toolbar>{control}</Toolbar>
      {error ? <ErrorNote error={error} /> : isLoading ? <Loading /> : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Production loss" sub={`Rejected and wasted as a share of output · ${periodLabel(data)}`}>
              <BarList fmt={(v) => pct(v)} color={SERIES[0]}
                items={rows.filter((r) => r.production_loss_pct != null).sort((a, b) => Number(b.production_loss_pct) - Number(a.production_loss_pct))
                  .map((r) => ({ label: r.name, value: r.production_loss_pct }))} />
            </ChartCard>
            <ChartCard title="Written off" sub="Damage, expiry and wastage from stock">
              <BarList fmt={(v) => money(v)} color={SERIES[1]}
                items={rows.filter((r) => Number(r.written_off_value) > 0).sort((a, b) => Number(b.written_off_value) - Number(a.written_off_value))
                  .map((r) => ({ label: r.name, value: r.written_off_value, sub: qty(r.written_off_qty) }))} />
            </ChartCard>
          </div>
          <TableCard title="By product">
            <SimpleTable rows={rows} empty="No wastage recorded in this period" cols={[
              { key: 'name', label: 'Product', render: productLink },
              { key: 'produced', label: 'Produced', align: 'right', render: (r) => qty(r.produced) },
              { key: 'rejected', label: 'Rejected', align: 'right', render: (r) => qty(r.rejected) },
              { key: 'production_wastage', label: 'Wasted', align: 'right', render: (r) => qty(r.production_wastage) },
              { key: 'production_loss_pct', label: 'Loss', align: 'right', render: (r) => pct(r.production_loss_pct) },
              { key: 'written_off_qty', label: 'Written off', align: 'right', render: (r) => qty(r.written_off_qty) },
              { key: 'written_off_value', label: 'Value', align: 'right', render: (r) => money(r.written_off_value) },
            ]} />
          </TableCard>
        </div>
      )}
    </>
  )
}

function CostChanges() {
  const [days, setDays] = useUrlState('days', '90')
  const { data = [], isLoading, error } = useQuery({ queryKey: ['/reports/cost-changes', days], queryFn: () => api.get<any[]>('/reports/cost-changes', { days }) })
  const sorted = [...data].sort((a, b) => Math.abs(Number(b.change_pct)) - Math.abs(Number(a.change_pct)))
  return (
    <>
      <Toolbar>
        <Select aria-label="Window" className="h-8 w-auto max-w-56 text-[13px]" value={days} onChange={(e) => setDays(e.target.value)}
          options={['30', '90', '180', '365'].map((d) => ({ value: d, label: `Last ${d} days` }))} />
      </Toolbar>
      {error ? <ErrorNote error={error} /> : isLoading ? <Loading /> : (
        <div className="flex flex-col gap-4">
          <ChartCard title="Biggest cost moves" sub="Rises in red, falls in green">
            <BarList limit={10} fmt={(v) => `${v.toFixed(1)}%`}
              items={sorted.map((r) => ({ label: `${r.name} · ${r.source}`, value: Math.abs(Number(r.change_pct)), color: Number(r.change_pct) > 0 ? '#c0392b' : '#12805c', sub: Number(r.change_pct) > 0 ? 'rise' : 'fall' }))} />
          </ChartCard>
          <TableCard title="All changes">
            <SimpleTable rows={sorted} empty="No cost changes in this window" cols={[
              { key: 'name', label: 'Product', render: productLink },
              { key: 'source', label: 'From', render: (r) => label(r.source) },
              { key: 'from', label: 'Was', align: 'right', render: (r) => money(r.from, { paisa: true }) },
              { key: 'to', label: 'Now', align: 'right', render: (r) => money(r.to, { paisa: true }) },
              { key: 'change_pct', label: 'Change', align: 'right', render: (r) => <span className={cx(Number(r.change_pct) > 0 ? 'text-bad' : 'text-good')}>{Number(r.change_pct) > 0 ? '+' : ''}{r.change_pct}%</span> },
            ]} />
          </TableCard>
        </div>
      )}
    </>
  )
}

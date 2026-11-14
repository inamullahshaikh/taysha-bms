import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { compact, label, money, month } from '../../lib/format'
import { useLookups, useUrlState } from '../../lib/hooks'
import { ChartCard, SERIES, TrendChart } from '../../ui/charts'
import { cx, ErrorNote, Input, Loading, Select } from '../../ui/kit'
import { periodLabel, SimpleTable, TableCard, Toolbar } from './shared'

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const now = new Date()
const DEFAULTS = {
  a_from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
  a_to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
  b_from: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
  b_to: iso(now),
}
const GROUPS = ['channel', 'product', 'customer', 'order_type', 'city', 'month', 'source', 'branch', 'territory', 'sales_rep']

export default function Compare() {
  const [aFrom, setAFrom] = useUrlState('a_from', DEFAULTS.a_from)
  const [aTo, setATo] = useUrlState('a_to', DEFAULTS.a_to)
  const [bFrom, setBFrom] = useUrlState('b_from', DEFAULTS.b_from)
  const [bTo, setBTo] = useUrlState('b_to', DEFAULTS.b_to)
  const [groupBy, setGroupBy] = useUrlState('group_by', 'channel')
  const [metric, setMetric] = useUrlState('metric', 'revenue')
  const lk = useLookups()
  const q = { a_from: aFrom, a_to: aTo, b_from: bFrom, b_to: bTo, group_by: groupBy, metric }
  const { data, isLoading, error } = useQuery({ queryKey: ['/reports/compare', q], queryFn: () => api.get('/reports/compare', q) })
  const fmt = (v: unknown) => (metric === 'orders' ? compact(v) : money(v))
  const name = (r: any) =>
    r.key == null ? 'Not set'
      : groupBy === 'channel' ? lk.data?.sales_channels.find((c) => c.code === r.key)?.name ?? r.key
      : groupBy === 'month' ? month(r.key)
      : groupBy === 'order_type' || groupBy === 'source' ? label(r.key) : String(r.label ?? r.key)
  const rows: any[] = (data?.rows ?? []).map((r: any) => ({ ...r, name: name(r) }))
  const aLabel = `Period A · ${periodLabel(data?.a)}`
  const bLabel = `Period B · ${periodLabel(data?.b)}`

  const period = (lbl: string, color: string, from: string, setF: (v: string) => void, to: string, setT: (v: string) => void) => (
    <div className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
      <span className="size-2 rounded-sm" style={{ background: color }} />{lbl}
      <Input type="date" aria-label={`${lbl} from`} className="h-8 w-auto" value={from} onChange={(e) => setF(e.target.value)} />
      <span className="text-muted">to</span>
      <Input type="date" aria-label={`${lbl} to`} className="h-8 w-auto" value={to} onChange={(e) => setT(e.target.value)} />
    </div>
  )

  return (
    <>
      <Toolbar>
        <div className="flex flex-wrap items-center gap-3">
          {period('A', SERIES[3], aFrom, setAFrom, aTo, setATo)}
          {period('B', SERIES[0], bFrom, setBFrom, bTo, setBTo)}
        </div>
        <div className="flex gap-2">
          <Select aria-label="Measure" className="h-8 w-auto max-w-56 text-[13px]" value={metric} onChange={(e) => setMetric(e.target.value)}
            options={[{ value: 'revenue', label: 'Revenue' }, { value: 'net_sales', label: 'Net sales' }, { value: 'orders', label: 'Orders' }]} />
          <Select aria-label="Group by" className="h-8 w-auto max-w-56 text-[13px]" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}
            options={GROUPS.map((g) => ({ value: g, label: `By ${label(g).toLowerCase()}` }))} />
        </div>
      </Toolbar>
      {error ? <ErrorNote error={error} /> : isLoading ? <Loading /> : (
        <div className="flex flex-col gap-4">
          <ChartCard title={`${label(metric)} by ${label(groupBy).toLowerCase()}`} sub="Biggest changes first">
            <TrendChart data={rows.slice(0, 10)} x="name" kind="bar" fmt={(v) => fmt(v)}
              series={[{ key: 'a', label: aLabel, color: SERIES[3] }, { key: 'b', label: bLabel, color: SERIES[0] }]} />
          </ChartCard>
          <TableCard title="All rows">
            <SimpleTable rows={rows} cols={[
              { key: 'name', label: label(groupBy) },
              { key: 'a', label: 'Period A', align: 'right', render: (r) => fmt(r.a) },
              { key: 'b', label: 'Period B', align: 'right', render: (r) => fmt(r.b) },
              { key: 'change', label: 'Change', align: 'right', render: (r) => <Delta v={r.change} text={fmt(r.change)} /> },
              { key: 'change_pct', label: '%', align: 'right', render: (r) => r.change_pct == null ? <span className="text-muted">new</span> : <Delta v={r.change_pct} text={`${Number(r.change_pct) > 0 ? '+' : ''}${r.change_pct}%`} /> },
            ]} />
          </TableCard>
        </div>
      )}
    </>
  )
}

const Delta = ({ v, text }: { v: unknown; text: string }) => (
  <span className={cx(Number(v) > 0 ? 'text-good' : Number(v) < 0 ? 'text-bad' : 'text-ink-2')}>{text}</span>
)

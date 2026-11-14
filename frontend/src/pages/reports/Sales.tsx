import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { compact, label, money, month, qty } from '../../lib/format'
import { useLookups, useRefMap, useUrlState } from '../../lib/hooks'
import { BarList, ChartCard, StatTile, TrendChart } from '../../ui/charts'
import { ErrorNote, Loading, Select } from '../../ui/kit'
import { SavedViews } from './SavedViews'
import { ExportMenu, periodLabel, SimpleTable, TableCard, Toolbar, useRange, type Col } from './shared'

const GROUPS = ['product', 'channel', 'customer', 'order_type', 'city', 'day', 'month', 'source', 'branch', 'territory', 'sales_rep']

export default function SalesReport() {
  const { params, control } = useRange('month')
  const [groupBy, setGroupBy] = useUrlState('group_by', 'product')
  const lk = useLookups()
  const territory = useRefMap('/territories')
  const userName = useRefMap('/users')
  const q = { ...params, group_by: groupBy }
  const { data, isLoading, error } = useQuery({ queryKey: ['/reports/sales', q], queryFn: () => api.get('/reports/sales', q) })

  const name = (r: any) => {
    if (r.key == null || r.key === '') return 'Not set'
    if (groupBy === 'channel') return lk.data?.sales_channels.find((c) => c.code === r.key)?.name ?? r.key
    if (groupBy === 'branch') return lk.data?.branches.find((b) => b.id === r.key)?.name ?? `#${r.key}`
    if (groupBy === 'territory') return territory(r.key)
    if (groupBy === 'sales_rep') return userName(r.key)
    if (groupBy === 'month') return month(r.key)
    if (groupBy === 'order_type' || groupBy === 'source') return label(r.key)
    return r.label ?? r.key
  }
  const rows: any[] = (data?.rows ?? []).map((r: any) => ({ ...r, name: name(r) }))
  const t = data?.totals
  const time = groupBy === 'day' || groupBy === 'month'
  const hasCost = rows.some((r) => r.gross_profit !== undefined)

  const cols: Col[] = [
    { key: 'name', label: label(groupBy) },
    { key: 'orders', label: 'Orders', align: 'right' },
    ...(groupBy === 'product' ? [{ key: 'quantity', label: 'Units', align: 'right' as const, render: (r: any) => qty(r.quantity) }] : []),
    { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => money(r.revenue) },
    { key: 'net_sales', label: 'Net sales', align: 'right', render: (r) => money(r.net_sales) },
    ...(hasCost ? [
      { key: 'cogs', label: 'Cost of goods', align: 'right' as const, render: (r: any) => money(r.cogs) },
      { key: 'gross_profit', label: 'Gross profit', align: 'right' as const, render: (r: any) => money(r.gross_profit) },
    ] : []),
  ]

  return (
    <>
      <Toolbar>
        {control}
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Group by" className="h-8 w-auto max-w-56 text-[13px]" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}
            options={GROUPS.map((g) => ({ value: g, label: `By ${label(g).toLowerCase()}` }))} />
          <SavedViews report="sales" />
          <ExportMenu feature="orders" path="/reports/sales" params={q} />
        </div>
      </Toolbar>
      {error ? <ErrorNote error={error} /> : isLoading ? <Loading /> : (
        <div className="flex flex-col gap-4">
          {t && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="Revenue" value={money(t.revenue)} sub={periodLabel(data)} />
              <StatTile label="Orders" value={compact(t.order_count)} />
              <StatTile label="Average order" value={money(t.average_order_value)} />
              <StatTile label="Net sales" value={money(t.net_sales)} sub={`Tax ${money(t.tax_collected)} · discounts ${money(t.discounts)}`} />
            </div>
          )}
          <ChartCard title={time ? 'Revenue over time' : `Revenue by ${label(groupBy).toLowerCase()}`} sub={periodLabel(data)}>
            {time ? (
              <TrendChart data={rows} x="key" kind={groupBy === 'month' ? 'bar' : 'area'} fmt={(v) => money(v)}
                xFmt={(v) => (groupBy === 'month' ? month(v) : v.slice(5))}
                series={[{ key: 'revenue', label: 'Revenue' }, { key: 'net_sales', label: 'Net sales' }]} />
            ) : (
              <BarList limit={12} fmt={(v) => money(v)}
                items={rows.map((r) => ({ label: r.name, value: r.revenue, sub: `${r.orders} orders` }))} />
            )}
          </ChartCard>
          <TableCard title="Breakdown"><SimpleTable rows={rows} cols={cols} /></TableCard>
        </div>
      )}
    </>
  )
}

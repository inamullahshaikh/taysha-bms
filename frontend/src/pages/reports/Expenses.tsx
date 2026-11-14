import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { label, money, month } from '../../lib/format'
import { useLookupName, useUrlState } from '../../lib/hooks'
import { BarList, ChartCard, SERIES, StatTile, TrendChart } from '../../ui/charts'
import { ErrorNote, Loading, Select } from '../../ui/kit'
import { SavedViews } from './SavedViews'
import { ExportMenu, periodLabel, SimpleTable, TableCard, Toolbar, useRange } from './shared'

const GROUPS = ['category', 'cost_centre', 'department', 'month']

export default function ExpensesReport() {
  const { params, control } = useRange('month')
  const [groupBy, setGroupBy] = useUrlState('group_by', 'category')
  const centre = useLookupName('cost_centres')
  const dept = useLookupName('departments')
  const q = { ...params, group_by: groupBy }
  const { data, isLoading, error } = useQuery({ queryKey: ['/reports/expenses', q], queryFn: () => api.get('/reports/expenses', q) })

  const name = (r: any) =>
    r.key == null ? 'Not set'
      : groupBy === 'cost_centre' ? centre(r.key)
      : groupBy === 'department' ? dept(r.key)
      : groupBy === 'month' ? month(r.key) : r.label
  const rows: any[] = (data?.rows ?? []).map((r: any) => ({ ...r, name: name(r) }))

  return (
    <>
      <Toolbar>
        {control}
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Group by" className="h-8 w-auto max-w-56 text-[13px]" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}
            options={GROUPS.map((g) => ({ value: g, label: `By ${label(g).toLowerCase()}` }))} />
          <SavedViews report="expenses" />
          <ExportMenu feature="expenses" path="/reports/expenses" params={q} />
        </div>
      </Toolbar>
      {error ? <ErrorNote error={error} /> : isLoading ? <Loading /> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Approved spend" value={money(data?.total)} sub={periodLabel(data)} />
            <StatTile label="Expenses" value={rows.reduce((s, r) => s + (r.count ?? 0), 0)} sub="count, approved" />
          </div>
          <ChartCard title={groupBy === 'month' ? 'Spend by month' : `Spend by ${label(groupBy).toLowerCase()}`} sub="Amounts before tax">
            {groupBy === 'month'
              ? <TrendChart data={rows} x="key" kind="bar" xFmt={month} fmt={(v) => money(v)} series={[{ key: 'amount', label: 'Spend', color: SERIES[1] }]} />
              : <BarList limit={12} color={SERIES[1]} fmt={(v) => money(v)} items={rows.map((r) => ({ label: r.name, value: r.amount, sub: `${r.count}` }))} />}
          </ChartCard>
          <TableCard title="Breakdown">
            <SimpleTable rows={rows} cols={[
              { key: 'name', label: label(groupBy) },
              { key: 'count', label: 'Expenses', align: 'right' },
              { key: 'amount', label: 'Amount excl. tax', align: 'right', render: (r) => money(r.amount) },
            ]} />
          </TableCard>
        </div>
      )}
    </>
  )
}

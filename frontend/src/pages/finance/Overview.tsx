import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { compactMoney, date, money, month } from '../../lib/format'
import { useAction } from '../../lib/hooks'
import { BarList, ChartCard, StatTile, TrendChart } from '../../ui/charts'
import { Badge, Button, Card, ErrorNote, Loading, Tabs } from '../../ui/kit'
import { useState } from 'react'
import { Amount, ExportMenu, usePeriod } from './shared'

type Row = { account_id: number; code: string; name: string; type: string; balance: string }

export default function FinanceOverview() {
  const { params, control } = usePeriod('year')
  const pl = useQuery({ queryKey: ['/accounting/profit-loss', params], queryFn: () => api.get('/accounting/profit-loss', params) })
  const cf = useQuery({ queryKey: ['/accounting/cash-flow', params], queryFn: () => api.get('/accounting/cash-flow', params) })
  const tax = useQuery({ queryKey: ['/accounting/tax', params], queryFn: () => api.get('/accounting/tax', params) })
  const bs = useQuery({ queryKey: ['/accounting/balance-sheet'], queryFn: () => api.get('/accounting/balance-sheet') })
  // monthly trend comes from the dashboard (only present with sales + cost access)
  const trend = useQuery({ queryKey: ['/dashboard', 'finance-trend'], queryFn: () => api.get('/dashboard', { range: 'year' }), retry: false })
  const sync = useAction(() => api.post('/accounting/sync'), { success: 'Ledger is up to date' })

  if (pl.error) return <ErrorNote error={pl.error} />
  const p = pl.data
  const expenseRows: Row[] = (p?.rows ?? []).filter((r: Row) => r.type === 'expense' && Number(r.balance) > 0)
  const months = trend.data?.trend as any[] | undefined

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {control}
        <div className="flex gap-2">
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={sync.isPending} onClick={() => sync.mutate(undefined)}>Sync ledger</Button>
          <ExportMenu feature="accounting" path="/accounting/profit-loss" params={params} />
        </div>
      </div>

      {!p ? <Loading /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile label="Income" value={compactMoney(p.income)} sub={`${date(p.from)} – ${date(p.to)}`} />
            <StatTile label="Gross profit" value={compactMoney(p.gross_profit)} sub={`after ${compactMoney(p.cost_of_sales)} cost of sales`} />
            <StatTile label="Operating expenses" value={compactMoney(p.expenses)} />
            <StatTile label="Net profit" value={<span className={Number(p.net_profit) < 0 ? 'text-bad' : ''}>{compactMoney(p.net_profit)}</span>} />
            <StatTile label="Sales tax payable" value={tax.data ? compactMoney(tax.data.net_payable) : '—'}
              sub={tax.data && `${compactMoney(tax.data.output_tax)} out · ${compactMoney(tax.data.input_tax)} in`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <ChartCard title="Net sales and expenses" sub="Last 12 months">
              {months?.length ? (
                <TrendChart data={months} x="month" xFmt={month} kind="line" fmt={(v) => money(v)}
                  series={[{ key: 'net_sales', label: 'Net sales' }, { key: 'expenses', label: 'Expenses', color: '#d9822b' }]} />
              ) : <p className="py-16 text-center text-[13px] text-muted">Monthly trend needs sales and cost access.</p>}
            </ChartCard>
            <ChartCard title="Where the money went" sub="Expense accounts this period">
              <BarList limit={7} fmt={(v) => compactMoney(v)}
                items={expenseRows.sort((a, b) => Number(b.balance) - Number(a.balance)).map((r) => ({ label: r.name, value: r.balance, to: `/accounting/ledger/${r.account_id}` }))} />
            </ChartCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Cash flow" sub={cf.data && `Opening ${money(cf.data.opening_cash)} · closing ${money(cf.data.closing_cash)}`}>
              {cf.data ? <CashFlow data={cf.data} /> : <Loading />}
            </ChartCard>
            <ChartCard title="Balance sheet" sub={bs.data && <>As of {date(bs.data.as_of)} {bs.data.balanced ? <Badge tone="good">Balanced</Badge> : <Badge tone="bad">Out of balance</Badge>}</>}>
              {bs.data ? (
                <>
                  <p className="mb-3 text-[12px] font-medium text-muted">Largest assets</p>
                  <BarList limit={5} color="#1f8a70" fmt={(v) => compactMoney(v)}
                    items={(bs.data.rows as Row[]).filter((r) => r.type === 'asset' && Number(r.balance) > 0)
                      .sort((a, b) => Number(b.balance) - Number(a.balance))
                      .map((r) => ({ label: r.name, value: r.balance, to: `/accounting/ledger/${r.account_id}` }))} />
                  <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-[13px]">
                    {[['Assets', bs.data.total_assets], ['Liabilities', bs.data.total_liabilities], ['Equity', bs.data.total_equity]].map(([k, v]) => (
                      <div key={k}><dt className="text-[12px] text-muted">{k}</dt><dd className="mt-0.5 font-semibold"><Amount v={v} /></dd></div>
                    ))}
                  </dl>
                </>
              ) : <Loading />}
            </ChartCard>
          </div>

          <Statements pl={p} bs={bs.data} />
        </>
      )}
    </div>
  )
}

function CashFlow({ data }: { data: any }) {
  const lines: { account: string; amount: string }[] = [
    ...data.operating.lines, ...data.investing.lines, ...data.financing.lines,
  ].sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount))).slice(0, 8)
  const max = Math.max(...lines.map((l) => Math.abs(Number(l.amount))), 1)
  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-3 text-[13px]">
        {[['Operating', data.operating.total], ['Investing', data.investing.total], ['Financing', data.financing.total]].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-page px-3 py-2"><p className="text-[12px] text-muted">{k}</p><p className="mt-0.5 font-semibold"><Amount v={v} /></p></div>
        ))}
      </div>
      <ul className="flex flex-col gap-2">
        {lines.map((l) => {
          const n = Number(l.amount), w = (Math.abs(n) / max) * 50
          return (
            <li key={l.account} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_80px] items-center gap-3 text-[12.5px]">
              <span className="truncate text-ink-2">{l.account.replace(/^\d+ /, '')}</span>
              <span className="relative h-2 rounded-full bg-sunken" aria-hidden>
                <span className="absolute top-0 h-full w-px bg-line-strong" style={{ left: '50%' }} />
                <span className="absolute top-0 h-full rounded-full" style={{ width: `${w}%`, left: n < 0 ? `${50 - w}%` : '50%', background: n < 0 ? '#c0392b' : '#12805c' }} />
              </span>
              <span className="text-right"><Amount v={l.amount} /></span>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-[12px] text-muted">Money in to the right, money out to the left.</p>
    </div>
  )
}

function Statements({ pl, bs }: { pl: any; bs: any }) {
  const [tab, setTab] = useState<'pl' | 'bs'>('pl')
  const rows: Row[] = tab === 'pl' ? pl.rows : (bs?.rows ?? [])
  const groups = tab === 'pl' ? ['income', 'expense'] : ['asset', 'liability', 'equity']
  const totals: Record<string, string | undefined> = tab === 'pl'
    ? { income: pl.income }
    : { asset: bs?.total_assets, liability: bs?.total_liabilities, equity: bs?.total_equity }
  const names: Record<string, string> = { income: 'Income', expense: 'Expenses', asset: 'Assets', liability: 'Liabilities', equity: 'Equity' }
  return (
    <Card pad={false} title={<Tabs value={tab} onChange={setTab} tabs={[{ value: 'pl', label: 'Profit & loss' }, { value: 'bs', label: 'Balance sheet' }]} />}>
      <table className="w-full text-[13px]">
        <tbody>
          {groups.map((g) => {
            const list = rows.filter((r) => r.type === g)
            if (!list.length) return null
            return [
              <tr key={g} className="bg-page"><th colSpan={2} className="px-4 py-2 text-left text-[12px] font-medium text-muted">{names[g]}</th></tr>,
              ...list.map((r) => (
                <tr key={r.account_id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2"><Link to={`/accounting/ledger/${r.account_id}`} className="hover:text-wine-800"><span className="mr-2 text-muted tabular">{r.code}</span>{r.name}</Link></td>
                  <td className="px-4 py-2 text-right"><Amount v={r.balance} /></td>
                </tr>
              )),
              totals[g] ? <tr key={`${g}-t`} className="border-b border-line"><td className="px-4 py-2 font-medium">Total {names[g].toLowerCase()}</td><td className="px-4 py-2 text-right"><Amount v={totals[g]} strong /></td></tr> : null,
            ]
          })}
          {tab === 'pl' && (
            <tr className="bg-wine-50"><td className="px-4 py-2.5 font-semibold">Net profit</td><td className="px-4 py-2.5 text-right"><Amount v={pl.net_profit} strong /></td></tr>
          )}
        </tbody>
      </table>
    </Card>
  )
}

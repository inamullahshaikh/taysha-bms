import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, ChevronRight, CircleCheck, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, qs } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { compact, compactMoney, date, label, money, month, pct, qty } from '../../lib/format'
import { useUrlState } from '../../lib/hooks'
import { BarList, ChartCard, Meter, SegmentBar, SERIES, StatTile, TrendChart } from '../../ui/charts'
import { Button, Checkbox, cx, Drawer, ErrorNote, IconButton, Segmented, Spinner, Status } from '../../ui/kit'
import { useToast } from '../../ui/toast'

type Range = 'today' | 'week' | 'month' | 'year' | 'custom'
type Data = Record<string, any>

const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'custom', label: 'Custom' },
]

const STATUS_COLORS: Record<string, string> = {
  draft: '#b8aaa6', confirmed: SERIES[3], processing: SERIES[1], packed: SERIES[4], dispatched: SERIES[5],
  delivered: SERIES[2], cancelled: '#8e8285', returned: SERIES[0], refunded: SERIES[0],
}

/* ---------- Widgets ---------- */

type Widget = {
  key: string
  title: string
  span: 1 | 2 | 3
  /** dashboard section(s) the widget needs; hidden when the API leaves them out (no access) */
  needs: string[]
  render: (d: Data, ctx: Ctx) => ReactNode
}
type Ctx = { range: string; from: string; to: string }

const listLink = (path: string, c: Ctx, extra: Record<string, string> = {}) => `${path}${qs({ date_from: c.from, date_to: c.to, ...extra })}`

const WIDGETS: Widget[] = [
  {
    key: 'sales_summary', title: 'Sales summary', span: 3, needs: ['sales'],
    render: (d, c) => {
      const s = d.sales
      const spark = (d.trend ?? []).map((m: any) => Number(m.revenue))
      return (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Revenue" value={compactMoney(s.revenue)} delta={s.revenue_growth_pct} spark={spark}
            sub={`${money(s.previous.revenue)} before`} to="/reports/sales" />
          <StatTile label="Orders" value={Number(s.order_count).toLocaleString()} delta={s.order_growth_pct}
            sub={`${s.previous.order_count} before`} to={listLink('/orders', c)} />
          <StatTile label="Average order" value={compactMoney(s.average_order_value)}
            delta={growth(s.average_order_value, s.previous.average_order_value)} sub={`${money(s.discounts)} in discounts`} />
          {d.profit ? (
            <StatTile label="Gross profit" value={compactMoney(d.profit.gross_profit)} sub={`${pct(d.profit.gross_margin_pct)} margin`} to="/finance" />
          ) : (
            <StatTile label="Net sales" value={compactMoney(s.net_sales)} sub={`${money(s.tax_collected)} tax collected`} />
          )}
        </div>
      )
    },
  },
  {
    key: 'sales_trend', title: 'Last 12 months', span: 2, needs: ['trend'],
    render: (d) => {
      const withCost = d.trend.some((m: any) => m.expenses !== undefined)
      return (
        <ChartCard title={withCost ? 'Revenue, expenses and profit' : 'Revenue'} sub="Last 12 months, by order date">
          <TrendChart data={d.trend} x="month" xFmt={month} kind="line" height={280} fmt={(v) => money(v)}
            series={withCost
              ? [{ key: 'revenue', label: 'Revenue' }, { key: 'expenses', label: 'Expenses', color: SERIES[1] }, { key: 'profit', label: 'Net profit', color: SERIES[2] }]
              : [{ key: 'revenue', label: 'Revenue' }]} />
        </ChartCard>
      )
    },
  },
  { key: 'sales_by_channel', title: 'Sales mix', span: 1, needs: ['sales'], render: (d) => <SalesMix sales={d.sales} /> },
  {
    key: 'order_status', title: 'Orders by status', span: 1, needs: ['sales'],
    render: (d, c) => {
      const counts = Object.entries(d.sales.status_counts as Record<string, number>)
      return (
        <ChartCard title="Orders by status" sub={`${counts.reduce((s, [, v]) => s + v, 0)} orders in this period`}
          action={<Link to={listLink('/orders', c)} className="text-[12.5px] text-wine-700 hover:underline">Open orders</Link>}>
          <SegmentBar fmt={(v) => String(v)} parts={counts.sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: label(k), value: v, color: STATUS_COLORS[k] }))} />
        </ChartCard>
      )
    },
  },
  {
    key: 'top_products', title: 'Top products', span: 1, needs: ['sales'],
    render: (d) => (
      <ChartCard title="Top products" sub="By revenue">
        <BarList fmt={(v) => compactMoney(v)} limit={6}
          items={d.sales.top_products.map((p: any) => ({ label: p.label, value: p.revenue, sub: `${qty(p.quantity)} sold`, to: `/products/${p.key}` }))} />
      </ChartCard>
    ),
  },
  {
    key: 'profit_summary', title: 'Profit', span: 1, needs: ['profit'],
    render: (d) => {
      const p = d.profit
      const margin = Number(p.gross_margin_pct)
      return (
        <ChartCard title="Profit" sub="Net sales less cost of goods and expenses">
          <div className="grid grid-cols-2 gap-4">
            <Figure label="Gross profit" value={compactMoney(p.gross_profit)} />
            <Figure label="Net profit" value={compactMoney(p.net_profit)} tone={Number(p.net_profit) < 0 ? 'bad' : undefined} />
          </div>
          <div className="mt-4">
            <div className="mb-1.5 flex justify-between text-[12px] text-ink-2"><span>Gross margin</span><span className="tabular font-medium text-ink">{pct(margin)}</span></div>
            <Meter value={margin} max={100} tone={margin < 25 ? 'warn' : 'brand'} />
          </div>
          {p.most_profitable?.length > 0 && (
            <div className="mt-5">
              <p className="mb-2.5 text-[12px] font-medium text-muted">Most profitable</p>
              <BarList fmt={(v) => compactMoney(v)} limit={3} color={SERIES[2]}
                items={p.most_profitable.map((r: any) => ({ label: r.label, value: r.gross_profit }))} />
            </div>
          )}
        </ChartCard>
      )
    },
  },
  {
    key: 'expenses_summary', title: 'Expenses', span: 1, needs: ['expenses'],
    render: (d) => {
      const e = d.expenses
      return (
        <ChartCard title="Expenses" sub="Approved, excluding tax"
          action={e.pending_approvals > 0 ? <Link to="/approvals" className="text-[12.5px] text-wine-700 hover:underline">{e.pending_approvals} to approve</Link> : undefined}>
          <div className="mb-5 flex items-end justify-between gap-3">
            <Figure label="This period" value={compactMoney(e.period_total)} />
            <Delta value={e.growth_pct} upIsGood={false} />
          </div>
          <BarList fmt={(v) => compactMoney(v)} limit={5} color={SERIES[1]}
            items={e.top_categories.map((c: any) => ({ label: c.label, value: c.amount }))} />
        </ChartCard>
      )
    },
  },
  {
    key: 'customers_summary', title: 'Customers', span: 1, needs: ['customers'],
    render: (d) => {
      const c = d.customers
      return (
        <ChartCard title="Customers" action={<Link to="/customers" className="text-[12.5px] text-wine-700 hover:underline">All customers</Link>}>
          <div className="grid grid-cols-3 gap-3">
            <Figure label="Active" value={c.active_customers} />
            <Figure label="New" value={c.new_customers} />
            <Figure label="VIP" value={c.vip_customers} />
          </div>
          <div className="mt-5">
            <div className="mb-1.5 flex justify-between text-[12px] text-ink-2"><span>Came back to buy again</span><span className="tabular font-medium text-ink">{pct(c.retention_pct, 0)}</span></div>
            <Meter value={Number(c.retention_pct)} max={100} />
          </div>
          <p className="mt-4 text-[12.5px] text-ink-2">Average lifetime value <span className="tabular font-medium text-ink">{money(c.average_lifetime_value)}</span></p>
        </ChartCard>
      )
    },
  },
  {
    key: 'receivables', title: 'Money owed', span: 1, needs: ['customers'],
    render: (d) => (
      <ChartCard title="Money owed" sub="Unpaid invoices and bills"
        action={<Link to="/receivables" className="text-[12.5px] text-wine-700 hover:underline">Aging</Link>}>
        <Rows rows={[
          { label: 'Customers owe us', value: money(d.customers.outstanding), to: '/receivables' },
          { label: 'Of that, overdue', value: money(d.customers.overdue), tone: Number(d.customers.overdue) > 0 ? 'bad' : 'good', to: '/documents?unpaid=true' },
          ...(d.purchasing ? [
            { label: 'We owe suppliers', value: money(d.purchasing.outstanding_payables), to: '/supplier-bills?unpaid=true' },
            { label: 'Of that, overdue', value: money(d.purchasing.overdue_payables), tone: Number(d.purchasing.overdue_payables) > 0 ? 'bad' as const : 'good' as const },
          ] : []),
        ]} />
      </ChartCard>
    ),
  },
  {
    key: 'inventory_summary', title: 'Stock', span: 1, needs: ['inventory'],
    render: (d) => {
      const i = d.inventory
      return (
        <ChartCard title="Stock" action={<Link to="/stock" className="text-[12.5px] text-wine-700 hover:underline">Stock levels</Link>}>
          <div className="grid grid-cols-2 gap-4">
            {i.valuation !== undefined && <Figure label="Stock value" value={compactMoney(i.valuation)} />}
            <Figure label="Products tracked" value={i.total_products} />
            <Figure label="Reserved for orders" value={compact(i.reserved_quantity)} />
            <Figure label="In transit" value={compact(i.in_transit_quantity)} />
          </div>
          <p className="mt-4 text-[12.5px] text-ink-2">Stock turns over <span className="font-medium text-ink">{i.turnover_annualised}×</span> a year at this pace</p>
        </ChartCard>
      )
    },
  },
  {
    key: 'stock_alerts', title: 'Stock alerts', span: 1, needs: ['inventory'],
    render: (d) => {
      const i = d.inventory
      return (
        <ChartCard title="Stock alerts">
          <Rows rows={[
            { label: 'Out of stock', value: i.out_of_stock, tone: i.out_of_stock ? 'bad' : 'good', to: '/stock?status=out_of_stock' },
            { label: 'Below reorder level', value: i.low_stock, tone: i.low_stock ? 'warn' : 'good', to: '/stock?status=low' },
            { label: 'Materials short for production', value: i.materials_short, tone: i.materials_short ? 'warn' : 'good', to: '/production/plan' },
            { label: 'Batches expiring soon', value: i.expiring_batches, tone: i.expiring_batches ? 'warn' : 'good', to: '/stock/batches?expiring_within_days=30' },
            { label: 'Expired batches still in stock', value: i.expired_batches_with_stock, tone: i.expired_batches_with_stock ? 'bad' : 'good', to: '/stock/batches?expired=true' },
            { label: 'Over maximum', value: i.overstock, tone: i.overstock ? 'warn' : 'good', to: '/stock?status=overstock' },
          ]} />
        </ChartCard>
      )
    },
  },
  {
    key: 'purchasing_summary', title: 'Purchasing', span: 1, needs: ['purchasing'],
    render: (d) => {
      const p = d.purchasing
      return (
        <ChartCard title="Purchasing" sub={`${compactMoney(p.purchases)} ordered this period`}>
          <Rows rows={[
            { label: 'Waiting for approval', value: p.pending_approval, tone: p.pending_approval ? 'warn' : 'good', to: '/approvals' },
            { label: 'Waiting for delivery', value: p.awaiting_delivery, to: '/purchase-orders?open_only=true' },
            { label: 'Supplier price changes, 30 days', value: p.price_changes_30d, tone: p.price_changes_30d ? 'warn' : 'good', to: '/purchasing/price-changes' },
            { label: 'Active suppliers', value: `${p.active_suppliers} of ${p.total_suppliers}`, to: '/suppliers' },
          ]} />
        </ChartCard>
      )
    },
  },
  {
    key: 'production_summary', title: 'Production', span: 1, needs: ['production'],
    render: (d) => {
      const p = d.production
      const eff = Number(p.efficiency_pct ?? 0)
      return (
        <ChartCard title="Production" sub={`${p.completed_orders} runs completed`}
          action={<Link to="/production-orders" className="text-[12.5px] text-wine-700 hover:underline">Production orders</Link>}>
          <div className="grid grid-cols-2 gap-4">
            <Figure label="Units made" value={qty(p.output_quantity)} />
            <Figure label="In progress" value={p.active_orders} />
            {p.average_unit_cost != null && <Figure label="Average unit cost" value={money(p.average_unit_cost, { paisa: true })} />}
            <Figure label="Wastage" value={pct(p.wastage_pct)} tone={Number(p.wastage_pct) > 5 ? 'bad' : undefined} />
          </div>
          <div className="mt-4">
            <div className="mb-1.5 flex justify-between text-[12px] text-ink-2"><span>Yield vs plan</span><span className="tabular font-medium text-ink">{pct(eff)}</span></div>
            <Meter value={eff} max={100} tone={eff < 90 ? 'warn' : 'good'} />
          </div>
        </ChartCard>
      )
    },
  },
  { key: 'production_schedule', title: 'Production schedule', span: 1, needs: ['production'], render: () => <Schedule /> },
  {
    key: 'marketing_summary', title: 'Marketing', span: 1, needs: ['marketing'],
    render: (d) => {
      const m = d.marketing
      return (
        <ChartCard title="Marketing" sub={`${m.active_campaigns} of ${m.total_campaigns} campaigns running`}
          action={<Link to="/marketing" className="text-[12.5px] text-wine-700 hover:underline">Performance</Link>}>
          <div className="grid grid-cols-2 gap-4">
            <Figure label="Ad spend" value={compactMoney(m.spend)} />
            <Figure label="Revenue from campaigns" value={compactMoney(m.marketing_revenue)} />
            <Figure label="Return on ad spend" value={m.roas != null ? `${Number(m.roas).toFixed(2)}×` : '—'} tone={m.roas != null && Number(m.roas) < 1 ? 'bad' : undefined} />
            <Figure label="Cost per customer" value={m.cac != null ? compactMoney(m.cac) : '—'} />
          </div>
        </ChartCard>
      )
    },
  },
  {
    key: 'tasks_summary', title: 'Tasks', span: 1, needs: ['tasks'],
    render: (d) => {
      const t = d.tasks
      return (
        <ChartCard title="Tasks" action={<Link to="/tasks" className="text-[12.5px] text-wine-700 hover:underline">All tasks</Link>}>
          <SegmentBar fmt={(v) => String(v)} parts={['todo', 'in_progress', 'blocked', 'done'].map((k, i) => ({ label: label(k), value: t.by_status[k] ?? 0, color: [SERIES[3], SERIES[1], SERIES[0], SERIES[2]][i] }))} />
          <div className="mt-4"><Rows rows={[
            { label: 'Overdue', value: t.overdue, tone: t.overdue ? 'bad' : 'good', to: '/tasks' },
            { label: 'Due in the next 7 days', value: t.due_next_7_days, to: '/tasks' },
          ]} /></div>
        </ChartCard>
      )
    },
  },
]

const DEFAULT_ORDER = [
  'sales_summary', 'sales_trend', 'sales_by_channel',
  'top_products', 'profit_summary', 'expenses_summary',
  'order_status', 'customers_summary', 'receivables',
  'stock_alerts', 'inventory_summary', 'purchasing_summary',
  'production_summary', 'production_schedule',
]

/* ---------- Small parts ---------- */

function growth(cur: unknown, prev: unknown) {
  const c = Number(cur), p = Number(prev)
  return p ? ((c - p) / Math.abs(p)) * 100 : null
}

function Figure({ label, value, tone }: { label: string; value: ReactNode; tone?: 'bad' }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[12px] text-muted">{label}</p>
      <p className={cx('mt-0.5 truncate text-[18px] font-semibold tracking-[-0.01em]', tone === 'bad' ? 'text-bad' : 'text-ink')}>{value}</p>
    </div>
  )
}

function Delta({ value, upIsGood = true }: { value: unknown; upIsGood?: boolean }) {
  if (value === null || value === undefined) return null
  const v = Number(value)
  const good = v === 0 ? null : (v > 0) === upIsGood
  return (
    <span className={cx('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11.5px] font-semibold', good === null ? 'bg-sunken text-ink-2' : good ? 'bg-good-bg text-good' : 'bg-bad-bg text-bad')}>
      {v > 0 ? <ArrowUp className="size-3" /> : v < 0 ? <ArrowDown className="size-3" /> : null}{Math.abs(v).toFixed(1)}% vs before
    </span>
  )
}

type RowItem = { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad'; to?: string }

/** Label/value rows; a status icon (never colour alone) when a tone is given. */
function Rows({ rows }: { rows: RowItem[] }) {
  return (
    <ul className="-mx-2 flex flex-col">
      {rows.map((r, i) => {
        const icon = r.tone === 'good' ? <CircleCheck className="size-4 text-good" aria-label="OK" />
          : r.tone === 'warn' ? <AlertTriangle className="size-4 text-warn" aria-label="Needs attention" />
          : r.tone === 'bad' ? <AlertTriangle className="size-4 text-bad" aria-label="Problem" /> : null
        const body = (
          <>
            {icon && <span className="shrink-0">{icon}</span>}
            <span className="flex-1 truncate text-ink-2">{r.label}</span>
            <span className="tabular font-medium text-ink">{r.value}</span>
            {r.to && <ChevronRight className="size-3.5 text-muted opacity-0 transition group-hover:opacity-100" />}
          </>
        )
        const cls = 'group flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px]'
        return <li key={i}>{r.to ? <Link to={r.to} className={cx(cls, 'hover:bg-sunken')}>{body}</Link> : <div className={cls}>{body}</div>}</li>
      })}
    </ul>
  )
}

function SalesMix({ sales }: { sales: Data }) {
  const [by, setBy] = useState<'by_channel' | 'by_city' | 'by_order_type'>('by_channel')
  const rows: any[] = sales[by] ?? []
  return (
    <ChartCard title="Sales mix" sub="Revenue this period"
      action={<Segmented value={by} onChange={setBy} options={[{ value: 'by_channel', label: 'Channel' }, { value: 'by_city', label: 'City' }, { value: 'by_order_type', label: 'Type' }]} />}>
      <BarList fmt={(v) => compactMoney(v)} limit={7}
        items={rows.map((r) => ({ label: label(String(r.label ?? r.key ?? 'Unknown')), value: r.revenue, sub: `${r.orders} orders` }))} />
    </ChartCard>
  )
}

function Schedule() {
  const { data, isLoading } = useQuery({ queryKey: ['/production/schedule', 7], queryFn: () => api.get<any[]>('/production/schedule', { days: 7 }) })
  return (
    <ChartCard title="Next 7 days in production" action={<Link to="/production/plan" className="text-[12.5px] text-wine-700 hover:underline">Plan</Link>}>
      {isLoading ? <Spinner /> : !data?.length ? (
        <p className="py-6 text-center text-[13px] text-muted">Nothing scheduled</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {data.slice(0, 6).map((r) => (
            <li key={r.id}>
              <Link to={`/production-orders/${r.id}`} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-sunken">
                <CalendarClock className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{r.product_name}</span>
                  <span className="block text-[12px] text-muted">{qty(r.planned_quantity)} · starts {date(r.planned_start)}</span>
                </span>
                <Status value={r.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  )
}

/* ---------- Customise ---------- */

function Customise({ open, onClose, layout, available }: { open: boolean; onClose: () => void; layout: string[]; available: string[] }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [order, setOrder] = useState<string[]>([])
  const [shown, setShown] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!open) return
    setOrder([...layout, ...available.filter((k) => !layout.includes(k))])
    setShown(new Set(layout))
  }, [open, layout, available])
  const title = (k: string) => WIDGETS.find((w) => w.key === k)?.title ?? label(k)
  const move = (i: number, d: number) => setOrder((o) => { const n = [...o]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n })
  const save = async () => {
    await api.put('/dashboard/layout', { widgets: order.filter((k) => shown.has(k)) })
    qc.invalidateQueries({ queryKey: ['/dashboard/layout'] })
    toast('Dashboard saved')
    onClose()
  }
  return (
    <Drawer open={open} onClose={onClose} title="Customise dashboard"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <p className="mb-4 text-[13px] text-ink-2">Choose what you see and in which order. Only areas you have access to appear on the dashboard.</p>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {order.map((k, i) => (
          <li key={k} className="flex items-center gap-2 px-3 py-2">
            <Checkbox className="flex-1" label={title(k)} checked={shown.has(k)}
              onChange={(e) => setShown((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n })} />
            <IconButton label={`Move ${title(k)} up`} disabled={i === 0} onClick={() => move(i, -1)} className="disabled:opacity-30"><ArrowUp className="size-4" /></IconButton>
            <IconButton label={`Move ${title(k)} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)} className="disabled:opacity-30"><ArrowDown className="size-4" /></IconButton>
          </li>
        ))}
      </ul>
    </Drawer>
  )
}

/* ---------- Page ---------- */

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export default function Dashboard() {
  const { user } = useAuth()
  const [range, setRange] = useUrlState('range', 'month')
  const [from, setFrom] = useUrlState('from')
  const [to, setTo] = useUrlState('to')
  const [customising, setCustomising] = useState(false)
  const custom = range === 'custom'
  const params = { range, ...(custom ? { date_from: from, date_to: to } : {}) }

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: ['/dashboard', params],
    queryFn: () => api.get<Data>('/dashboard', params),
    enabled: !custom || (!!from && !!to),
    placeholderData: (prev) => prev,
  })
  const layout = useQuery({ queryKey: ['/dashboard/layout'], queryFn: () => api.get<{ widgets: string[]; available: string[] }>('/dashboard/layout') })

  const available = layout.data?.available ?? []
  const saved = layout.data?.widgets ?? available
  // Until someone customises, use an order that pairs cards of similar height.
  const chosen = saved.join() === available.join() ? DEFAULT_ORDER.filter((k) => available.includes(k)) : saved
  // widgets outside the saved-layout catalogue (marketing, tasks) always show when the user has access
  const keys = [...chosen, ...WIDGETS.map((w) => w.key).filter((k) => !available.includes(k))]
  const ctx: Ctx = { range, from: data?.period?.from ?? '', to: data?.period?.to ?? '' }
  const widgets = data ? keys.map((k) => WIDGETS.find((w) => w.key === k)).filter((w): w is Widget => !!w && w.needs.every((n) => data[n] !== undefined)) : []

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[28px] leading-tight text-wine-800">{greeting()}, {user.name.split(' ')[0]}</h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            {data?.period ? <>{date(data.period.from)} – {date(data.period.to)}<span className="text-muted"> · compared with {date(data.period.previous_from)} – {date(data.period.previous_to)}</span></> : 'Loading…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isFetching && !isLoading && <Spinner className="size-4" />}
          {custom && (
            <div className="flex items-center gap-1.5">
              <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px]" />
              <span className="text-muted">–</span>
              <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px]" />
            </div>
          )}
          <Segmented value={range as Range} onChange={(v) => setRange(v)} options={RANGES} />
          {available.length > 0 && <IconButton label="Customise dashboard" onClick={() => setCustomising(true)}><SlidersHorizontal className="size-4" /></IconButton>}
        </div>
      </div>

      {error ? <ErrorNote error={error} /> : isLoading || (!data && !custom) ? (
        <div className="flex h-64 items-center justify-center"><Spinner /></div>
      ) : !data ? (
        <p className="py-16 text-center text-[13.5px] text-ink-2">Pick a start and end date.</p>
      ) : widgets.length === 0 ? (
        <p className="py-16 text-center text-[13.5px] text-ink-2">Nothing to show yet. Your dashboard fills in as you get access to sales, stock, production or finance.</p>
      ) : (
        <div className="grid grid-flow-row-dense grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {widgets.map((w) => (
            <div key={w.key} className={cx('anim-rise min-w-0 [&>section]:h-full',w.span === 3 && 'md:col-span-2 xl:col-span-3', w.span === 2 && 'md:col-span-2')}>
              {w.render(data, ctx)}
            </div>
          ))}
        </div>
      )}

      <Customise open={customising} onClose={() => setCustomising(false)} layout={chosen} available={available} />
    </>
  )
}

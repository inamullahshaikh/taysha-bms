import { useQuery } from '@tanstack/react-query'
import { CheckCheck, ClipboardList, Package, ShoppingBag, Store, Truck, Users, Wallet, type LucideIcon } from 'lucide-react'
import { lazy } from 'react'
import { Link } from 'react-router-dom'
import { allowed, type Access } from '../../app/section'
import { api, asPage } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { label, money } from '../../lib/format'
import { useAction } from '../../lib/hooks'
import { useSimple } from '../../lib/simple'
import { Button, Spinner, Status } from '../../ui/kit'

const Dashboard = lazy(() => import('../dashboard/Dashboard'))

const TILES: { to: string; label: string; icon: LucideIcon; access: Access; main?: boolean }[] = [
  { to: '/quick/order', label: 'New order', icon: ShoppingBag, access: 'orders.create', main: true },
  { to: '/quick/expense', label: 'Add expense', icon: Wallet, access: 'expenses.create', main: true },
  { to: '/pos', label: 'Sell at a stall', icon: Store, access: 'pos' },
  { to: '/stock', label: 'Check stock', icon: Package, access: 'inventory' },
  { to: '/orders', label: 'All orders', icon: ClipboardList, access: 'orders' },
  { to: '/customers', label: 'Customers', icon: Users, access: 'customers' },
]

/** "/" shows big buttons in simple mode and the full dashboard otherwise. */
export default function Home() {
  return useSimple() ? <SimpleHome /> : <Dashboard />
}

function SimpleHome() {
  const { user, can } = useAuth()
  const today = useQuery({
    queryKey: ['/dashboard', { range: 'today' }],
    queryFn: () => api.get('/dashboard', { range: 'today' }),
    enabled: can('orders'),
  })
  const waiting = useQuery({
    queryKey: ['/expenses', 'pending-count'],
    queryFn: () => api.get('/expenses', { status: 'submitted', page_size: 1 }),
    enabled: can('expenses', 'approve'),
  })
  const s = today.data?.sales
  const pending = asPage(waiting.data).total

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 font-display text-[28px] text-wine-800">Hi {user.name.split(' ')[0]}</h1>
      <p className="mb-5 text-[14px] text-ink-2">What would you like to do?</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {TILES.filter((t) => allowed(can, t.access)).map((t) => (
          <Link key={t.to} to={t.to}
            className={t.main
              ? 'flex min-h-32 flex-col justify-between rounded-2xl bg-wine-800 p-4 text-cream shadow-card transition hover:bg-wine-700 active:scale-[0.98]'
              : 'flex min-h-32 flex-col justify-between rounded-2xl bg-surface p-4 shadow-card transition hover:ring-2 hover:ring-wine-200 active:scale-[0.98]'}>
            <t.icon className={t.main ? 'size-8' : 'size-8 text-wine-700'} strokeWidth={1.6} />
            <span className="text-[17px] font-semibold">{t.label}</span>
          </Link>
        ))}
      </div>

      {(s || pending > 0) && (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {s && <Figure label="Sold today" value={money(s.revenue)} />}
          {s && <Figure label="Orders today" value={String(s.order_count)} />}
          {pending > 0 && <Link to="/approvals"><Figure label="Expenses to approve" value={String(pending)} warn /></Link>}
        </div>
      )}

      {can('orders') && <OpenOrders />}
    </div>
  )
}

function Figure({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={warn ? 'rounded-2xl bg-warn-bg p-4' : 'rounded-2xl bg-surface p-4 shadow-card'}>
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="tabular mt-1 text-[22px] font-semibold">{value}</p>
    </div>
  )
}

/** Orders still to deliver or collect money for, each with one-tap buttons. */
function OpenOrders() {
  const { can } = useAuth()
  const { data, isLoading } = useQuery({
    queryKey: ['/orders', 'open-home'],
    queryFn: () => api.get('/orders', { to_finish: true, page_size: 30 }),
  })
  const refresh = [['/orders'], ['/dashboard']]
  const deliver = useAction((o: any) => api.post(`/orders/${o.id}/status`, { status: 'delivered' }), { success: 'Marked as delivered', invalidate: refresh })
  const paid = useAction((o: any) => api.post(`/orders/${o.id}/payments`, { method: o.payment_method ?? 'cash', amount: o.balance_due }), { success: 'Payment saved', invalidate: refresh })
  const orders = asPage<any>(data).items

  return (
    <section className="mt-7">
      <h2 className="mb-3 flex items-center gap-2 text-[17px] font-semibold"><Truck className="size-5 text-wine-700" />Orders to finish</h2>
      {isLoading ? <Spinner /> : !orders.length ? (
        <p className="flex items-center gap-2 rounded-2xl bg-surface p-5 text-[14px] text-ink-2 shadow-card"><CheckCheck className="size-5 text-good" />All orders are done.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {orders.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-4 shadow-card">
              <Link to={`/orders/${o.id}`} className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">{o.customer_name ?? 'Walk-in'}</p>
                <p className="text-[13px] text-ink-2">{o.number} · {money(o.grand_total)} · <Status value={o.status} /></p>
              </Link>
              <div className="flex gap-2">
                {['confirmed', 'dispatched'].includes(o.status) && can('orders', 'edit') && (
                  <Button className="h-11" loading={deliver.isPending && deliver.variables?.id === o.id} onClick={() => deliver.mutate(o)}>Delivered</Button>
                )}
                {Number(o.balance_due) > 0 && can('order_payments', 'create') && (
                  <Button variant="primary" className="h-11" loading={paid.isPending && paid.variables?.id === o.id} onClick={() => paid.mutate(o)}>
                    Got {money(o.balance_due)}{o.payment_method && o.payment_method !== 'cod' ? ` by ${label(o.payment_method).toLowerCase()}` : ''}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

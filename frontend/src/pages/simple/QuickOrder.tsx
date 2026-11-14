import { useQuery } from '@tanstack/react-query'
import { Minus, Search, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, asPage } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { money } from '../../lib/format'
import { CUSTOMERS, RecordSelect } from '../../ui/Form'
import { Button, ErrorNote, Input, PageHeader, Spinner, cx } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { useChannels } from '../sales/common'
import { CUSTOMER_FIELDS } from '../sales/Customers'
import { Done, Pick, SaveBar, Step } from './parts'

const PAY = [
  { value: 'cod', label: 'Cash on delivery' }, { value: 'cash', label: 'Cash now' },
  { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'online', label: 'Online / wallet' },
]
// ponytail: fixed delivery fees; move to company settings if they change often
const FEES = ['0', '150', '200', '250', '300']

/** Order by tapping: who, what, how it gets there, how they pay. Totals come from the server. */
export default function QuickOrder() {
  const can = useCan()
  // Shopify and stall orders arrive on their own, so they aren't offered here
  const channels = useChannels().options.filter((c) => c.value !== 'shopify' && c.value !== 'pos')
  const [customer, setCustomer] = useState<{ id: number; name: string; phone?: string } | null>(null)
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState(false)
  const [channel, setChannel] = useState('')
  const [cart, setCart] = useState<Record<number, number>>({})
  const [delivery, setDelivery] = useState<'delivery' | 'pickup'>('delivery')
  // address picked by hand, remembered per customer; otherwise their default
  const [addrPick, setAddrPick] = useState<{ c?: number; v: number | 'new' }>()
  const [line1, setLine1] = useState('')
  const [city, setCity] = useState('')
  const [fee, setFee] = useState('0')
  const [pay, setPay] = useState('cod')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<any>(null)

  // regulars first: customers from the latest orders
  const recent = useQuery({
    queryKey: ['/orders', 'recent-customers'],
    queryFn: async () => {
      const seen = new Map<number, { id: number; name: string; phone?: string }>()
      for (const o of asPage<any>(await api.get('/orders', { page_size: 60 })).items)
        if (o.customer_id && !seen.has(o.customer_id)) seen.set(o.customer_id, { id: o.customer_id, name: o.customer_name, phone: o.customer_phone })
      return [...seen.values()].slice(0, 11)
    },
  })
  const products = useQuery({
    queryKey: ['/products', 'quick-order'],
    queryFn: async () => asPage<any>(await api.get('/products', { status: 'active', type: 'finished', page_size: 200, sort: 'name' })).items,
    staleTime: 10 * 60_000,
  })
  const addresses = useQuery({
    queryKey: [`/customers/${customer?.id}/addresses`],
    queryFn: () => api.get<any[]>(`/customers/${customer!.id}/addresses`),
    enabled: !!customer,
  })
  const fallback = addresses.data?.find((a) => a.is_default_shipping) ?? addresses.data?.[0]
  const address: number | 'new' = addrPick && addrPick.c === customer?.id ? addrPick.v : (fallback?.id ?? 'new')
  const setAddress = (v: number | 'new') => setAddrPick({ c: customer?.id, v })

  const lines = Object.entries(cart).filter(([, n]) => n > 0).map(([id, n]) => ({ product_id: Number(id), quantity: String(n) }))
  const body: Record<string, any> = {
    customer_id: customer?.id, channel: channel || undefined, order_type: 'retail', payment_method: pay,
    delivery_method: delivery, lines,
    ...(delivery === 'delivery' && {
      delivery_charge: fee,
      ...(typeof address === 'number' ? { shipping_address_id: address }
        : line1 && city ? { shipping_address: { line1, city } } : {}),
    }),
  }
  const [debounced, setDebounced] = useState(body)
  const key = JSON.stringify(body)
  useEffect(() => { const t = setTimeout(() => setDebounced(JSON.parse(key)), 300); return () => clearTimeout(t) }, [key])
  const preview = useQuery({
    queryKey: ['/orders/preview', 'quick', debounced],
    queryFn: () => api.post('/orders/preview', debounced),
    enabled: debounced.lines.length > 0,
    placeholderData: (p) => p,
    retry: false,
  })
  const total = lines.length && preview.data ? preview.data.grand_total : null
  const add = (id: number, d = 1) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + d) }))

  const reset = () => {
    setCustomer(null); setChannel(''); setCart({}); setDelivery('delivery'); setAddrPick(undefined)
    setLine1(''); setCity(''); setFee('0'); setPay('cod'); setError(null); setDone(null)
    window.scrollTo(0, 0)
  }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      setDone(await api.post('/orders', { ...body, confirm: true }))
      window.scrollTo(0, 0)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (done) return (
    <Done title={`Order ${done.number} saved`} actions={[
      { label: 'Add another order', onClick: reset, primary: true },
      { label: 'See this order', to: `/orders/${done.id}` },
      { label: 'Back to home', to: '/' },
    ]}>{customer?.name ?? 'Walk-in customer'} · {money(done.grand_total)}</Done>
  )

  const people = recent.data ?? []
  const pickedTile = customer && !people.some((p) => p.id === customer.id) ? [customer] : []

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New order" subtitle="Tap the answers. You only type for a new customer or a new address." />
      <div className="flex flex-col gap-4">
        <Step n={1} title="Who is it for?">
          {recent.isLoading ? <Spinner /> : (
            <Pick value={customer?.id ?? 0} onChange={(id) => setCustomer(id ? [...pickedTile, ...people].find((p) => p.id === id)! : null)}
              options={[{ value: 0, label: 'Walk-in', sub: 'No name needed' }, ...[...pickedTile, ...people].map((p) => ({ value: p.id, label: p.name, sub: p.phone }))]} />
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button className="h-11" icon={<Search className="size-4" />} onClick={() => setSearching((s) => !s)}>Someone else</Button>
            {can('customers', 'create') && <Button className="h-11" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>New customer</Button>}
          </div>
          {searching && (
            <div className="mt-3">
              <RecordSelect source={CUSTOMERS} value="" placeholder="Type a name or phone" autoFocus
                onChange={(v, row) => { if (v && row) { setCustomer({ id: row.id, name: row.name, phone: row.phone }); setSearching(false) } }} />
            </div>
          )}
        </Step>

        {channels.length > 0 && (
          <Step n={2} title="Where did the order come from?">
            <Pick value={channel} onChange={(v) => setChannel(v === channel ? '' : v)} options={channels} />
          </Step>
        )}

        <Step n={channels.length ? 3 : 2} title="What do they want?">
          {products.isLoading && <Spinner />}
          {products.data?.length === 0 && <p className="text-[13.5px] text-muted">No products yet. Add them under Products.</p>}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {products.data?.map((p) => {
              const n = cart[p.id] ?? 0
              return (
                <div key={p.id} className={cx('relative rounded-xl border-2 transition', n ? 'border-wine-800 bg-wine-50' : 'border-line-strong bg-surface')}>
                  <button type="button" onClick={() => add(p.id)} className="flex min-h-20 w-full flex-col justify-between p-3 text-left active:scale-[0.98]">
                    <span className="pr-8 text-[14px] leading-snug font-medium">{p.name}</span>
                    <span className="mt-1 text-[12px] text-muted">{n ? 'Tap to add one more' : 'Tap to add'}</span>
                  </button>
                  {n > 0 && <>
                    <span className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-wine-800 text-[13px] font-semibold text-cream">{n}</span>
                    <button type="button" aria-label={`One less ${p.name}`} onClick={() => add(p.id, -1)}
                      className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-lg border border-line-strong bg-surface hover:bg-sunken">
                      <Minus className="size-4" />
                    </button>
                  </>}
                </div>
              )
            })}
          </div>
        </Step>

        <Step n={channels.length ? 4 : 3} title="How does it get to them?">
          <Pick value={delivery} onChange={setDelivery}
            options={[{ value: 'delivery', label: 'We deliver' }, { value: 'pickup', label: 'They pick it up' }]} />
          {delivery === 'delivery' && <>
            {!!addresses.data?.length && (
              <div className="mt-4">
                <p className="mb-2 text-[13px] font-medium text-ink-2">Deliver to</p>
                <Pick value={address} onChange={setAddress}
                  options={[...addresses.data.map((a) => ({ value: a.id as number | 'new', label: a.line1, sub: [a.area, a.city].filter(Boolean).join(', ') })), { value: 'new', label: 'Another address' }]} />
              </div>
            )}
            {address === 'new' && !addresses.isLoading && (
              <div className="mt-4 grid gap-2.5 sm:grid-cols-[2fr_1fr]">
                <Input className="h-12 text-[15px]" placeholder="Address (house, street, area)" value={line1} onChange={(e) => setLine1(e.target.value)} />
                <Input className="h-12 text-[15px]" placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
            )}
            <p className="mt-4 mb-2 text-[13px] font-medium text-ink-2">Delivery charge</p>
            <Pick value={fee} onChange={setFee} options={FEES.map((f) => ({ value: f, label: f === '0' ? 'Free' : money(f) }))} />
          </>}
        </Step>

        <Step n={channels.length ? 5 : 4} title="How will they pay?">
          <Pick value={pay} onChange={setPay} options={PAY} />
        </Step>

        {error != null && <ErrorNote error={error} />}
      </div>

      <SaveBar>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-muted">Total</p>
          <p className="tabular text-[22px] font-semibold">
            {!lines.length ? '—' : total ? money(total) : <Spinner className="size-5" />}
          </p>
        </div>
        <Button variant="primary" className="h-14 px-8 text-[16px]" loading={busy} disabled={!lines.length || !total} onClick={save}>Save order</Button>
      </SaveBar>

      <FormDrawer open={adding} onClose={() => setAdding(false)} title="New customer" fields={CUSTOMER_FIELDS.slice(0, 2)}
        submit={async (b) => { const c = await api.post('/customers', b); setCustomer({ id: c.id, name: c.name, phone: c.phone }) }} />
    </div>
  )
}

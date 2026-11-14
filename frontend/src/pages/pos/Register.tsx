import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Minus, Plus, Printer, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, openFile } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { money } from '../../lib/format'
import { Button, ErrorNote, Input, Loading, Spinner, cx } from '../../ui/kit'
import { useToast } from '../../ui/toast'

type Product = { product_id: number; sku: string; name: string; barcode: string | null; price: string; in_stock: string | null }
const METHODS = [{ value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }, { value: 'online', label: 'Online transfer' }]
const newId = () => crypto.randomUUID()

/** Touch-first till. Prices and totals come from the server; the browser only counts items. */
export default function Register() {
  const sessionId = Number(useParams().sessionId)
  const toast = useToast()
  const can = useCan()
  const session = useQuery({
    queryKey: ['/pos/sessions', sessionId],
    queryFn: async () => (await api.get<any[]>('/pos/sessions')).find((s) => s.id === sessionId) ?? null,
  })
  const eventId = session.data?.event_id
  const event = useQuery({ queryKey: [`/pos/events/${eventId}`], queryFn: () => api.get(`/pos/events/${eventId}`), enabled: !!eventId })
  const products = useQuery({ queryKey: [`/pos/events/${eventId}/products`], queryFn: () => api.get<Product[]>(`/pos/events/${eventId}/products`), enabled: !!eventId })

  const [cart, setCart] = useState<Record<number, number>>({})
  const [q, setQ] = useState('')
  const [discount, setDiscount] = useState('')
  const [paying, setPaying] = useState(false)
  const [method, setMethod] = useState('cash')
  const [tendered, setTendered] = useState('')
  const [clientId, setClientId] = useState(newId)
  const [done, setDone] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const search = useRef<HTMLInputElement>(null)

  const lines = Object.entries(cart).filter(([, n]) => n > 0).map(([id, n]) => ({ product_id: Number(id), quantity: String(n) }))
  const body = { order_type: 'stall', channel: 'pos', lines, ...(discount ? { order_discount_pct: discount } : {}) }
  const [debounced, setDebounced] = useState(body)
  const key = JSON.stringify(body)
  useEffect(() => { const t = setTimeout(() => setDebounced(JSON.parse(key)), 250); return () => clearTimeout(t) }, [key])
  const preview = useQuery({
    queryKey: ['/orders/preview', 'pos', debounced],
    queryFn: () => api.post('/orders/preview', debounced),
    enabled: debounced.lines.length > 0,
    placeholderData: (p) => p,
    retry: false,
  })
  const total = lines.length && preview.data && !preview.isPlaceholderData ? preview.data.grand_total : null

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (products.data ?? []).filter((p) => !t || p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || p.barcode === q.trim())
  }, [products.data, q])
  const add = (id: number, d = 1) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + d) }))
  const byId = (id: number) => products.data?.find((p) => p.product_id === id)

  const reset = () => { setCart({}); setDiscount(''); setPaying(false); setTendered(''); setMethod('cash'); setDone(null); setError(null); setClientId(newId()); search.current?.focus() }

  const charge = async () => {
    if (!total) return
    setBusy(true); setError(null)
    try {
      const amount = method === 'cash' && tendered ? tendered : total
      const r = await api.post('/pos/sales', { client_id: clientId, session_id: sessionId, lines, payments: [{ method, amount }], ...(discount ? { order_discount_pct: discount } : {}) })
      setDone(r)
    } catch (e) {
      setError(e)
      if (!(e instanceof ApiError)) toast('No connection. The sale was not saved; try again.', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (session.isLoading) return <Loading />
  if (!session.data) return <ErrorNote error={new Error('This till was not found.')} />
  if (session.data.status !== 'open') return <ErrorNote error={new Error('This till is closed. Open a new one from the event page.')} />

  const count = lines.reduce((s, l) => s + Number(l.quantity), 0)

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-page">
      <header className="flex h-14 shrink-0 items-center gap-3 bg-wine-800 px-4 text-cream">
        <Link to={`/pos/events/${eventId}`} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-cream/80 hover:bg-white/10 hover:text-cream">
          <ArrowLeft className="size-4" />Event
        </Link>
        <p className="truncate font-display text-[18px]">{event.data?.name ?? 'Till'}</p>
        <span className="ml-auto shrink-0 whitespace-nowrap text-[12.5px] text-cream/70">Till #{sessionId}</span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="flex min-h-0 flex-1 flex-col p-4">
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-muted" />
            <input ref={search} autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search or scan"
              placeholder="Search or scan a barcode"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const hit = products.data?.find((p) => p.barcode === q.trim() || p.sku.toLowerCase() === q.trim().toLowerCase()) ?? (shown.length === 1 ? shown[0] : undefined)
                if (hit) { add(hit.product_id); setQ('') }
              }}
              className="h-12 w-full rounded-xl border border-line-strong bg-surface pr-4 pl-11 text-[15px] focus:border-wine-600 focus:ring-3 focus:ring-wine-100 focus:outline-none" />
          </div>
          <div className="scroll-quiet grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
            {products.isLoading && <Spinner />}
            {shown.map((p) => (
              <button key={p.product_id} type="button" onClick={() => add(p.product_id)}
                className={cx('relative flex min-h-28 flex-col justify-between rounded-xl bg-surface p-3.5 text-left shadow-card transition active:scale-[0.98]',
                  cart[p.product_id] ? 'ring-2 ring-wine-600' : 'hover:ring-1 hover:ring-wine-200')}>
                <span className="text-[14px] leading-snug font-medium text-ink">{p.name}</span>
                <span className="mt-2 flex items-end justify-between">
                  <span className="tabular text-[15px] font-semibold text-wine-800">{money(p.price)}</span>
                  {p.in_stock != null && <span className="text-[11.5px] text-muted">{Number(p.in_stock)} left</span>}
                </span>
                {!!cart[p.product_id] && <span className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-wine-800 text-[12px] font-semibold text-cream">{cart[p.product_id]}</span>}
              </button>
            ))}
          </div>
        </section>

        <aside className="flex max-h-[55dvh] shrink-0 flex-col border-t border-line bg-surface lg:max-h-none lg:w-[400px] lg:border-t-0 lg:border-l">
          {done ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-[13px] text-ink-2">Sale {done.number}{done.duplicate ? ' (already saved)' : ''}</p>
              <p className="text-[34px] font-semibold">{money(done.grand_total)}</p>
              {Number(done.change) > 0 && <p className="rounded-lg bg-good-bg px-4 py-2 text-[18px] font-semibold text-good">Change {money(done.change)}</p>}
              <div className="mt-6 flex w-full flex-col gap-2">
                <Button className="h-12 w-full" icon={<Printer className="size-4" />} onClick={() => openFile(`/pos/sales/${done.order_id}/receipt`)}>Print receipt</Button>
                <Button variant="primary" className="h-12 w-full text-[15px]" onClick={reset}>Next customer</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <p className="text-[14px] font-semibold">Current sale {count > 0 && <span className="font-normal text-muted">· {count} items</span>}</p>
                {count > 0 && <button type="button" className="text-[12.5px] text-ink-2 hover:text-bad" onClick={reset}>Clear</button>}
              </div>
              <ul className="scroll-quiet flex-1 divide-y divide-line overflow-y-auto">
                {!lines.length && <li className="p-6 text-center text-[13px] text-muted">Tap a product to add it.</li>}
                {lines.map((l, i) => {
                  const p = byId(l.product_id)
                  const priced = preview.data?.lines?.[i]
                  return (
                    <li key={l.product_id} className="flex items-center gap-2 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px]">{p?.name}</p>
                        <p className="tabular text-[12.5px] text-muted">{priced && priced.product_id === l.product_id ? money(priced.line_total) : '…'}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button type="button" aria-label="One less" onClick={() => add(l.product_id, -1)} className="flex size-9 items-center justify-center rounded-lg border border-line-strong hover:bg-sunken">
                          {Number(l.quantity) === 1 ? <Trash2 className="size-4 text-muted" /> : <Minus className="size-4" />}
                        </button>
                        <span className="tabular w-7 text-center text-[14px] font-medium">{l.quantity}</span>
                        <button type="button" aria-label="One more" onClick={() => add(l.product_id)} className="flex size-9 items-center justify-center rounded-lg border border-line-strong hover:bg-sunken"><Plus className="size-4" /></button>
                      </div>
                    </li>
                  )
                })}
              </ul>
              <div className="border-t border-line p-4">
                {error != null && <div className="mb-3"><ErrorNote error={error} /></div>}
                {can('order_pricing', 'edit') && lines.length > 0 && (
                  <label className="mb-3 flex items-center justify-between text-[13px] text-ink-2">Discount %
                    <Input type="number" inputMode="decimal" className="h-9 w-24 text-right" value={discount} onChange={(e) => setDiscount(e.target.value)} />
                  </label>
                )}
                {preview.data && lines.length > 0 && Number(preview.data.discount_total) > 0 && (
                  <p className="mb-1 flex justify-between text-[13px] text-ink-2"><span>Discount</span><span className="tabular">− {money(preview.data.discount_total)}</span></p>
                )}
                {paying && total ? (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-3 gap-2">
                      {METHODS.map((m) => (
                        <button key={m.value} type="button" onClick={() => setMethod(m.value)} aria-pressed={method === m.value}
                          className={cx('h-11 rounded-lg border text-[13.5px] font-medium', method === m.value ? 'border-wine-800 bg-wine-800 text-cream' : 'border-line-strong hover:bg-sunken')}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                    {method === 'cash' && (
                      <>
                        <Input type="number" inputMode="decimal" aria-label="Cash received" placeholder={`Cash received (${money(total)})`} className="h-12 text-[16px]" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                        <div className="grid grid-cols-4 gap-2">
                          {['500', '1000', '2000', '5000'].map((v) => (
                            <button key={v} type="button" onClick={() => setTendered(v)} className="h-10 rounded-lg border border-line-strong text-[13px] hover:bg-sunken">{Number(v).toLocaleString()}</button>
                          ))}
                        </div>
                      </>
                    )}
                    <div className="flex gap-2">
                      <Button className="h-12 flex-1" onClick={() => setPaying(false)}>Back</Button>
                      <Button variant="primary" className="h-12 flex-[2] text-[15px]" loading={busy} onClick={charge}>Take {money(method === 'cash' && tendered ? tendered : total)}</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="primary" className="h-14 w-full text-[16px]" disabled={!total} onClick={() => setPaying(true)}>
                    {lines.length ? (total ? `Charge ${money(total)}` : <Spinner className="size-5 text-cream" />) : 'Charge'}
                  </Button>
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

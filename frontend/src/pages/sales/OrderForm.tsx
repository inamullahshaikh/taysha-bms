import { useQuery } from '@tanstack/react-query'
import { ChevronDown, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { money, qty } from '../../lib/format'
import { CUSTOMERS, LineItems, LookupSelect, RecordSelect, cleanLines, type FormValues } from '../../ui/Form'
import { Button, Card, ErrorNote, Field, Input, Loading, Select, Spinner, Textarea } from '../../ui/kit'
import { RecordHeader } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { ORDER_TYPES, PAY_METHODS, Totals, useChannels } from './common'
import { CUSTOMER_FIELDS } from './Customers'

const ADDR = ['line1', 'line2', 'area', 'city', 'phone']
const blankLine = () => ({ product_id: '', quantity: '1', unit_price: '', discount_pct: '' })

/** Order body from form state: drop empties, numbers stay strings (the API takes decimal strings). */
function buildBody(o: FormValues, lines: FormValues[]) {
  const body: FormValues = {}
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && !k.startsWith('addr_') && k !== 'address_choice') body[k] = v
  for (const k of ['customer_id', 'price_list_id', 'warehouse_id', 'branch_id', 'loyalty_points']) if (body[k]) body[k] = Number(body[k])
  if (o.delivery_method === 'delivery') {
    if (o.address_choice && o.address_choice !== 'new') body.shipping_address_id = Number(o.address_choice)
    else if (o.addr_line1 && o.addr_city) body.shipping_address = Object.fromEntries(ADDR.map((k) => [k, o[`addr_${k}`] || null]))
  }
  body.lines = cleanLines(lines)
  return body
}

export default function OrderForm() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const can = useCan()
  const channels = useChannels()
  const editing = !!id
  const existing = useQuery({ queryKey: [`/orders/${id}`], queryFn: () => api.get(`/orders/${id}`), enabled: editing })

  const [o, setO] = useState<FormValues>({
    customer_id: sp.get('customer') ?? '', order_type: 'retail', channel: '', payment_method: 'cod', delivery_method: 'delivery',
    delivery_charge: '', discount_code: '', address_choice: '',
  })
  const [lines, setLines] = useState<FormValues[]>([blankLine()])
  const [more, setMore] = useState(false)
  const [newCustomer, setNewCustomer] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState<string>()

  // load an existing draft into the form
  useEffect(() => {
    const r = existing.data
    if (!r) return
    const a = r.shipping_address ?? {}
    setO({
      customer_id: r.customer_id ? String(r.customer_id) : '', customer_name: r.customer_name ?? '', customer_phone: r.customer_phone ?? '',
      order_type: r.order_type, channel: r.channel ?? '', payment_method: r.payment_method ?? '', delivery_method: r.delivery_method,
      delivery_charge: r.delivery_charge === '0.00' ? '' : r.delivery_charge, order_discount_pct: r.order_discount_pct === '0.00' ? '' : r.order_discount_pct,
      order_discount_amount: r.order_discount_amount === '0.00' ? '' : r.order_discount_amount, order_date: r.order_date,
      price_list_id: r.price_list_id ?? '', warehouse_id: r.warehouse_id ?? '', branch_id: r.branch_id ?? '',
      notes: r.notes ?? '', internal_notes: r.internal_notes ?? '', customer_instructions: r.customer_instructions ?? '',
      address_choice: r.shipping_address ? 'new' : '', ...Object.fromEntries(ADDR.map((k) => [`addr_${k}`, a[k] ?? ''])),
    })
    setLines((r.lines ?? []).map((l: any) => ({
      product_id: String(l.product_id), quantity: l.quantity, discount_pct: l.discount_pct === '0.00' ? '' : l.discount_pct,
      unit_price: l.price_overridden ? l.unit_price : '',
    })))
  }, [existing.data])

  const addresses = useQuery({
    queryKey: [`/customers/${o.customer_id}/addresses`],
    queryFn: () => api.get<any[]>(`/customers/${o.customer_id}/addresses`),
    enabled: !!o.customer_id,
  })
  // default to the customer's delivery address
  useEffect(() => {
    if (!addresses.data || o.address_choice) return
    const d = addresses.data.find((a) => a.is_default_shipping) ?? addresses.data[0]
    setO((s) => ({ ...s, address_choice: d ? String(d.id) : 'new' }))
  }, [addresses.data, o.address_choice])

  const set = (k: string, v: any) => setO((s) => ({ ...s, [k]: v }))
  const body = buildBody(o, lines)
  const ready = body.lines.some((l: any) => l.product_id && l.quantity)

  // debounced server preview: the only source of totals
  const [debounced, setDebounced] = useState(body)
  const bodyKey = JSON.stringify(body)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(JSON.parse(bodyKey)), 400)
    return () => clearTimeout(t)
  }, [bodyKey])
  const preview = useQuery({
    queryKey: ['/orders/preview', debounced],
    queryFn: () => api.post('/orders/preview', debounced),
    enabled: ready && debounced.lines.length > 0,
    retry: false,
    placeholderData: (p) => p,
  })

  const save = async (confirm: boolean) => {
    setBusy(confirm ? 'confirm' : 'save'); setErrors({}); setError(null)
    try {
      const r = editing ? await api.put(`/orders/${id}`, body) : await api.post('/orders', { ...body, confirm })
      if (editing && confirm) await api.post(`/orders/${id}/status`, { status: 'confirmed' })
      toast(editing ? 'Order saved' : confirm ? 'Order created and confirmed' : 'Draft saved')
      navigate(`/orders/${r.id}`, { replace: true })
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fields)
      setError(e)
    } finally {
      setBusy(undefined)
    }
  }

  if (editing && existing.isLoading) return <Loading />
  if (editing && existing.data && existing.data.status !== 'draft')
    return <ErrorNote error={new Error('Only draft orders can be changed. Move it back to draft from the order page first.')} />

  const p = preview.data
  const pricing = can('order_pricing', 'edit')
  const lineCols = [
    { name: 'product_id', label: 'Product', type: 'product' as const },
    { name: 'quantity', label: 'Qty', type: 'number' as const, width: '90px' },
    ...(pricing ? [
      { name: 'unit_price', label: 'Price override', type: 'money' as const, width: '130px', placeholder: 'List price' },
      { name: 'discount_pct', label: 'Disc. %', type: 'number' as const, width: '90px' },
    ] : []),
  ]

  return (
    <>
      <RecordHeader back={editing ? `/orders/${id}` : '/orders'} backLabel={editing ? existing.data?.number : 'Orders'}
        title={editing ? `Edit ${existing.data?.number}` : 'New order'} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {error != null && <ErrorNote error={error} />}
          <Card title="Customer">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Customer" error={errors.customer_id} className="sm:col-span-2">
                <div className="flex gap-2">
                  <div className="flex-1"><RecordSelect source={CUSTOMERS} value={o.customer_id} placeholder="Search by name or phone"
                    onChange={(v) => setO((s) => ({ ...s, customer_id: v, address_choice: '' }))} /></div>
                  {can('customers', 'create') && <Button icon={<UserPlus className="size-4" />} onClick={() => setNewCustomer(true)}>New</Button>}
                </div>
              </Field>
              {!o.customer_id && <>
                <Field label="Walk-in name" hint="For one-off customers you don't need to save"><Input value={o.customer_name ?? ''} onChange={(e) => set('customer_name', e.target.value)} /></Field>
                <Field label="Phone"><Input value={o.customer_phone ?? ''} onChange={(e) => set('customer_phone', e.target.value)} /></Field>
              </>}
              <Field label="Order type"><Select value={o.order_type} onChange={(e) => set('order_type', e.target.value)} options={ORDER_TYPES} /></Field>
              <Field label="Channel" error={errors.channel}><Select value={o.channel} onChange={(e) => set('channel', e.target.value)} options={channels.options} placeholder="—" /></Field>
            </div>
          </Card>

          <Card title="Items">
            <LineItems value={lines} onChange={setLines} columns={lineCols} newRow={blankLine} errors={errors} addLabel="Add product" />
            {!pricing && <p className="mt-2 text-[12px] text-muted">Prices come from the customer's price list.</p>}
          </Card>

          <Card title="Delivery & payment">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Delivery"><Select value={o.delivery_method} onChange={(e) => set('delivery_method', e.target.value)}
                options={[{ value: 'delivery', label: 'Deliver to customer' }, { value: 'pickup', label: 'Customer picks up' }]} /></Field>
              <Field label="Payment method"><Select value={o.payment_method} onChange={(e) => set('payment_method', e.target.value)} options={PAY_METHODS} placeholder="—" /></Field>
              {o.delivery_method === 'delivery' && <>
                {!!addresses.data?.length && (
                  <Field label="Deliver to" className="sm:col-span-2">
                    <Select value={o.address_choice} onChange={(e) => set('address_choice', e.target.value)}
                      options={[...addresses.data.map((a) => ({ value: String(a.id), label: `${a.label}: ${a.line1}, ${a.city}` })), { value: 'new', label: 'Another address…' }]} />
                  </Field>
                )}
                {(!o.customer_id || o.address_choice === 'new' || !addresses.data?.length) && <>
                  <Field label="Address" className="sm:col-span-2" error={errors['shipping_address.line1']}><Input value={o.addr_line1 ?? ''} onChange={(e) => set('addr_line1', e.target.value)} /></Field>
                  <Field label="Area"><Input value={o.addr_area ?? ''} onChange={(e) => set('addr_area', e.target.value)} /></Field>
                  <Field label="City" error={errors['shipping_address.city']}><Input value={o.addr_city ?? ''} onChange={(e) => set('addr_city', e.target.value)} /></Field>
                </>}
                <Field label="Delivery charge" hint="PKR, not taxed"><Input type="number" step="any" value={o.delivery_charge} onChange={(e) => set('delivery_charge', e.target.value)} /></Field>
              </>}
              <Field label="Discount code" error={errors.discount_code}><Input value={o.discount_code} onChange={(e) => set('discount_code', e.target.value.toUpperCase())} /></Field>
              <Field label="Instructions from the customer" className="sm:col-span-2"><Textarea className="min-h-14" value={o.customer_instructions ?? ''} onChange={(e) => set('customer_instructions', e.target.value)} /></Field>
            </div>
          </Card>

          <section className="rounded-card bg-surface shadow-card">
            <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
              className="flex w-full items-center justify-between px-4 py-3 text-[13.5px] font-semibold">
              More details <ChevronDown className={`size-4 text-muted transition ${more ? 'rotate-180' : ''}`} />
            </button>
            {more && (
              <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
                <Field label="Order date"><Input type="date" value={o.order_date ?? ''} onChange={(e) => set('order_date', e.target.value)} /></Field>
                <Field label="Price list" hint="Leave empty to use the customer's"><LookupSelect kind="price_lists" value={o.price_list_id} onChange={(v) => set('price_list_id', v)} /></Field>
                <Field label="Ship from"><LookupSelect kind="warehouses" value={o.warehouse_id} onChange={(v) => set('warehouse_id', v)} /></Field>
                <Field label="Branch"><LookupSelect kind="branches" value={o.branch_id} onChange={(v) => set('branch_id', v)} /></Field>
                {pricing && <>
                  <Field label="Order discount %"><Input type="number" step="any" value={o.order_discount_pct ?? ''} onChange={(e) => set('order_discount_pct', e.target.value)} /></Field>
                  <Field label="Order discount (PKR)"><Input type="number" step="any" value={o.order_discount_amount ?? ''} onChange={(e) => set('order_discount_amount', e.target.value)} /></Field>
                </>}
                <Field label="Redeem loyalty points"><Input type="number" value={o.loyalty_points ?? ''} onChange={(e) => set('loyalty_points', e.target.value)} /></Field>
                <Field label="Referral code"><Input value={o.referral_code ?? ''} onChange={(e) => set('referral_code', e.target.value)} /></Field>
                <Field label="Notes (printed)" className="sm:col-span-2"><Textarea className="min-h-14" value={o.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
                <Field label="Internal notes" className="sm:col-span-2"><Textarea className="min-h-14" value={o.internal_notes ?? ''} onChange={(e) => set('internal_notes', e.target.value)} /></Field>
              </div>
            )}
          </section>
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <Card title={<span className="flex items-center gap-2">Summary {preview.isFetching && <Spinner className="size-3.5" />}</span>}>
            {!ready ? <p className="text-[13px] text-muted">Add a product to see prices and totals.</p> : preview.error ? (
              <ErrorNote error={preview.error} />
            ) : !p ? <Spinner /> : (
              <>
                <ul className="mb-3 flex flex-col gap-2 border-b border-line pb-3 text-[13px]">
                  {p.lines.map((l: any, i: number) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="min-w-0"><span className="block truncate">{l.description}</span>
                        <span className="text-[12px] text-muted">{qty(l.quantity)} × {money(l.unit_price, { paisa: true })}{l.price_overridden && ' (override)'}</span></span>
                      <span className="tabular shrink-0">{money(l.line_total, { paisa: true })}</span>
                    </li>
                  ))}
                </ul>
                <Totals rows={[
                  ['Subtotal', money(p.subtotal, { paisa: true })],
                  ...(Number(p.discount_total) ? [['Discounts', `− ${money(p.discount_total, { paisa: true })}`] as [string, string]] : []),
                  ['Tax included', money(p.tax_total, { paisa: true })],
                  ...(Number(p.delivery_charge) ? [['Delivery', money(p.delivery_charge, { paisa: true })] as [string, string]] : []),
                  ...(Number(p.rounding) ? [['Rounding', money(p.rounding, { paisa: true })] as [string, string]] : []),
                  ['Total', money(p.grand_total), true],
                ]} />
                {p.price_list && <p className="mt-2 text-[12px] text-muted">Priced from the {p.price_list} list</p>}
              </>
            )}
            <div className="mt-4 flex flex-col gap-2">
              <Button variant="primary" className="w-full" loading={busy === 'confirm'} disabled={!ready || !!busy} onClick={() => save(true)}>
                {editing ? 'Save and confirm' : 'Create and confirm'}
              </Button>
              <Button className="w-full" loading={busy === 'save'} disabled={!ready || !!busy} onClick={() => save(false)}>
                {editing ? 'Save draft' : 'Save as draft'}
              </Button>
            </div>
          </Card>
        </aside>
      </div>

      <FormDrawer open={newCustomer} onClose={() => setNewCustomer(false)} title="New customer"
        fields={CUSTOMER_FIELDS.slice(0, 5)} initial={{ type: o.order_type === 'wholesale' ? 'wholesale' : 'retail' }}
        submit={async (b) => { const c = await api.post('/customers', b); setO((s) => ({ ...s, customer_id: String(c.id), address_choice: '' })) }} />
    </>
  )
}


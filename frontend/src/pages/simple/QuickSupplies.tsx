import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { api, asPage } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { money, qty } from '../../lib/format'
import { useLookupName } from '../../lib/hooks'
import type { FieldDef } from '../../ui/Form'
import { Button, ErrorNote, Input, PageHeader, Spinner } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { Done, Pick, SaveBar, Step } from './parts'

const NEW_ITEM: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Cocoa powder' },
  { name: 'unit_id', label: 'Counted in', type: 'lookup', lookup: 'units', required: true },
  { name: 'type', label: 'Kind', type: 'select', options: [{ value: 'raw', label: 'Ingredient' }, { value: 'packaging', label: 'Packaging' }] },
]

/** Supplies bought: pick the item, say how much and what it cost in total. Stock goes up at that cost. */
export default function QuickSupplies() {
  const can = useCan()
  const qc = useQueryClient()
  const unit = useLookupName('units')
  const [item, setItem] = useState<{ id: number; name: string; unit_id: number } | null>(null)
  const [amount, setAmount] = useState('')
  const [paid, setPaid] = useState('')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<string | null>(null)
  const withCost = can('product_costs', 'edit')

  // everything that isn't a finished product: ingredients, packaging, consumables
  const items = useQuery({
    queryKey: ['/stock/balances', 'supplies'],
    queryFn: async () => asPage<any>(await api.get('/stock/balances', { page_size: 500 })).items.filter((r) => r.type !== 'finished'),
  })

  const reset = () => { setItem(null); setAmount(''); setPaid(''); setError(null); setDone(null) }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await api.post('/stock/receive', { lines: [{ product_id: item!.id, quantity: amount, ...(paid && withCost ? { total_cost: paid } : {}) }] })
      qc.invalidateQueries({ queryKey: ['/stock/balances'] })
      setDone(`${qty(amount, unit(item!.unit_id))} ${item!.name}${paid ? ` for ${money(paid)}` : ''}`)
      window.scrollTo(0, 0)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (done) return (
    <Done title="Added to stock" actions={[
      { label: 'Add something else', onClick: reset, primary: true },
      { label: 'See raw materials', to: '/stock?type=raw' },
      { label: 'Back to home', to: '/' },
    ]}>{done}</Done>
  )

  const list = items.data ?? []
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Bought supplies" subtitle="Ingredients or packaging you bought. It goes into stock so batches can use it." />
      <div className="flex flex-col gap-4">
        <Step n={1} title="What did you buy?">
          {items.isLoading ? <Spinner /> : !list.length && <p className="mb-3 text-[14px] text-ink-2">No ingredients yet. Add the first one.</p>}
          <Pick value={item?.id} onChange={(id) => { const r = list.find((x) => x.product_id === id); setItem(r ? { id, name: r.name, unit_id: r.unit_id } : item) }}
            options={[
              ...(item && !list.some((r) => r.product_id === item.id) ? [{ value: item.id, label: item.name, sub: 'New' }] : []),
              ...list.map((r) => ({ value: r.product_id, label: r.name, sub: `${qty(r.on_hand, unit(r.unit_id))} in stock` })),
            ]} />
          {can('products', 'create') && <Button className="mt-3 h-11" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Something new</Button>}
        </Step>

        {item && (
          <Step n={2} title="How much?">
            <div className="flex items-center gap-3">
              <Input type="number" inputMode="decimal" min="0" className="h-14 text-[22px] font-semibold sm:max-w-60" placeholder="0"
                aria-label="Quantity" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <span className="text-[16px] text-ink-2">{unit(item.unit_id)}</span>
            </div>
          </Step>
        )}

        {item && withCost && (
          <Step n={3} title="How much did you pay in total? (optional)">
            <div className="relative sm:max-w-60">
              <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[16px] text-muted">Rs</span>
              <Input type="number" inputMode="decimal" min="0" className="h-14 pl-12 text-[22px] font-semibold" placeholder="0"
                aria-label="Total paid in rupees" value={paid} onChange={(e) => setPaid(e.target.value)} />
            </div>
            <p className="mt-2 text-[12.5px] text-muted">Used to work out what each batch costs to make.</p>
          </Step>
        )}

        {error != null && <ErrorNote error={error} />}
      </div>

      <SaveBar>
        <p className="min-w-0 flex-1 truncate text-[14px] text-ink-2">{item ? item.name : 'Pick what you bought'}</p>
        <Button variant="primary" className="h-14 px-8 text-[16px]" loading={busy} disabled={!item || !(Number(amount) > 0)} onClick={save}>Add to stock</Button>
      </SaveBar>

      <FormDrawer open={adding} onClose={() => setAdding(false)} title="Something new" fields={NEW_ITEM} initial={{ type: 'raw' }}
        submit={async (b) => {
          // ponytail: generated code; edit it on the product page if you print labels
          const p = await api.post('/products', { ...b, sku: `RM-${Date.now().toString(36).toUpperCase()}`, track_batches: false })
          setItem({ id: p.id, name: p.name, unit_id: p.unit_id })
          qc.invalidateQueries({ queryKey: ['/products'] })
        }} />
    </div>
  )
}
